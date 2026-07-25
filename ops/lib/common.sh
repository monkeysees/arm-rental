#!/usr/bin/env bash

# Shared lifecycle primitives for short-lived production operations. Callers
# define ops_cleanup before ops_begin when they have resources to unwind.

ops_require_absolute_path() {
  local name=$1
  local value=$2
  if [[ $value != /* || $value == / ]]; then
    printf '%s must be an absolute, non-root path\n' "$name" >&2
    return 64
  fi
}

ops_emit_record() {
  local identifier=$1
  local event=$2
  local result=$3
  local exit_code=$4
  local duration_ms=$5

  jq --compact-output --null-input \
    --arg event "$event" \
    --arg result "$result" \
    --argjson exitCode "$exit_code" \
    --argjson durationMs "$duration_ms" \
    '{
      event: $event,
      result: $result,
      exitCode: $exitCode,
      durationMs: $durationMs
    }' |
    systemd-cat --identifier="$identifier" --priority=info
}

ops_acquire_lock() {
  ops_require_absolute_path "RENTAL_OPS_STATE_DIR" "$RENTAL_OPS_STATE_DIR"
  ops_require_absolute_path "RENTAL_OPS_LOCK_FILE" "$RENTAL_OPS_LOCK_FILE"
  install -d -m 0700 "$RENTAL_OPS_STATE_DIR"
  exec 9>"$RENTAL_OPS_LOCK_FILE"
  flock --exclusive --timeout "$RENTAL_OPS_LOCK_WAIT_SECONDS" 9
}

ops_exit_handler() {
  local status=$?
  local cleanup_status=0
  local finished_at duration_ms result event

  trap - EXIT HUP INT TERM
  set +e
  if declare -F ops_cleanup >/dev/null; then
    ops_cleanup "$status"
    cleanup_status=$?
  fi
  if ((status == 0 && cleanup_status != 0)); then
    status=$cleanup_status
  fi
  finished_at=$(date +%s)
  duration_ms=$(((finished_at - OPS_STARTED_AT) * 1000))
  if ((status == 0)); then
    result=success
    event="${OPS_OPERATION}.completed"
  else
    result=failure
    event="${OPS_OPERATION}.failed"
  fi
  ops_emit_record "$OPS_IDENTIFIER" "$event" "$result" "$status" "$duration_ms"
  exit "$status"
}

ops_signal_handler() {
  local status=$1
  exit "$status"
}

ops_begin() {
  OPS_OPERATION=$1
  OPS_IDENTIFIER=${2:-"rental-$1"}
  OPS_STARTED_AT=$(date +%s)
  export OPS_OPERATION OPS_IDENTIFIER OPS_STARTED_AT

  trap ops_exit_handler EXIT
  trap 'ops_signal_handler 129' HUP
  trap 'ops_signal_handler 130' INT
  trap 'ops_signal_handler 143' TERM
  ops_emit_record \
    "$OPS_IDENTIFIER" "${OPS_OPERATION}.started" "started" 0 0
}

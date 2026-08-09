#!/usr/bin/env bash

# Shared lifecycle primitives for short-lived production operations. Callers
# define ops_cleanup before ops_begin when they have resources to unwind.

OPS_LOCK_BUSY_STATUS=75

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
  local step=${6:-}

  jq --compact-output --null-input \
    --arg event "$event" \
    --arg result "$result" \
    --argjson exitCode "$exit_code" \
    --argjson durationMs "$duration_ms" \
    --arg step "$step" \
    '{
      event: $event,
      result: $result,
      exitCode: $exitCode,
      durationMs: $durationMs,
      step: (if $step == "" then null else $step end)
    }' |
    systemd-cat --identifier="$identifier" --priority=info
}

ops_acquire_lock() {
  ops_require_absolute_path "RENTAL_OPS_STATE_DIR" "$RENTAL_OPS_STATE_DIR"
  ops_require_absolute_path "RENTAL_OPS_LOCK_FILE" "$RENTAL_OPS_LOCK_FILE"
  # The host reconciler owns the root:rental-deploy group assignment. Keep the
  # directory traversable by that operator group when recurring root jobs
  # ensure it exists; mode 0700 here would intermittently break rentalctl.
  install -d -m 0750 "$RENTAL_OPS_STATE_DIR"
  exec 9>"$RENTAL_OPS_LOCK_FILE"
  # A dedicated contention status lets callers defer expected overlap without
  # hiding configuration, permission, or flock execution failures.
  flock \
    --exclusive \
    --conflict-exit-code "$OPS_LOCK_BUSY_STATUS" \
    --timeout "$RENTAL_OPS_LOCK_WAIT_SECONDS" \
    9
}

ops_exit_handler() {
  local status=$?
  local cleanup_status=0
  local finished_at duration_ms result event failed_step=$OPS_STEP

  trap - EXIT HUP INT TERM
  set +e
  if declare -F ops_cleanup >/dev/null; then
    ops_cleanup "$status"
    cleanup_status=$?
  fi
  if ((status == 0 && cleanup_status != 0)); then
    status=$cleanup_status
    failed_step=cleanup
  fi
  finished_at=$(date +%s)
  duration_ms=$(((finished_at - OPS_STARTED_AT) * 1000))
  if ((status == 0 && OPS_TERMINAL_OUTCOME == 1)); then
    result=skipped
    event="${OPS_OPERATION}.skipped"
  elif ((status == 0)); then
    result=success
    event="${OPS_OPERATION}.completed"
  else
    result=failure
    event="${OPS_OPERATION}.failed"
  fi
  ops_emit_record \
    "$OPS_IDENTIFIER" "$event" "$result" "$status" "$duration_ms" "$failed_step"
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
  OPS_STEP=initializing
  OPS_TERMINAL_OUTCOME=0
  export OPS_OPERATION OPS_IDENTIFIER OPS_STARTED_AT OPS_STEP OPS_TERMINAL_OUTCOME

  trap ops_exit_handler EXIT
  trap 'ops_signal_handler 129' HUP
  trap 'ops_signal_handler 130' INT
  trap 'ops_signal_handler 143' TERM
  ops_emit_record \
    "$OPS_IDENTIFIER" "${OPS_OPERATION}.started" "started" 0 0
}

ops_set_step() {
  OPS_STEP=$1
  export OPS_STEP
}

ops_mark_skipped() {
  OPS_TERMINAL_OUTCOME=1
  export OPS_TERMINAL_OUTCOME
}

#!/usr/bin/env bash
# shellcheck shell=bash

# Host observability helpers. Callers select the production container by its
# fixed name; no untrusted journal field is used to construct a command.

OBSERVABILITY_LIB_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
JOURNALCTL_BIN="${JOURNALCTL_BIN:-journalctl}"
SYSTEMCTL_BIN="${SYSTEMCTL_BIN:-systemctl}"
DOCKER_BIN="${DOCKER_BIN:-docker}"
JQ_BIN="${JQ_BIN:-jq}"
DF_BIN="${DF_BIN:-df}"
DU_BIN="${DU_BIN:-du}"
LNAV_BIN="${LNAV_BIN:-lnav}"

RENTAL_CONTAINER_NAME="${RENTAL_CONTAINER_NAME:-rental-apartments-bot}"
RENTAL_OPS_STATE_DIR="${RENTAL_OPS_STATE_DIR:-/var/lib/rental-apartments-ops}"
RENTAL_DATA_PATH="${RENTAL_DATA_PATH:-/var/lib/docker/volumes/rental-apartments-data/_data}"
RENTAL_BACKUP_PATH="${RENTAL_BACKUP_PATH:-/mnt/rental-apartments-backups}"

readonly OBSERVABILITY_LIB_DIR RENTAL_CONTAINER_NAME

observability_die() {
  printf 'rental observability: %s\n' "$*" >&2
  return 1
}

observability_require() {
  command -v "$1" >/dev/null 2>&1 ||
    observability_die "required command is unavailable: $1"
}

query_application_journal() {
  local since="$1"
  shift
  "$JOURNALCTL_BIN" \
    --no-pager \
    --quiet \
    --output=json \
    --since "$since" \
    "CONTAINER_NAME=$RENTAL_CONTAINER_NAME" \
    "$@"
}

aggregate_application_journal() {
  local since="$1"
  local requested_seconds="${2:-0}"
  local sampled_now="${RENTAL_OBSERVABILITY_NOW_EPOCH:-$(date +%s)}"

  query_application_journal "$since" |
    "$JQ_BIN" \
      --slurp \
      --argjson now "$sampled_now" \
      --argjson requestedSeconds "$requested_seconds" \
      -f "$OBSERVABILITY_LIB_DIR/observability.jq"
}

probe_readiness_json() {
  local status="not_ready"
  if "$DOCKER_BIN" exec "$RENTAL_CONTAINER_NAME" \
    node src/health-check.js >/dev/null 2>&1; then
    status="ready"
  fi
  "$JQ_BIN" -cn --arg status "$status" '{status: $status}'
}

container_status_json() {
  local inspect
  if ! inspect="$("$DOCKER_BIN" inspect "$RENTAL_CONTAINER_NAME" 2>/dev/null)"; then
    "$JQ_BIN" -cn '{
      present: false,
      running: false,
      health: "missing",
      imageDigest: null,
      sourceRevision: null,
      startedAt: null,
      uptimeSeconds: null,
      restartCount: null
    }'
    return
  fi

  "$JQ_BIN" -c --argjson now "${RENTAL_OBSERVABILITY_NOW_EPOCH:-$(date +%s)}" '
    def rfc3339_epoch:
      if type == "string"
      then
        ([
          try (
            capture(
              "^(?<seconds>[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(?:\\.(?<fraction>[0-9]+))?Z$"
            )
            | (
                (.seconds + "Z" | fromdateiso8601)
                + (("0." + (.fraction // "0")) | tonumber)
              )
          ) catch null
        ] | first // null)
      else null
      end;
    .[0] as $container
    | (($container.State.StartedAt // "") | rfc3339_epoch) as $started
    | {
        present: true,
        running: ($container.State.Running // false),
        health: (
          $container.State.Health.Status
          // if ($container.State.Running // false) then "unknown" else "stopped" end
        ),
        imageDigest: ($container.Image // null),
        sourceRevision:
          ($container.Config.Labels["org.opencontainers.image.revision"] // null),
        startedAt: ($container.State.StartedAt // null),
        uptimeSeconds:
          (if $started == null then null else ([0, ($now - $started)] | max | floor) end),
        restartCount: ($container.RestartCount // 0)
      }
  ' <<<"$inspect"
}

filesystem_status_json() {
  local path="$1"
  local name="$2"
  local line
  if ! line="$("$DF_BIN" -Pk "$path" 2>/dev/null | tail -n 1)"; then
    "$JQ_BIN" -cn --arg name "$name" --arg path "$path" '{
      name: $name,
      path: $path,
      available: false,
      totalBytes: null,
      usedBytes: null,
      availableBytes: null,
      usedPercent: null
    }'
    return
  fi

  # POSIX df keeps the final five columns stable even when the device name is
  # long. Paths provisioned for this service contain no whitespace.
  # shellcheck disable=SC2086
  set -- $line
  "$JQ_BIN" -cn \
    --arg name "$name" \
    --arg path "$path" \
    --argjson total "$(( $2 * 1024 ))" \
    --argjson used "$(( $3 * 1024 ))" \
    --argjson available "$(( $4 * 1024 ))" \
    --arg percent "${5%%%}" \
    '{
      name: $name,
      path: $path,
      available: true,
      totalBytes: $total,
      usedBytes: $used,
      availableBytes: $available,
      usedPercent: ($percent | tonumber)
    }'
}

journal_status_json() {
  local kilobytes=0
  if [[ -d /var/log/journal ]]; then
    kilobytes="$("$DU_BIN" -sk /var/log/journal 2>/dev/null | awk '{print $1}' || true)"
  fi
  [[ "$kilobytes" =~ ^[0-9]+$ ]] || kilobytes=0
  "$JQ_BIN" -cn --argjson bytes "$((kilobytes * 1024))" '{diskBytes: $bytes}'
}

timer_failure_reason() {
  local timer="$1" last_trigger="$2" active_state="$3" last_result="$4" exit_status="$5"
  local journal="" reason=""
  local -a journal_args
  journal_args=(
    --no-pager
    --quiet
    --output=json
    --lines=100
    --unit="${timer}.service"
  )
  if [[ -n "$last_trigger" && "$last_trigger" != "n/a" ]]; then
    journal_args+=(--since "$last_trigger")
  fi
  journal="$("$JOURNALCTL_BIN" "${journal_args[@]}" 2>/dev/null || true)"

  reason="$("$JQ_BIN" -sr '
    def record:
      (.MESSAGE // "")
      | try fromjson catch null
      | select(type == "object");
    def safe_name:
      if type == "string" and test("^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$")
      then . else null end;
    def safe_code:
      if type == "string"
        and test("^([A-Z][A-Z0-9_.-]{0,63}|[0-9]{3})$")
      then . else null end;
    def percent:
      ((. * 10000 | round) / 100 | tostring) + "%";
    [
      to_entries[]
      | .key as $index
      | (.value | record) as $record
      | if $record.event == "alert.firing"
           and $record.alertName == "low_disk"
           and ($record.freeFraction | type) == "number"
           and ($record.warningThreshold | type) == "number"
           and $record.freeFraction >= 0
           and $record.freeFraction <= 1
           and $record.warningThreshold >= 0
           and $record.warningThreshold <= 1
        then {
          priority: 4,
          index: $index,
          reason: ("low disk: " + ($record.freeFraction | percent)
            + " free is below the " + ($record.warningThreshold | percent)
            + " threshold")
        }
        elif $record.event == "alert.firing"
          and (($record.alertName | safe_name) != null)
        then {
          priority: 4,
          index: $index,
          reason: ("application alert " + $record.alertName
            + (($record.code // $record.error.code // null | safe_code) as $code
              | if $code == null then "" else " (" + $code + ")" end))
        }
        elif $record.severity == "error"
          and (($record.step | safe_name) != null)
        then {
          priority: 3,
          index: $index,
          reason: ("failed during " + $record.step)
        }
        elif $record.severity == "error"
          and (($record.event | safe_name) != null)
        then {
          priority: 3,
          index: $index,
          reason: ($record.event
            + (($record.code // $record.error.code // null | safe_code) as $code
              | if $code == null then "" else " (" + $code + ")" end))
        }
        elif $record.result == "failure"
          and (($record.step | safe_name) != null)
        then {
          priority: 2,
          index: $index,
          reason: ("failed during " + $record.step)
        }
        elif $record.result == "failure"
          and (($record.event | safe_name) != null)
        then {
          priority: 1,
          index: $index,
          reason: $record.event
        }
        else empty
        end
    ]
    | sort_by([.priority, .index])
    | last.reason // empty
  ' <<<"$journal")"

  if [[ -n "$reason" ]]; then
    printf '%s\n' "$reason"
  elif [[ -n "$active_state" && "$active_state" != "active" ]]; then
    printf 'timer state is %s\n' "$active_state"
  elif [[ -n "$last_result" && "$last_result" != "success" ]]; then
    printf 'service result is %s%s\n' \
      "$last_result" "${exit_status:+ (exit $exit_status)}"
  elif [[ -n "$exit_status" && "$exit_status" != "0" ]]; then
    printf 'service exited with status %s\n' "$exit_status"
  else
    printf 'systemd reported an unhealthy scheduled job\n'
  fi
}

timer_status_json() {
  local timers=(
    rental-deploy
    rental-monitor
    rental-storage-check
    rental-backup
    rental-maintenance
    rental-restore-drill
    rental-reboot-check
  )
  local timer properties service_properties entry reason
  local output='[]'

  for timer in "${timers[@]}"; do
    properties="$("$SYSTEMCTL_BIN" show "${timer}.timer" \
      --property=ActiveState \
      --property=LastTriggerUSec \
      --property=NextElapseUSecRealtime 2>/dev/null || true)"
    service_properties="$("$SYSTEMCTL_BIN" show "${timer}.service" \
      --property=Result \
      --property=ExecMainStatus 2>/dev/null || true)"
    entry="$("$JQ_BIN" -cn \
      --arg name "$timer" \
      --arg properties "$properties" \
      --arg service "$service_properties" '
        def value($text; $key):
          ($text | split("\n")
            | map(select(startswith($key + "=")))
            | first // ""
            | split("=")[1:] | join("="))
          | if . == "" or . == "n/a" then null else . end;
        {
          name: $name,
          activeState: value($properties; "ActiveState"),
          lastSuccess: value($properties; "LastTriggerUSec"),
          nextRun: value($properties; "NextElapseUSecRealtime"),
          lastResult: value($service; "Result"),
          exitStatus:
            (value($service; "ExecMainStatus") as $status
             | if $status == null then null else ($status | tonumber? // null) end)
        }
      ')"
    if "$JQ_BIN" -e '
      (.activeState != null and .activeState != "active")
      or (.lastResult != null and .lastResult != "success")
      or (.exitStatus != null and .exitStatus != 0)
    ' <<<"$entry" >/dev/null; then
      reason="$(timer_failure_reason \
        "$timer" \
        "$("$JQ_BIN" -r '.lastSuccess // ""' <<<"$entry")" \
        "$("$JQ_BIN" -r '.activeState // ""' <<<"$entry")" \
        "$("$JQ_BIN" -r '.lastResult // ""' <<<"$entry")" \
        "$("$JQ_BIN" -r 'if .exitStatus == null then "" else .exitStatus end' <<<"$entry")")"
      entry="$("$JQ_BIN" -c --arg reason "$reason" '. + {failureReason: $reason}' <<<"$entry")"
    else
      entry="$("$JQ_BIN" -c '. + {failureReason: null}' <<<"$entry")"
    fi
    output="$("$JQ_BIN" -cn \
      --argjson current "$output" --argjson entry "$entry" '$current + [$entry]')"
  done
  printf '%s\n' "$output"
}

optional_json_file() {
  local file="$1"
  if [[ -r "$file" ]] && "$JQ_BIN" -e . "$file" >/dev/null 2>&1; then
    "$JQ_BIN" -c . "$file"
  else
    printf 'null\n'
  fi
}

write_metrics_snapshot() {
  local target="${1:-$RENTAL_OPS_STATE_DIR/metrics-latest.json}"
  local target_directory temporary_directory temporary_file
  local application container readiness data_fs backup_fs journal timers
  local backup maintenance snapshot

  target_directory="$(dirname -- "$target")"
  install -d -m 0750 "$target_directory"
  temporary_directory="$(mktemp -d "${target_directory}/.metrics.XXXXXX")"
  temporary_file="$temporary_directory/metrics.json"
  trap 'rm -rf -- "$temporary_directory"' RETURN

  application="$(aggregate_application_journal "24 hours ago")"
  container="$(container_status_json)"
  readiness="$(probe_readiness_json)"
  data_fs="$(filesystem_status_json "$RENTAL_DATA_PATH" data)"
  backup_fs="$(filesystem_status_json "$RENTAL_BACKUP_PATH" backup)"
  journal="$(journal_status_json)"
  timers="$(timer_status_json)"
  backup="$(optional_json_file "$RENTAL_OPS_STATE_DIR/backup-latest.json")"
  maintenance="$(optional_json_file "$RENTAL_OPS_STATE_DIR/maintenance-latest.json")"

  snapshot="$("$JQ_BIN" -cn \
    --argjson application "$application" \
    --argjson container "$container" \
    --argjson readiness "$readiness" \
    --argjson data "$data_fs" \
    --argjson backupFs "$backup_fs" \
    --argjson journal "$journal" \
    --argjson timers "$timers" \
    --argjson backup "$backup" \
    --argjson maintenance "$maintenance" '
      def rfc3339_epoch:
        if type == "string"
        then
          ([
            try (
              capture(
                "^(?<seconds>[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(?:\\.(?<fraction>[0-9]+))?Z$"
              )
              | (
                  (.seconds + "Z" | fromdateiso8601)
                  + (("0." + (.fraction // "0")) | tonumber)
                )
            ) catch null
          ] | first // null)
        else null
        end;
      ($container.startedAt | rfc3339_epoch) as $containerStarted
      | $application
      + {
          deployment: ($container + {readiness: $readiness.status}),
          journal: ($journal + {
            oldestApplicationRecord: $application.observations.oldestApplicationRecord
          }),
          applicationAlerts:
            ([
              $application.applicationAlerts[]?
              | (.lastObservedAt | rfc3339_epoch) as $lastObserved
              | select(
                  $containerStarted == null
                  or ($lastObserved != null and $lastObserved >= $containerStarted)
              )
            ]),
          applicationAlertTransitions:
            ([
              $application.applicationAlertTransitions[]?
              | (.observedAt | rfc3339_epoch) as $observed
              | select(
                  $containerStarted == null
                  or ($observed != null and $observed >= $containerStarted)
                )
            ]),
          filesystems: [$data, $backupFs],
          timers: $timers,
          newestValidSnapshot:
            (if $backup == null then null else {
              identifier: ($backup.snapshotId // $backup.identifier // null),
              completedAt: ($backup.completedAt // null),
              ageSeconds:
                (if ($backup.completedAt // null) == null then null
                 else ((now - ($backup.completedAt | fromdateiso8601)) | floor)
                 end)
            } end),
          maintenance:
            (if $maintenance == null then null else {
              sampledAt: ($maintenance.sampledAt // null),
              stateFiles: ($maintenance.stateFiles // []),
              browserProfileBytes: ($maintenance.browserProfile.bytes // null),
              managedStorageBytes: ($maintenance.managedStorage.bytes // null)
            } end)
        }
    ')"

  printf '%s\n' "$snapshot" >"$temporary_file"
  chmod 0640 "$temporary_file"
  mv -f -- "$temporary_file" "$target"
  rmdir -- "$temporary_directory"
  trap - RETURN
  printf '%s\n' "$snapshot"
}

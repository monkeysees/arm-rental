def journal_timestamp:
  ((.__REALTIME_TIMESTAMP // "0") | tonumber? // 0) / 1000000;

def application_record:
  . as $journal
  | (($journal.MESSAGE // "") | try fromjson catch null) as $message
  | {
      journalTimestamp: ($journal | journal_timestamp),
      journalCursor: ($journal.__CURSOR // null),
      record:
        (if ($message | type) == "object"
         then $message
         else {
           severity: (($journal.PRIORITY // "6") as $priority
             | if ($priority | tonumber? // 6) <= 3 then "error"
               elif ($priority | tonumber? // 6) == 4 then "warn"
               else "info"
               end),
           event: "unstructured.message",
           message: ($journal.MESSAGE // "")
         }
         end)
    };

def safe_group_key:
  if type == "string" and test("^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$")
  then .
  else "other"
  end;

def percentile($values; $fraction):
  ($values | map(select(type == "number")) | sort) as $sorted
  | if ($sorted | length) == 0
    then null
    else $sorted[((($sorted | length) * $fraction | ceil) - 1)]
    end;

def sum_field($records; $name):
  [$records[] | (.record[$name] // 0) | numbers] | add // 0;

def grouped_retries($records):
  [
    $records[]
    | select(.record.event == "retry.scheduled")
    | {
        component: ((.record.component // "unknown") | safe_group_key),
        operation: ((.record.operation // "unknown") | safe_group_key)
      }
  ]
  | sort_by([.component, .operation])
  | group_by([.component, .operation])
  | map({
      component: .[0].component,
      operation: .[0].operation,
      count: length
    });

def grouped_state_writes($records):
  [
    $records[]
    | select(
        .record.event == "state.write.completed"
        or .record.event == "state.write.failed"
      )
    | {
        state:
          (if (.record.stateFile | type) == "string"
              and (.record.stateFile | test("^[^/\\\\]{1,80}$"))
           then .record.stateFile
           else "other"
           end),
        failed: (.record.event == "state.write.failed"),
        bytes: ((.record.bytes | tonumber?) // 0),
        durationMs: ((.record.durationMs | tonumber?) // 0)
      }
  ]
  | sort_by(.state)
  | group_by(.state)
  | map(
      . as $writes
      | {
          state: .[0].state,
          count: length,
          failureCount: (map(select(.failed)) | length),
          bytes: (map(.bytes) | add // 0),
          durationMs: {
            p50: percentile(map(.durationMs); 0.50),
            p95: percentile(map(.durationMs); 0.95)
          }
        }
    );

def source_integrity($records):
  [$records[] | select(.record.event == "source.integrity.checked")] as $checked
  | [$records[] | select(.record.event == "source.integrity.failed")] as $failed
  | {
      checkedPages: ($checked | length),
      failures: ($failed | length),
      failuresByReason:
        ([$failed[]
          | (.record.reason // "UNKNOWN")
          | if type == "string" and test("^[A-Z][A-Z0-9_]{1,80}$")
            then . else "UNKNOWN" end]
         | sort | group_by(.)
         | map({reason: .[0], count: length})),
      lastCheckedAt:
        ([$checked[].journalTimestamp] | max // null
         | if . == null then null else todateiso8601 end),
      lastFailureAt:
        ([$failed[].journalTimestamp] | max // null
         | if . == null then null else todateiso8601 end)
    };

def aggregate($records; $seconds; $now):
  [
    $records[]
    | select(.journalTimestamp >= ($now - $seconds))
  ] as $window
  | [$window[] | select(.record.event == "crawl.succeeded")] as $successful
  | [$window[] | select(.record.event == "crawl.failed")] as $failed
  | (($successful | length) + ($failed | length)) as $total
  | {
      seconds: $seconds,
      crawl: {
        successful: ($successful | length),
        failed: ($failed | length),
        successRatio:
          (if $total == 0 then null else (($successful | length) / $total) end),
        durationMs: {
          p50: percentile([$successful[].record.durationMs | numbers]; 0.50),
          p95: percentile([$successful[].record.durationMs | numbers]; 0.95)
        },
        pages: sum_field($successful; "pages"),
        discovered: sum_field($successful; "discovered"),
        updated: sum_field($successful; "updated"),
        notified: sum_field($successful; "notified"),
        filtered: sum_field($successful; "filtered"),
        channelSent: sum_field($successful; "channelSent"),
        channelEdited: sum_field($successful; "channelEdited")
      },
      retries: grouped_retries($window),
      stateWrites: grouped_state_writes($window),
      sourceIntegrity: source_integrity($window),
      applicationStarts:
        ([$window[] | select(.record.event == "application.started")] | length)
    };

def observed_alerts($records):
  [
    $records[]
    | select(
        (.record.event == "alert.firing" or .record.event == "alert.resolved")
        and ((.record.alertName // "") | test("^[a-z][a-z0-9_]{1,63}$"))
      )
    | {
        name: .record.alertName,
        status:
          (if .record.event == "alert.firing" then "firing" else "resolved" end),
        severity: (.record.alertSeverity // .record.severity // "warning"),
        reason:
          (if ((.record.reason // "") | test("^[A-Z][A-Z0-9_]{1,80}$"))
           then .record.reason else null end),
        observedAt: .journalTimestamp
      }
  ]
  | sort_by([.name, .observedAt])
  | group_by(.name)
  | map({
      name: .[0].name,
      status: .[-1].status,
      severity: .[-1].severity,
      reason: .[-1].reason,
      firstObservedAt: (.[0].observedAt | todateiso8601),
      lastObservedAt: (.[-1].observedAt | todateiso8601)
    });

def observed_alert_transitions($records):
  [
    $records[]
    | select(
        (.record.event == "alert.firing" or .record.event == "alert.resolved")
        and ((.record.alertName // "") | test("^[a-z][a-z0-9_]{1,63}$"))
      )
    | {
        key:
          (.journalCursor
           // ((.journalTimestamp | tostring) + "|" + .record.alertName + "|"
             + .record.event)),
        name: .record.alertName,
        status:
          (if .record.event == "alert.firing" then "firing" else "resolved" end),
        severity: (.record.alertSeverity // .record.severity // "warning"),
        reason:
          (if ((.record.reason // "") | test("^[A-Z][A-Z0-9_]{1,80}$"))
           then .record.reason else null end),
        observedAt: (.journalTimestamp | todateiso8601)
      }
  ];

map(application_record) as $records
| ($now // now) as $sampledNow
| {
    schemaVersion: 1,
    generatedAt: ($sampledNow | todateiso8601),
    observations: {
      lastSuccessfulPreflight:
        ([
          $records[]
          | select(.record.event == "startup.preflight.completed")
          | .journalTimestamp
        ] | max // null | if . == null then null else todateiso8601 end),
      lastSuccessfulCrawl:
        ([
          $records[]
          | select(.record.event == "crawl.succeeded")
          | .journalTimestamp
        ] | max // null | if . == null then null else todateiso8601 end),
      lastSourceIntegrityCheck:
        ([
          $records[]
          | select(.record.event == "source.integrity.checked")
          | .journalTimestamp
        ] | max // null | if . == null then null else todateiso8601 end),
      oldestApplicationRecord:
        ([$records[].journalTimestamp] | min // null
          | if . == null then null else todateiso8601 end)
    },
    windows: {
      "10m": aggregate($records; 600; $sampledNow),
      "1h": aggregate($records; 3600; $sampledNow),
      "24h": aggregate($records; 86400; $sampledNow),
      requested:
        (if ($requestedSeconds // 0) > 0
         then aggregate($records; $requestedSeconds; $sampledNow)
         else null
         end)
    },
    applicationAlerts: observed_alerts($records),
    applicationAlertTransitions: observed_alert_transitions($records)
  }

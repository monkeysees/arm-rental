# Production observability

Production observability is local to the VPS. The application writes
newline-delimited JSON to stdout/stderr, Docker sends it to journald, and the
short-lived `rental-monitor` job calculates bounded metrics and alert
transitions. There is no external collector, metrics database, dashboard,
inbound monitoring port, or collector-address setting.

This small operating surface has a deliberate limitation: a lost or
unreachable VPS cannot preserve its journal or use the local bot to notify its
owner.

## Journal storage and retention

Provision `/var/log/journal`, then install this host-level drop-in:

```ini
# /etc/systemd/journald.conf.d/rental-apartments.conf
[Journal]
Storage=persistent
Compress=yes
MaxRetentionSec=14day
SystemMaxUse=1G
SystemKeepFree=2G
RateLimitIntervalSec=30s
RateLimitBurst=10000
```

Restart `systemd-journald` after changing it. Provisioning must reduce
`SystemMaxUse` when 1 GiB would exceed 10% of the root filesystem. Retention is
the earlier of 14 days and the size limit; `SystemKeepFree` protects capacity
needed by application state. Only journald rotates and vacuums journal files.

Compose tags records as `rental-apartments.production` and retains the
`com.rental-apartments.environment=production` label. Verify the configuration
with `journalctl --disk-usage` and:

```sh
docker inspect rental-apartments-bot --format '{{json .HostConfig.LogConfig}}'
```

The deployment account needs journal read permission, normally through
`systemd-journal`. Logs remain sensitive even though known credential forms
are redacted.

## Browse logs over SSH

`rentalctl` always selects
`CONTAINER_NAME=rental-apartments-bot`. It uses the trusted journal timestamp,
extracts JSON `MESSAGE`, and preserves malformed records under
`unstructured.message`.

The normal view emits five tab-separated fields: journal timestamp, severity,
event, message, and optional diagnostic context as compact JSON. Diagnostic
context is deliberately allowlisted and bounded to alert name/status, stable
reason codes, component/error code, operation/step, retry attempt, and duplicate
suppression count. Unknown fields, identifiers, URLs, and invalid reason values
are not projected into this operator view.

```sh
rentalctl logs --since 30m --follow
rentalctl logs --since 24h --severity error
rentalctl logs --since 24h --event crawl.failed
rentalctl logs --ui --since 24h
```

The normal stream is unbuffered. The UI form pipes journald JSON into `lnav`:

```sh
ssh production rentalctl logs --since 30m --follow
ssh -t production rentalctl logs --ui --since 24h
```

## Metrics and current status

`rental-monitor.timer` runs `ops/monitor` every five minutes. It queries at most
24 hours of application records and atomically replaces
`/var/lib/rental-apartments-ops/metrics-latest.json`. It records one
`monitor.started` and exactly one `monitor.succeeded` or `monitor.failed`
record under `SYSLOG_IDENTIFIER=rental-monitor`. When a deployment or another
serialized production operation owns the shared lock, the monitor instead
records `monitor.skipped` and exits successfully; the next timer invocation
resumes evaluation after the operation completes.

The monitor writes sanitized metrics and alert snapshots as mode `0640`, owned
by root and the `rental-deploy` group. The containing operations directory is
mode `0750` with the same ownership, allowing the unprivileged operator command
to read those snapshots without exposing root-only deployment state.

The stable snapshot covers image/revision, container health, readiness, uptime
and restarts; last preflight/crawl; 1-hour and 24-hour crawl totals, ratios,
p50/p95 duration and result counters; bounded retry and SQLite-operation
groupings with failure, busy-timeout, changed-row, database-byte, and WAL-byte
counts; journal and filesystem capacity; last/next/result state for all eight production
timers, including image cleanup and the reboot check; application alerts; the
candidate the deploy timer is currently skipping as quarantined; and the newest
backup/maintenance receipts when present. Percentiles use nearest rank. Windows
use journal timestamps, not application-supplied timestamps. Crawl IDs,
apartment IDs, URLs, Telegram identifiers, and errors are not grouping keys.
Application alert state is scoped to the current container lifecycle, so an
unresolved event retained from a replaced container cannot reopen an alert.
Source-integrity metrics add checked-page and failure totals, failures grouped
only by stable reason, and the latest checked/failure timestamps. They never
group by a listing, URL, crawl payload, or Telegram identifier.

```sh
rentalctl status
rentalctl status --json
rentalctl metrics --since 1h
rentalctl metrics --since 24h --json
rentalctl metrics --since 7d --json
rentalctl timers
```

`status` reads the atomic snapshot and performs a fresh readiness probe.
`metrics` recalculates from retained journal records. This is recalculable
history, not a time-series database; empty windows have zero counts and null
ratios and percentiles.

Primary events are `source.integrity.checked`, `source.integrity.failed`,
`crawl.succeeded`, `crawl.failed`, `retry.scheduled`,
`state.transaction.completed`, `state.transaction.failed`,
`state.checkpoint.completed`, `state.checkpoint.failed`,
`runtime.event_loop.delayed`, `maintenance.report`, `alert.firing`,
`alert.resolved`, `monitor.alert.firing`, and `monitor.alert.resolved`.

`runtime.event_loop.delayed` reports one ten-second window in which the event
loop ran more than 250ms late, with the window's `maxMs`, `p99Ms` and `meanMs`.
Only windows past the threshold are recorded, so the absence of a record is
itself the ordinary case rather than missing data.

Read it against the browser records that share its timestamps. The browser's
CDP client runs on this loop, so a response that arrives while the loop is
blocked is not read until the block ends: a long enough block reaches the
journal as `crawl.failed` with a `ProtocolError`, or as a skipped page
interaction, and names the browser rather than whatever was actually running.
A `runtime.event_loop.delayed` window covering such a record identifies this
process as the cause; a protocol timeout with no delayed window across it does
not, and points at the browser or the host instead. The storage metrics cannot
settle this on their own — `state.transaction.*` times only the transactions it
wraps, which excludes every read and everything outside the storage layer.

Successful crawl records include private and channel re-admission counts. A
re-admission means that a persisted filtered decision was reopened after a
newer source update made the apartment match; filter configuration changes by
themselves do not increment these counters or release historical listings.

## Alert evaluation and delivery

`ops/monitor` uses the shared operations lock and atomically stores state in
`/var/lib/rental-apartments-ops/alerts.json`. It sends one Telegram owner
message when an alert fires and one when it resolves; unchanged evaluations
are not resent. An alert already firing from the prior reason-less state format
receives one enriched firing message after upgrade.

Application firing and resolution edges are tracked by journal cursor in the
bounded 24-hour snapshot. If both edges occur between monitor runs, the monitor
delivers both in order exactly once after a successful state update; a failed
Telegram attempt remains retryable. This prevents a short source-integrity
failure and recovery from disappearing between five-minute evaluations.

The evaluator covers application alerts, restart loops, two consecutive
readiness failures, exhausted/missing containers, a quarantined candidate
blocking the discovery pointer, SQLite operation failures,
busy-timeout exhaustion, sustained transaction latency, filesystem/journal
capacity, and failed systemd jobs. Transaction latency is evaluated per bounded
operation name only after at least 20 observations in the one-hour window. It
fires when p95 exceeds 500 ms and, once firing, resolves only when p95 is at or
below 250 ms (or the operation no longer has the minimum sample count).
Filesystem capacity uses
the same available-bytes/total-bytes fraction as the hourly application storage
check. It fires below 20% free and resolves only after reaching 25% free, which
prevents integer `df` rounding from flapping the alert at one boundary. Messages include a safe,
bounded reason alongside the name, severity, first/last observation, host
alias, source revision, and local runbook command. Application alerts may emit
one `reason` or a `reasons` array; the monitor accepts only stable uppercase
codes, removes duplicates, retains at most eight, and joins multiple codes for
the notification and persisted alert state. For scheduled jobs, the
monitor reads at most 100 unit-journal records since the most recent trigger
and accepts only structured event names, error codes, operation steps, and
allowlisted capacity fields. It falls back to the systemd result and exit code
when no structured cause exists. Every transition is written locally as a
structured `monitor.alert.firing` or `monitor.alert.resolved` record before
Telegram delivery. Credentials come from
`/etc/rental-apartments/env`; curl receives URL and form configuration on stdin
so token and owner destination never enter argv or journal records.

| Alert name                             | Trigger                                                 |
| -------------------------------------- | ------------------------------------------------------- |
| `readiness_failure`                    | readiness remains failed                                |
| `host_readiness_failure`               | two consecutive host readiness probes fail              |
| `browser_challenge`                    | fifth crawl in a row ends still challenged              |
| `list_am_source_integrity`             | hard List.am source-integrity failure                   |
| `invalid_telegram_credentials`         | terminal Telegram authentication rejection              |
| `invalid_telegram_channel_permissions` | terminal channel permission rejection                   |
| `five_consecutive_crawl_failures`      | fifth consecutive failed crawl                          |
| `stale_exchange_rates`                 | CBA snapshot exceeds 48 hours                           |
| `backup_failure`                       | snapshot operation fails                                |
| `restore_test_failure`                 | snapshot validation or restore drill fails              |
| `low_disk`                             | free-space threshold is crossed                         |
| `state_database_growth`                | the SQLite database reaches 256 MiB                     |
| `state_wal_growth`                     | the SQLite WAL reaches 25 MiB                           |
| `process_restart_loop`                 | over three starts occur in ten minutes                  |
| `state_transaction_latency`            | transaction p95 exceeds 500 ms over at least 20 samples |
| `state_database_busy`                  | a database busy timeout is exhausted                    |
| `state_database_operation_failure`     | a non-busy transaction or checkpoint fails              |
| `deployment_blocked`                   | the deploy timer keeps skipping a quarantined candidate |
| `deployment_failure`                   | a candidate was rejected and rolled back                |
| `deployment_reconcile_exhausted`       | the restart budget for a dead service is spent          |

`deployment_blocked` exists because a rejected candidate is otherwise silent. A
failed deployment quarantines its digest, but the discovery pointer goes on
naming it, so every later poll skips it and exits successfully: the timer
result reads `success` indefinitely and the rejection itself is a host record
that never enters application alert state. The monitor therefore reads the
deploy unit's own `deployment.quarantine.skipped` records over the last three
poll intervals and reports the validated digest. Clearing the quarantine stops
the skips, and the alert resolves within the same window.

`deployment_failure` covers the rejection itself, which `deployment_blocked`
only reports once a quarantined digest is being skipped. The deploy records it
under its own unit rather than in the container journal the application alert
reader follows, and the timer result the failure leaves behind does not carry
it either: a deploy runs longer than its own timer interval, so systemd already
has the next poll queued, and that poll skips the freshly quarantined digest
and exits successfully within seconds. Sampling the timer every five minutes
therefore only ever observes success. The monitor reads the deploy unit alert
records directly over the same window, reporting the rejected digest and the
severity the deploy assigned.

`deployment_reconcile_exhausted` closes the gap that turned a parser bug into a
46-hour outage. The deploy timer compared the candidate digest to the running
one and, when they matched, emitted `deployment.noop` with `result: "success"`
without ever asking whether the container was up. Compose's
`restart: "on-failure:5"` had already given up, so `rentalctl timers` reported
`rental-deploy` green every five minutes while the bot was dead.

The noop path now reconciles. A container that is `healthy`, `running`, or
still `starting` reports noop as before; anything else is restarted and the
attempt recorded in `reconcile.json`. The budget is three attempts per hour, so
a crash-looping service is not restarted forever: once it is spent the deploy
emits this alert and exits non-zero, turning the timer red. Attempts age out of
the window rather than clearing on recovery, which is what stops a service that
dies every twenty minutes from being restarted indefinitely. Like
`deployment_failure`, it is recorded under the deploy unit, so it reaches alert
state without the application being alive to report anything.

If Telegram delivery fails, the transition remains eligible for retry and
`rental-monitor.service` fails without logging the response or credentials:

```sh
systemctl status rental-monitor.service
journalctl -u rental-monitor.service --since -30m
rentalctl status --json
```

The same bot cannot report its own invalid token, and no local evaluator can
report total host, network, journal, or account loss. These are accepted
boundaries of local-only monitoring.

## Verification

Fixture integration tests feed interleaved structured and malformed journal
records through formatting and aggregation. They verify the diagnostic-context
allowlist, scalar and array alert reasons, percentile boundaries, and
firing/deduplicated/resolved transitions without changing production.

After provisioning, verify persistent storage, run `ops/monitor`, inspect
`rentalctl status --json`, and send a sanitized synthetic alert. Confirm the
owner message contains no token, owner identifier, apartment payload, crawl
ID, or full error stack.

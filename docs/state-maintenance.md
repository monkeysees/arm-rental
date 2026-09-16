# State maintenance and retention

The production service does not automatically delete or archive any
apartment or delivery record. State growth is observable before retention is
introduced. HTTP session cookies are disposable and do not contain delivery history.

## Weekly report

The maintenance CLI acquires the same singleton lease as the service. The
systemd wrapper stops the bot before invoking it. A live bot makes the command
fail with `ERR_SINGLETON_LOCKED` before it reads state. Take a successful backup first.

The command opens the installed database, refuses a data directory that holds
none, validates the database in full, and emits one `maintenance.report`
JSON log record containing:

- combined SQLite database/WAL bytes, schema version, update offset, and
  per-domain logical counts;
- HTTP session cookie bytes, without exposing cookie content;
- total managed bytes and byte/percentage growth from the prior successful
  sample;
- filesystem free/total bytes and the configured free-space threshold.

The SQLite report keeps physical size separate from logical counts. Apartment,
private recipient/decision, channel delivery, Telegram user, and exchange-rate
counts never expose IDs or payloads.

The prior aggregate sample is stored as
`DATA_DIRECTORY/.maintenance-history.json`; it contains no apartment,
Telegram, or cookie content and is explicitly excluded from state-size
threshold inputs and managed-growth totals. The first run reports growth as
`null`.

Combined database/WAL size at or above 256 MiB emits
`alertName=state_database_growth`; WAL alone at or above 25 MiB emits
`alertName=state_wal_growth`. The two differ because they are bounded by
different things. The database retains one delivery decision per apartment per
recipient, so it grows with legitimate use and its threshold has to describe
this installation - 25 MiB was set for a smaller one and the data outgrew it,
which turned the weekly timer red for reporting the passage of time. The WAL is
truncated on every maintenance run, so its size is bounded by checkpointing
working at all; it keeps the smaller threshold because a large WAL means
something stopped rather than that history accumulated. The command exits `2` when either threshold is
active, `1` on command/validation failure, and `0` otherwise. Alert-free runs
emit resolution records. These two are the only state-size alerts: the JSON
report and its `state_file_growth` / `state_sqlite_migration` names are gone
with the backend they measured. A report's per-file `status` reads `ok`,
`warning`, or `critical`; `critical` names a database that needs an operator,
not a backend change.

Runtime `state.transaction.*` and `state.checkpoint.*` records contain only a
stable operation, rows changed, database/WAL bytes, outcome, schema version,
duration, mapped error code, and SQLite's bounded numeric extended result code
when the runtime supplies one. The log collector calculates p50/p95 per
operation and counts failed and busy transactions and native result codes.
Telemetry failures cannot fail or roll back a durable transaction.

`rental-maintenance.timer` runs every Sunday at 04:00 UTC with
`Persistent=true`. Its `ops/maintain` wrapper acquires the shared operations
lock and validates that the newest published snapshot completed in the prior
two hours. A missing, invalid, stale, or future-dated snapshot fails before the
bot is stopped. Once stopping begins, an exit trap always restarts
`rental-apartments.service` and requires the container to return healthy.

```sh
systemctl status rental-maintenance.timer
systemctl list-timers rental-maintenance.timer
journalctl -u rental-maintenance.service --since -8d
```

Threshold exit `2` remains visible as a failed unit and alerting result, but
does not skip restart/readiness cleanup. Expected output is one
`maintenance.started`, a `maintenance.report`, the firing or resolved
state-size events, and exactly one `maintenance.completed` or
`maintenance.failed` terminal record.

## HTTP session storage and former profiles

`LIST_AM_COOKIE_FILE` is a private mode-`0600` file inside `DATA_DIRECTORY`.
Maintenance reports its size but does not read or clear its contents. Missing
cookies are normal: the HTTP client creates a fresh session on the next request.
Cookies are excluded from backups and cleared during restore. Request scratch
directories named `.list-am-http-*` are also excluded from snapshots and
maintenance totals. A forced process exit can leave one behind; inspect and
remove only these known scratch directories while the service is stopped.

Chromium is no longer installed or launched. Retire only the service-owned
`DATA_DIRECTORY/chrome-profile` through the serialized operator command:

```sh
sudo /opt/rental-apartments/current/ops/browser-cleanup
sudo /opt/rental-apartments/current/ops/browser-cleanup --apply
```

The default is a reviewable dry run. Both modes temporarily stop the service
and restart it with a readiness check, because inspecting the profile takes the
same singleton lease as the application. Run during an acceptable brief outage.
The shared operations lock excludes concurrent deployment, backup, and restore.
First the command checks that the running container matches the immutable
current-image record, checks the HTTP transport and absence of browser binaries
and dependencies in that artifact, and validates the newest daily manifest-v3
snapshot through the current recovery implementation. Deploy a release carrying
this command before using it. A browser release or a legacy newest snapshot
fails closed before stopping the service; run a normal backup first if needed.

The profile report gives exact candidate paths and allocated bytes; `--apply`
reports reclaimed bytes. Missing data is a successful zero-byte no-op. The
command refuses symbolic links (including ancestors), foreign ownership,
mounted subtrees, hardlinked files and unexpected entry types. Investigate an
unsafe path; do not bypass the check. SQLite, WAL, cookies, unrelated files and
live singleton leases are preserved. No rollback image or snapshot is deleted;
restoring a retained legacy snapshot does not reinstall its browser profile.

A separate read-only backup inventory reports retained usage and per-snapshot
paths/bytes, splitting browser-bearing legacy snapshots, browser-free current
snapshots, and legacy/unknown formats. Unknown is not a claim of restorability.
Existing daily/weekly retention and protected recovery points remain intact.
Allocated bytes may differ from filesystem free-space changes due to filesystem
accounting and open file handles.

Validation uses disposable local fixtures: CLI dry-run/apply/repeat, unsafe
paths, active lease refusal, wrapper lock/artifact/snapshot checks and restart
on failure, plus manifest-v3 snapshot validation and a real SQLite restore with
retired profile data present. No production profile or backup is deleted merely
to validate this operation.

## Retention and future pruning policy

The safe unit of retention is an apartment ID plus its private and channel
delivery decisions. Removing only a delivery entry is unsafe: a retained or
rediscovered apartment could be delivered again.

No record is currently eligible for automatic removal. A future implementation
may apply these rules only after a separate reviewed schema migration:

- An old apartment payload may move to an archive only after the source has a
  reliable, persisted inactive observation and private delivery has a terminal
  `notified`, `skipped`, or `filtered` decision. If channel publishing is
  configured, it must also have a terminal `published`, `skipped_initial`, or
  `filtered` decision.
- Archived apartment payloads may eventually be removed from the hot apartment
  file, but a compact, durable tombstone keyed by target and List.am item ID
  must remain in every applicable delivery domain. Tombstones prevent a
  resurfaced listing from entering initial-delivery classification.
- Private `notified`, `skipped`, and `filtered` records may be compacted into
  such tombstones, but may not be deleted while the corresponding item ID can
  be rediscovered. Channel `filtered` and `skipped_initial` records have the
  same rule.
- A channel `published` record must retain its Telegram message ID and content
  hash while source updates can still edit that post. It can become a compact
  no-redelivery tombstone only after the apartment satisfies the inactive
  archive rule and the product explicitly gives up future edits.
- Telegram update offsets, bot activation/filter state, the current exchange
  rate snapshot and HTTP session cookies are
  not historical apartment records and are never covered by apartment
  retention.

Before any archive or prune code ships, integration tests must:

1. seed apartments with every private and channel terminal outcome;
2. archive/prune under the singleton lease, then terminate and restart the
   complete application against the resulting durable state;
3. crawl source fixtures containing both an archived old item ID and a genuinely
   new item ID;
4. prove the old ID is neither privately delivered nor channel-posted while the
   new ID is delivered exactly once;
5. interrupt after each state boundary, restart, and prove the same no-redelivery
   result;
6. restore a pre-prune backup and prove schema compatibility and delivery
   behavior.

Until those tests and a versioned schema migration exist, operators must
respond to growth alerts by preserving state and planning capacity—not by
manually deleting rows or sentinels.

## Low disk and state growth response

### Prerequisites and safe checks

Prerequisites are a named operator, current snapshot, access to filesystem
capacity and the local persistent journal, and the active immutable artifact.
Run safe checks without listing state contents or bypassing the operations
lock:

```sh
systemctl status rental-storage-check.service rental-maintenance.service
journalctl -u rental-storage-check.service -u rental-maintenance.service \
  --since -8d
df -h /var/lib/docker/volumes/rental-apartments-data/_data
du -x -h --max-depth=2 \
  /var/lib/docker/volumes/rental-apartments-data/_data | sort -h
```

For an explicit maintenance retry, use
`systemctl start rental-maintenance.service`; do not run the image command
directly. Expected healthy output is
`storage.disk_ok`, a `maintenance.report`, more than 20% free space, bounded
database/WAL growth, and no `state_database_growth`/`state_wal_growth` event.
Threshold exit `2` is an alert, not corruption; the wrapper has already
restored and tested readiness before it returns that status.

### Recovery, expected output, and escalation

For low disk, preserve the independent backup mount, rotate only externally
collected logs through their approved retention, and expand/migrate the data volume.
Run the retention-aware image cleanup dry run and service before considering
volume expansion; it removes only verified deployment images outside the
current-plus-two rollback set:

```sh
sudo /opt/rental-apartments/current/ops/image-cleanup --dry-run
sudo systemctl start rental-image-cleanup.service
sudo rentalctl status
```

Do not use a generic Docker prune command.
Do not delete the database, delivery acknowledgements, sentinels, cookies,
snapshots within retention, or unknown files. For 256 MiB
state growth, record weekly trend and plan capacity. At 512 MiB, sustained
transaction p95 above 500 ms, recurring busy failures, or repeated incomplete
checkpoints, open a capacity/performance investigation and avoid ad hoc pruning.

Expected recovery is free space safely above 20%, resolved alert events, ready
restart and one successful crawl. Restore the
verified pre-maintenance snapshot if an approved maintenance operation damages
managed state. Escalate if free space cannot remain above 20% through the next
crawl/backup, the backup destination is also constrained, growth is abrupt or
unexplained, state validation/write latency fails, managed paths are symlinks or
unexpected types, the 512 MiB threshold is reached, or the service cannot return
to ready.

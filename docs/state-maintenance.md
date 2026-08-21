# State maintenance and retention

The production service does not automatically delete or archive any
apartment or delivery record. State growth is observable before retention is
introduced, and the browser cache is bounded independently of browser identity
data.

## Weekly report

The maintenance CLI acquires the same singleton lease as the service. The
systemd wrapper stops the bot before invoking it. A live bot makes the command
fail with `ERR_SINGLETON_LOCKED` before it reads state or changes the Chrome
profile. Take a successful backup first.

The command opens the installed database, refuses a data directory that holds
none, validates the database in full, and emits one `maintenance.report`
JSON log record containing:

- combined SQLite database/WAL bytes, schema version, update offset, and
  per-domain logical counts, plus the browser verification record;
- Chrome profile bytes before and after cache cleanup, removed cache bytes, and
  the exact cache paths cleaned;
- total managed bytes and byte/percentage growth from the prior successful
  sample (the verification record is listed as state but not double-counted
  inside the profile);
- filesystem free/total bytes and the configured free-space threshold.

The SQLite report keeps physical size separate from logical counts. Apartment,
private recipient/decision, channel delivery, Telegram user, and exchange-rate
counts never expose IDs or payloads.

The prior aggregate sample is stored as
`DATA_DIRECTORY/.maintenance-history.json`; it contains no apartment,
Telegram, or browser content and is explicitly excluded from state-size
threshold inputs and managed-growth totals. The first run reports growth as
`null`.

Combined database/WAL size at or above 25 MiB emits
`alertName=state_database_growth`; WAL alone at that threshold emits
`alertName=state_wal_growth`. The command exits `2` when either threshold is
active, `1` on command/validation failure, and `0` otherwise. Alert-free runs
emit resolution records. These two are the only state-size alerts: the JSON
report and its `state_file_growth` / `state_sqlite_migration` names are gone
with the backend they measured. A report's per-file `status` reads `ok`,
`warning`, or `critical`; `critical` names a database that needs an operator,
not a backend change.

Runtime `state.transaction.*` and `state.checkpoint.*` records contain only a
stable operation, rows changed, database/WAL bytes, outcome, schema version, and
duration. The log collector calculates p50/p95 per operation and counts failed
and busy transactions. Telemetry failures cannot fail or roll back a durable
transaction.

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

## Browser cache boundary

Every Chrome launch passes `--disk-cache-size=BROWSER_CACHE_MAX_BYTES`
(64 MiB by default). Weekly maintenance additionally removes only known,
reconstructible `Cache`, `Code Cache`, `GPUCache`, Dawn, Graphite, and shader
cache directories while the service lease is held. Cache paths must be real
directories; an unexpected file or symbolic link fails closed.

The maintenance command never removes `Cookies`, `Local Storage`, `IndexedDB`,
Service Worker storage, login data, preferences, or
`.rental-apartments-verification.json`. After maintenance, the systemd
wrapper's restart and readiness check exercises the retained profile. Follow
the browser-operations runbook if readiness reports a browser challenge.

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
  rate snapshot, browser verification state, and browser identity storage are
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
collected logs through their approved retention, remove only the reconstructible
browser caches enumerated by maintenance, and expand/migrate the data volume.
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
browser identity, snapshots within retention, or unknown files. For 25 MiB
state growth, record weekly trend and plan capacity. At 50 MiB, sustained
transaction p95 above 500 ms, recurring busy failures, or repeated incomplete
checkpoints, open a capacity/performance investigation and avoid ad hoc pruning.

Expected recovery is free space safely above 20%, resolved alert events, ready
restart, browser identity retained, and one successful crawl. Restore the
verified pre-maintenance snapshot if an approved maintenance operation damages
managed state. Escalate if free space cannot remain above 20% through the next
crawl/backup, the backup destination is also constrained, growth is abrupt or
unexplained, state validation/write latency fails, cache paths are symlinks or
unexpected types, the 50 MiB threshold is reached, or the service cannot return
to ready.

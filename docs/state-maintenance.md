# State maintenance and retention

The initial production release does not automatically delete or archive any
apartment or delivery record. State growth is observable before retention is
introduced, and the browser cache is bounded independently of browser identity
data.

## Weekly report

`npm run maintenance:report` acquires the same singleton lease as the service.
Stop the bot before running it. A live bot makes the command fail with
`ERR_SINGLETON_LOCKED` before it reads state or changes the Chrome profile.
Take a successful backup first.

The command validates every present state schema and emits one
`maintenance.report` JSON log record containing:

- byte size, logical entry count, and useful count breakdowns for all five
  configured state files and the browser verification state file;
- Chrome profile bytes before and after cache cleanup, removed cache bytes, and
  the exact cache paths cleaned;
- total managed bytes and byte/percentage growth from the prior successful
  sample (the verification record is listed as state but not double-counted
  inside the profile);
- filesystem free/total bytes and the configured free-space threshold.

The prior aggregate sample is stored as
`DATA_DIRECTORY/.maintenance-history.json`; it contains no apartment,
Telegram, or browser content and is explicitly excluded from state-size
threshold inputs and managed-growth totals. The first run reports growth as
`null`.

Files at or above 25 MiB emit `alertName=state_file_growth`. Files at or above
50 MiB emit both that alert and `alertName=state_sqlite_migration`; the latter
starts the SQLite migration evaluation. The command exits `2` when either
threshold is active, `1` on command/validation failure, and `0` otherwise.
Alert-free runs emit resolution records for both alert names.

Runtime `state.write.completed` and `state.write.failed` records contain the
state basename, serialized bytes, outcome, and total `durationMs`. The log
collector must calculate a rolling p95 by state file and alert when p95 exceeds
500 ms. Telemetry failures cannot fail or roll back a durable state write.

For a Compose deployment, a weekly scheduler should run this stop-the-service
sequence from the deployed release directory:

```sh
docker compose -f compose.production.yaml stop bot
report_status=0
docker compose -f compose.production.yaml run --rm --no-deps bot npm run maintenance:report ||
  report_status=$?
docker compose -f compose.production.yaml up -d bot
exit "$report_status"
```

The wrapper must restart the bot even when the report exits nonzero (a shell
trap is recommended), forward command logs to the production collector, alert
when the scheduled run is missing, and verify `/ready` after restart. Expected
output is a `maintenance.report` event followed by firing or resolved
state-size events. Schedule it once per week after the daily backup has
completed.

## Browser cache boundary

Every Chrome launch passes `--disk-cache-size=BROWSER_CACHE_MAX_BYTES`
(64 MiB by default). Weekly maintenance additionally removes only known,
reconstructible `Cache`, `Code Cache`, `GPUCache`, Dawn, Graphite, and shader
cache directories while the service lease is held. Cache paths must be real
directories; an unexpected file or symbolic link fails closed.

The maintenance command never removes `Cookies`, `Local Storage`, `IndexedDB`,
Service Worker storage, login data, preferences, or
`.rental-apartments-verification.json`. After maintenance, the scheduler's
restart and readiness check exercises the retained profile. Run
`npm run browser:smoke` if readiness reports a browser challenge.

## Retention and future pruning policy

The safe unit of retention is an apartment ID plus its private and channel
delivery decisions. Removing only a delivery entry is unsafe: a retained or
rediscovered apartment could be delivered again.

No record is currently eligible for automatic removal. A future implementation
may apply these rules only after a separate reviewed migration:

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

Until those tests and a versioned state migration exist, operators must respond
to growth alerts by preserving state and beginning the SQLite migration—not by
manually deleting JSON entries.

## Low disk and state growth response

### Prerequisites and safe checks

Prerequisites are a named operator, current snapshot, access to filesystem
capacity and external log retention, and the active immutable artifact. Run
safe checks without listing state contents:

```sh
npm run storage:check
df -h .data
du -x -h --max-depth=2 .data | sort -h
docker compose --file compose.production.yaml stop bot
docker compose --file compose.production.yaml run --rm --no-deps bot \
  npm run maintenance:report
```

The bot must be stopped for the report. Expected healthy output is
`storage.disk_ok`, a `maintenance.report`, more than 20% free space, state files
below 25 MiB, and no `state_file_growth`/`state_sqlite_migration` firing event.
Restart in a trap or immediately after the report even when it exits `2`;
threshold exit `2` is an alert, not corruption.

### Recovery, expected output, and escalation

For low disk, preserve the independent backup mount, rotate only externally
collected logs through their approved retention, remove only the reconstructible
browser caches enumerated by maintenance, and expand/migrate the data volume.
Do not delete JSON state, delivery acknowledgements, cookies, browser identity,
snapshots within retention, or unknown files. For 25 MiB state growth, record
weekly trend and plan capacity. At 50 MiB or write p95 above 500 ms, open the
SQLite migration work and avoid ad hoc pruning.

Expected recovery is free space safely above 20%, resolved alert events, ready
restart, browser identity retained, and one successful crawl. Restore the
verified pre-maintenance snapshot if an approved maintenance operation damages
managed state. Escalate if free space cannot remain above 20% through the next
crawl/backup, the backup destination is also constrained, growth is abrupt or
unexplained, state validation/write latency fails, cache paths are symlinks or
unexpected types, the 50 MiB threshold is reached, or the service cannot return
to ready.

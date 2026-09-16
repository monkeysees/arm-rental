# Compact private delivery decisions

Run the reproducible, synthetic benchmark with the pinned runtime:

```sh
docker run --rm --network none \
  -v "$PWD:/app" -w /app node:24.18.0-bookworm-slim \
  node scripts/compact-decisions-benchmark.js > compact-decisions-results.json
```

It uses no production records or credentials and never connects to Telegram.
The production-shaped population is 577,501 decisions, 88 recipients, and 5,442
retained apartment/house payloads. The larger population multiplies each by
four. Each fixture has valid normalized prices, mixed housing kinds, exact
encounter order and source-integrity metadata. Decisions include retained
history beyond the current listing population. Every candidate starts with a
copy of the same checkpointed schema-3 database; the timing isolates private
schema-4 migration rather than charging the earlier apartment migration to one
candidate. The legacy representation is the schema-3 private table.

The candidates isolate integer millisecond timestamps, integer status codes,
`WITHOUT ROWID`, and removal of the unused recipient/status index. Each runs in
a fresh process against an on-disk WAL database with `synchronous=FULL`.
Migration timing includes table replacement and VACUUM. Peak RSS comes from the
migration worker's process high-water mark before lookup, write, or snapshot
work, so fixture construction does not inflate it. The reported growth is
relative to that worker's initial RSS, not a separately sampled heap peak.

Each run reports main-database bytes after checkpoint, WAL bytes immediately
after migration and after 100 one-row transactions, standalone SQLite backup
bytes/time, the median of 30 bounded 5,442-ID recipient lookups, and the median
of 100 durable updates. These are local warm-cache comparisons, not VPS
latency guarantees. Each database passes integrity and foreign-key checks and
retains the exact decision count. JSON captures query plans for recipient/ID
reads, filtered re-admission, and recipient cascade deletion. Validation/export
and logical-count queries intentionally scan; they do not justify an additional
status index.

## Recorded comparison: September 16, 2026

The [raw results](benchmarks/2026-09-16-compact-decisions.json) use Node 24.18.0,
SQLite 3.53.1, and the locally inspected image digest
`sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d`.
Networking was disabled. No CPU, memory, or swap limits were set; temporary
databases and snapshots lived on the container's writable filesystem. These
measurements therefore do not establish that migration fits a 512 MiB VPS.

| Representation                                     | 577,501 decisions: database MiB | Lookup median ms | 2,310,004 decisions: database MiB | Lookup median ms |
| -------------------------------------------------- | ------------------------------: | ---------------: | --------------------------------: | ---------------: |
| Original text, rowid, both indexes                 |                           68.21 |            15.52 |                            272.19 |            16.25 |
| Integer milliseconds only                          |                           58.26 |            15.67 |                            232.39 |            17.12 |
| Integer milliseconds and statuses, rowid           |                           50.33 |            14.25 |                            200.72 |            15.93 |
| Integers, WITHOUT ROWID, status index              |                           36.59 |             6.43 |                            145.26 |             7.09 |
| Original text, WITHOUT ROWID, no status index      |                           36.19 |             7.74 |                            144.50 |             8.39 |
| Selected: integers, WITHOUT ROWID, no status index |                           22.07 |             6.90 |                             88.03 |             7.09 |

Standalone backup bytes equal checkpointed database bytes in every run. The
selected representation reduces both by 67.6% at each population. Lookup
medians improve by 55.5% and 56.3%. Removing the status index materially reduces
size and write work; the small production-shaped lookup difference against the
indexed integer candidate does not demonstrate a benefit from an index the
lookup plan never uses.

| Selected migration | Migration + VACUUM seconds | Migration peak RSS MiB | WAL after migration MiB | WAL after 100 writes MiB | Durable write median ms |
| ------------------ | -------------------------: | ---------------------: | ----------------------: | -----------------------: | ----------------------: |
| Production-shaped  |                       3.09 |                 158.00 |                   22.20 |                    0.389 |                   0.864 |
| Four times larger  |                      19.83 |                 372.39 |                   88.55 |                    0.389 |                   0.851 |

Original write medians were 1.086 ms and 1.024 ms, with 2.585 MiB and 2.896 MiB
of WAL after the same write workload. The text-only WITHOUT ROWID candidate
uses much less migration RSS (58.88/61.37 MiB) and migrates faster (1.20/14.87
seconds), but leaves substantially larger long-lived databases and snapshots.
The selected conversion pays that one-time JavaScript timestamp parsing cost
to preserve exact milliseconds across the full supported date range. Reserve
memory and temporary disk space for the migration, independently of steady-state
storage savings. These are single runs per candidate, not confidence intervals.

## Migration and rollback verification

`test/sqlite-decisions-migration.test.js` covers upgrades from schemas 1, 2, and
3; fresh initialization is covered by the SQLite lifecycle suite. Tests check
all three statuses, exact `.001`/`.999` milliseconds, negative epochs, year zero,
expanded years, both JavaScript date-range endpoints, retained absent listings,
filtered re-admission, recipient cascade isolation, invalid timestamps, a late
migration-ledger failure, a child killed during row conversion, retry after
failed VACUUM, and unchanged wrong-target/newer-schema refusal.

`test/recovery.test.js` checks an actual old-format schema-2 snapshot against
its archived manifest version before staged migration, verifies the archive
hash stays unchanged, restores and upgrades it, preserves a retained skipped
decision, and refuses a forged manifest schema version. Image labels and
release metadata are checked against the current schema constant.

An additional isolated acceptance exercise on Node 24.18.0 used the original
schema-2 code at revision `4d0729075c2b68eee4e23b879bfc3257fdca6dac` to create a
pre-deploy snapshot. The candidate upgraded it and preserved `.001`, `.999`,
negative-epoch and absent-listing decisions; recipient deletion cascaded.
The original binary refused the new schema, then successfully restored and
read its old snapshot. The candidate also validated that snapshot without
changing its hash and restored it through the new migration. No live deployment,
production-volume change, source crawl, or Telegram operation was involved.

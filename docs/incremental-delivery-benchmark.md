# Incremental private and channel delivery benchmark

Issues #16 and #17 replace repeated retained-history delivery scans with durable
SQLite candidate queues and per-consumer progress. The benchmark compares
`cd8c75057e7c8dbb43d97053e0c78bf66cb813dd` with the implementation of both issues.

## Method

The shared [delivery harness](../scripts/delivery-processing-benchmark.js) uses
real crawls, parsing, SQLite repositories, private delivery, and channel
publication. List.am HTML and Telegram responses are synthetic. Runs use
`node:24.18.0-bookworm-slim`, one CPU, 512 MiB memory, and disabled networking.
Each run seeds either 5,442 or 21,768 retained listings. Private runs use 88
recipients, each with a notified decision for one quarter of listings and a
filtered decision for the remainder (478,896 and 1,915,584 decisions). Channel
runs seed all retained listings as published with correct content hashes.

After one untimed warmup, five routine crawls encounter the same 40 listings.
A source title update must produce exactly 22 private messages or one channel
edit. The channel additionally fails a second update, closes and reopens SQLite,
then retries exactly one edit. The final drained crawl must send/edit nothing.
The reopen check rebuilds repositories within the same process; the separate
retained-history harness below tests private recovery across child processes.

The tables use median routine CPU time and the maximum reported process RSS
high-water mark. CPU excludes fixture seeding and warmup; peak RSS includes
both and is not a per-phase allocation measurement. Each population has one
process run and five routine samples, so these results demonstrate the workload
change rather than a statistical confidence interval. Some independent Docker
runs overlap; CPU is the comparison metric, and wall time remains in raw data.

[Raw measurements and candidate source hashes](benchmarks/2026-09-16-incremental-delivery.json) include every phase and its assertions.

| Consumer | Retained listings | Before CPU (ms) | After CPU (ms) | CPU reduction | Before peak RSS (MiB) | After peak RSS (MiB) |
| -------- | ----------------: | --------------: | -------------: | ------------: | --------------------: | -------------------: |
| Private  |             5,442 |         3,987.4 |           68.6 |         98.3% |                 153.7 |                163.4 |
| Private  |            21,768 |        16,759.4 |           77.9 |         99.5% |                 332.2 |                329.9 |
| Channel  |             5,442 |           341.3 |           49.1 |         85.6% |                 168.8 |                160.4 |
| Channel  |            21,768 |         1,129.1 |           69.6 |         93.8% |                 347.5 |                315.0 |

The separate existing retained-history harness retains 5,442 listings, 88 users,
and 577,501 decisions, including decisions for absent listings. Its three repeated
crawls encounter the entire retained population. The first candidate pass also
reconciles upgraded retained history and must be reported separately from steady
routine operation. Peak process RSS includes this reconciliation;
the implementation is not demonstrated to reduce peak memory in this workload.
Update, returning-ID suppression, interruption/restart, initial selection,
history acceptance/decline, date ordering, and retained-absent-decision assertions
all passed in both runs.

In that full-encounter workload, baseline routine CPU was 5,682.7–6,069.7 ms.
The first candidate reconciliation cost 16,765.2 ms; the following two routine
passes cost 1,659.7 and 1,689.8 ms, about 71% below the baseline median.
The one-time cost is deliberately not included in the steady-state improvement.
Both complete raw runs are included under `retainedHistory` in the linked JSON.

Independent local acceptance also upgraded an isolated schema-4 snapshot to
schema 6 while preserving private notified/skipped/filtered/absent decisions and
channel publication fields. Pending work survived reopening, recipient deletion
cascaded, snapshot validation preserved bytes, the old binary refused schema 6,
and restoring the schema-4 snapshot recovered the old private/channel records.
No live production state or Telegram API was used.

## Reproduction

Install the lockfile dependencies using Node 24.18.0 and archive the baseline
into a disposable directory, with its `node_modules` pointing to compatible
installed dependencies. Mount both source roots read-only. For each mode
(`private`, `channel`) and population (`5442`, `21768`), run:

```bash
docker run --rm --network none --cpus 1 --memory 512m \
  -v "$PWD:/app:ro" \
  node:24.18.0-bookworm-slim \
  node --expose-gc /app/scripts/delivery-processing-benchmark.js \
  --mode private --listings 5442
```

For the baseline, also mount its archive at `/baseline` and dependencies at
`/baseline/node_modules`, add `--implementation-root /baseline`, and supply
`BASELINE_REVISION=cd8c75057e7c8dbb43d97053e0c78bf66cb813dd` to Docker. The harness
creates and removes only its own temporary SQLite directory. The unchanged
warmup is essential: schema migration/bootstrap may deliberately inspect retained
history once before routine progress becomes incremental.

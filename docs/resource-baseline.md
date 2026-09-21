# Resource baseline

This offline benchmark measures the Node application's parsing, private delivery,
and SQLite resource use. It is independent of any language migration and uses
synthetic source responses and simulated Telegram delivery. It needs neither
network access nor production credentials.

## Run

Use the Node version pinned in `.nvmrc` and install the locked dependencies with
`npm ci`. Run scenarios sequentially so they do not compete for resources:

```sh
node scripts/resource-baseline.js --scenario all > baseline-all.json
node scripts/resource-baseline.js --scenario mixed > baseline-mixed.json
```

Defaults are 500 active monitorings, 250 retained decisions per recipient,
20 fresh listings per batch, and two batches. `all` matches every recipient to
every listing; `mixed` uses four price cohorts that each match one quarter of
the listings. This is a synthetic fixture, not measured production traffic.

Use `--history 4000` to exercise two million retained decisions. For a quick
harness check, use `--users 8 --listings 8 --history 10 --rate 20000`.
`--users`, `--listings`, and `--history` control the workload. The default
`--rate 20` uses the production per-recipient delivery rate, including history
announcements. Higher rates are useful for correctness checks but do not produce
representative timing measurements. JSON goes to stdout and progress to stderr.

To measure container memory, run inside a fresh dedicated container with the
pinned Node runtime, installed dependencies, disk-backed temporary state, and
explicit CPU and memory limits. Set `BASELINE_DATA_ROOT` to a writable directory
on that disk; the runner creates and removes its own temporary directory there.
The default is the system temporary directory. No production state is needed.

## What it checks

Each phase starts a fresh Node process: seed, initial crawl, unchanged crawl,
interrupted delivery, resumed delivery, and final unchanged crawl. The runner
uses real parsing, filtering, Russian message formatting, SQLite transactions,
and the production private delivery limiter. It injects a simulated send failure
and lets outstanding work settle before closing SQLite. This checks delivery
recovery across process restarts, not abrupt termination during acknowledgement.

Assertions cover expected delivery and announcement counts, complete backlog
drainage, zero duplicate deliveries, and silence on unchanged crawls. The final
phase counts retained historical decisions directly in SQLite and verifies their
original status and timestamp without loading that history into JavaScript.

`nodeMaxRssMiB` includes worker imports and setup but excludes the coordinator.
Phase wall time excludes process startup and database opening. Cgroup peaks
include the coordinator, workers, and charged filesystem cache; values from a
shared cgroup cannot be attributed to this workload. The coordinator also keeps
synthetic delivery keys to detect duplicates, adding overhead beyond production.

This is a crawler integration benchmark. It does not measure the native HTTP
transport, live List.am, Telegram API throughput, polling, CBA refresh, public
channel publishing, backups, or VPS performance. Two finite batches do not prove
sustained throughput or whole-service deployment headroom.

## Retained-history fix

Each concurrent delivery worker previously loaded its recipient's complete
history and held copies during classification and rate-limited delivery. Memory
therefore grew with decisions for listings that were no longer present.

Reads now require explicit listing IDs and use the existing
`(recipient_id, item_id)` primary key. The crawler includes all stored listings
that still need classification; menu history offers use the stored listing
order. Decisions for absent listings remain in SQLite and become visible again
if a listing returns. There is no retention cutoff or schema migration.

The focused regression command is:

```sh
node --test --test-name-pattern='a crawl never materializes' test/sqlite-state-access.test.js
```

Additional tests cover returning notified/skipped/filtered listings,
source-update redelivery, expired-listing classification, selection gates,
large ID sets, scoped menu offers, and user deletion.

## Production-shaped retained history

`scripts/retained-history-baseline.js` supplements the historical-decision
benchmark above. Its default fixture has exactly 5,442 retained listings,
88 active recipients and 577,501 decisions, matching the September 15 count
snapshot without copying production data. Both housing categories are retained.
Four equal price cohorts produce mostly filtered decisions, with notified and
permanently skipped matches. The remaining decisions reference absent listings;
every worker verifies those original historical timestamps survive unchanged.
These distributions are deterministic modeling choices, not measured production
status proportions.

```sh
node scripts/retained-history-baseline.js > retained.json
node scripts/retained-history-baseline.js --listings 12000 --users 200 --decisions 3000000 --repeats 10 > larger.json
node --test test/retained-history-baseline.test.js
```

The decision count automatically grows to at least listings × recipients. A
small correctness fixture accepts `--listings 12 --users 4 --decisions 61`.
Seeding, repeated steady-state crawls and restart recovery use three separate
worker processes; the repeated unchanged crawls, update, return and interrupted
burst deliberately share one worker and heap. No forced garbage collection is
used. Each phase records wall and CPU time, current RSS/heap and lifetime process
peak RSS, database and live WAL bytes, completed storage transactions and their
aggregate duration, and cgroup current/peak bytes where available. Cgroup peak
is container lifetime, not an additive per-phase measurement. Coordinator CPU
and peak RSS are reported separately; its wall time includes all workers.

Assertions verify unchanged silence, source-update redelivery, suppression of a
returning previously notified listing, bounded initial selection, accepted and
declined filter history, and delivery interruption followed by restart. Per-user
ordering follows oldest-first stable source order. The interrupted and resumed
bursts must produce exactly two new listings per original recipient in total,
without duplicates, and a final crawl must find no pending delivery. Interruption
is a simulated send failure with settled workers, not a process kill between
Telegram acceptance and database acknowledgement. Selection/history exercises
the crawler and state-access boundary rather than Telegram menu callbacks.

The simulator formats Russian listing messages but sends nothing and applies no
rate-limit delay. Delivery-burst timings therefore measure local CPU/storage
costs, not production Telegram throughput; use the earlier rate-limited harness
for limiter behavior. SQL statement/read counts are not measured: storage
operations here mean completed transactions. Parsing all retained listings each
crawl is a reproducible stress workload rather than a model of actual source
pagination. Neither benchmark establishes VPS capacity or a reduction guarantee.

The dedicated four-card ordering phase mixes September 14 and 15 timestamps
within the 24-hour activity window and asserts a literal oldest-first ID
sequence across categories, independently of the same-date giant fixture.

For isolated measurements, use a new container for each repeat, a disk-backed
scratch directory and the pinned runtime image. This command mounts only the
checkout and scratch state, disables networking, and limits the entire
coordinator/worker cgroup to one CPU and 512 MiB with no additional swap:

```sh
mkdir -p /tmp/arm-retained-data
task_revision="$(git rev-parse HEAD)"
for run in 1 2 3; do
  docker run --rm --network none --cpus 1 --memory 512m --memory-swap 512m \
    -e BASELINE_DATA_ROOT=/data -e BASELINE_IMAGE=node:24.18.0-bookworm-slim \
    -e BASELINE_REVISION="$task_revision" \
    -v "$PWD:/app:ro" -v /tmp/arm-retained-data:/data -w /app \
    node:24.18.0-bookworm-slim node scripts/retained-history-baseline.js \
    > "retained-run-${run}.json" || exit "$?"
done
```

The cgroup includes worker and coordinator memory plus charged filesystem cache.
The image is the benchmark runtime, not the deployed application image. Shared
host contention can still affect timings despite the dedicated container. For
reproduction of the recorded runs, the runtime image manifest digest is
`sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d`.

### Recorded baseline: September 16, 2026

Three independent isolated runs used Node 24.18.0, the image digest above, one
CPU, 512 MiB memory with no swap, and five unchanged crawls per steady worker.
Each passed all assertions at the default population, preserving all 98,605
absent-listing decisions. Each update delivered 22 messages; interruption and
restart delivered 3 + 173 = 176 new messages, with no duplicates or pending work.

| Run | Total wall seconds | Unchanged crawl seconds (range) | Worker peak RSS MiB | Whole-container peak MiB |
| --- | ------------------ | ------------------------------- | ------------------- | ------------------------ |
| 1   | 73.26              | 5.28–5.94                       | 173.67              | 254.39                   |
| 2   | 71.60              | 5.02–5.50                       | 192.75              | 255.72                   |
| 3   | 76.10              | 5.28–6.20                       | 179.90              | 259.36                   |

This spread measures repeat variability on this host, including natural GC; it
is not a promised memory reduction or production capacity estimate. Raw results
include per-phase CPU, current container memory, database/WAL sizes, transaction
counts and time, and separate coordinator overhead:

- [Repeat 1](benchmarks/2026-09-16-retained-run-1.json)
- [Repeat 2](benchmarks/2026-09-16-retained-run-2.json)
- [Repeat 3](benchmarks/2026-09-16-retained-run-3.json)

The reports record the application base revision. The benchmark was an
uncommitted addition during measurement; its exact SHA-256 was
`ac8e3d958e91b115c23abf9b269435d0b5c935863a3c6ee785c322483fd23d25`.

### Acceptance after incremental crawls and decision compaction

An independent [integrated run](benchmarks/2026-09-16-integrated-retained.json)
at revision `56f2af2b5781d573f9437fd2b100897d3e1c799e` exercised schema 4 with
the same 5,442 listings, 88 recipients, and 577,501 decisions, using Node
24.18.0, one CPU, and 512 MiB with no swap or network access. All assertions
passed: five unchanged crawls sent nothing, a source update delivered 22
messages, interruption and restart delivered 3 + 173 messages, and no duplicate
or pending deliveries remained. All 98,605 absent-listing decisions survived.

Total wall time was 75.28 seconds; unchanged crawls took 5.62–5.96 seconds.
This all-listings-per-page workload remains dominated by parsing and consumer
history work, so it does not reproduce the bounded-encounter speedup measured
in [the incremental crawl benchmark](incremental-crawl-benchmark.md).
The [compaction benchmark](compact-decisions-benchmark.md) separately measures
upgrading populated old schemas; this run initializes schema 4 directly and
does not establish that a large migration fits the same memory limit.

The retained-history report subsequently gained explicit alphabetical status
ordering; the existing CLI regression test caught and verifies that presentation
fix. It does not change this run's delivery or retention outcomes.

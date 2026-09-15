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

Defaults are 1,000 active monitorings, 250 retained decisions per recipient,
20 fresh listings per batch, and two batches. `all` matches every recipient to
every listing; `mixed` uses four price cohorts that each match one quarter of
the listings. This is a synthetic fixture, not measured production traffic.

Use `--history 4000` to exercise four million retained decisions. For a quick
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

## Historical measurements: September 10, 2026

These results predate Chromium removal. They used Node 24.18.0 and Chromium
152.0.7977.82, one CPU quota, no swap, and isolated disk-backed state. The old
benchmark optionally fetched synthetic pages through Chromium; that mode has
been removed. These files document the original diagnosis and are not current
HTTP-runtime measurements or commands to reproduce the old browser setup.

| Workload, 1,000 active monitorings                  | Memory limit | Worker peak RSS | Result                       |
| --------------------------------------------------- | ------------ | --------------- | ---------------------------- |
| All match; 250 decisions/recipient, before fix      | 512 MiB      | 138.5 MiB       | Passed                       |
| Mixed filters; 250 decisions/recipient, before fix  | 512 MiB      | 125.9 MiB       | Passed                       |
| All match; 4,000 decisions/recipient, before fix    | 512 MiB      | Not captured    | V8 heap exhausted            |
| All match; 4,000 decisions/recipient, before fix    | 1 GiB        | 541.8 MiB       | Passed under memory pressure |
| All match; 4,000 decisions/recipient, after fix     | 512 MiB      | 113.4 MiB       | Passed                       |
| Mixed filters; 4,000 decisions/recipient, after fix | 512 MiB      | 108.8 MiB       | Passed                       |

The fixed runs retained all four million decisions and delivered 40,000
all-match or 10,000 mixed-filter messages without duplicates or pending work.
Whole-container peaks still reached 512 MiB, including charged filesystem cache.
These single runs establish removal of the heap failure, not spare capacity.

Raw evidence:

- [All-match baseline](benchmarks/2026-09-10-all-512m.json)
- [Mixed-filter baseline](benchmarks/2026-09-10-mixed-512m.json)
- [Larger history with 1 GiB](benchmarks/2026-09-10-history-4000-1g.json)
- [Pre-fix failure with 512 MiB](benchmarks/2026-09-10-history-4000-before-512m.json)
- [Fixed all-match run](benchmarks/2026-09-10-history-4000-all-scoped-512m.json)
- [Fixed mixed-filter run](benchmarks/2026-09-10-history-4000-mixed-scoped-512m.json)

## Current runtime verification: September 15, 2026

Both offline scenarios passed on the Chromium-free application with Node
24.18.0, 1,000 active monitorings, 4,000 retained decisions per recipient, and
the default delivery rate. The coordinator and workers used a 256 MiB V8
old-generation heap limit:

```sh
node --max-old-space-size=256 scripts/resource-baseline.js --history 4000 --scenario all
node --max-old-space-size=256 scripts/resource-baseline.js --history 4000 --scenario mixed
```

The [all-match run](benchmarks/2026-09-15-history-4000-all-offline.json) delivered
40,000 messages; the [mixed-filter run](benchmarks/2026-09-15-history-4000-mixed-offline.json)
delivered 10,000. Each preserved all four million historical decisions, recovered
pending deliveries after interruption, and detected zero duplicate deliveries.

These runs validate the current integration and bounded-heap completion. They
ran on a shared development host alongside tests, without a container memory
limit, so their timings and RSS are not directly comparable to the historical
512 MiB container results and do not establish production capacity.

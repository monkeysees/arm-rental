# Bounded private delivery concurrency

Issue #18 caps active private classification/send operations at eight. The
scheduler gives each recipient one message per turn; product-rate and Telegram
retry waits hold a deadline rather than an active slot. Eight allows a slow
recipient to coexist with seven peers while keeping at most eight classification
snapshots or next-message payloads active. It is the internal
`PRIVATE_DELIVERY_CONCURRENCY` constant, not an environment setting.

One small scheduling descriptor per recipient remains in JavaScript. Selected
IDs and captured work tokens live in a SQLite temporary table with a bounded
page cache and spill to the existing scratch directory. The durable work table
and delivery decisions remain the restart authority; no schema upgrade is
needed. The architecture document describes the scratch-space failure and
shutdown behavior.

## Measurements

The [harness](../scripts/private-concurrency-benchmark.js) compares starting
commit `386ac321d443dd49d60079952c8848ac8b876908` against this implementation.
Each isolated process uses Node 24.18.0, one CPU, 512 MiB, and no network. It
seeds 1,000 listings through a real crawl and SQLite repositories, then selects
100 per recipient in a second crawl. Every recipient receives a history
announcement before its listings. Synthetic Telegram operations take 5 ms,
except the first recipient's announcement takes 100 ms. The harness asserts
announcement precedence, exact per-recipient listing order, totals, and drained
active sends. This isolates concurrency rather than simulating Telegram's
product limits; deterministic bot integration tests cover those limits and 429s.

| Recipients | Peak RSS before/after (MiB) | Listings/s before/after | First listing p50 before/after (s) | First listing p95 before/after (s) | Peak active sends before/after |
| ---------: | --------------------------: | ----------------------: | ---------------------------------: | ---------------------------------: | -----------------------------: |
|         88 |               168.7 / 115.5 |               923 / 563 |                        3.36 / 4.44 |                        7.07 / 4.48 |                         66 / 8 |
|        256 |               172.3 / 122.7 |               968 / 529 |                      11.51 / 11.12 |                      23.40 / 11.31 |                         70 / 8 |

Bounding concurrency reduces peak process RSS by 31.5% and 28.8% in these runs,
and improves p95 first-listing latency by 36.6% and 51.7%. It deliberately reduces
peak throughput by 38.9% and 45.3%. At 88 recipients median first-listing latency
increases: completing the initial classification round before recipients get
send turns spreads startup cost fairly rather than prioritizing the first users.

These are single process runs per case, not confidence intervals. Peak RSS
includes fixture seeding; CPU and delivery latency exclude it. Some independent
containers overlapped, so wall time includes shared-host scheduling effects.
The fixture has synthetic network latency and a finite population: the numbers
are evidence for the tradeoff, not a production capacity promise. Raw CPU,
wall-time, RSS, cgroup peaks, workload parameters, and candidate source hashes
are in [the measurement artifact](benchmarks/2026-09-16-private-concurrency.json).

## Behavioral evidence

Crawler integration tests exercise 32 simultaneous recipients and assert an
eight-send bound, first-turn fairness, and ordered delivery. Bot integration
tests use the real Telegram client with synthetic HTTP responses: eight peers
waiting on `retry_after` leave a ready recipient free to send; retries preserve
one-token accounting, four-attempt limits, announcements, and peer progress.
Deletion wakes an otherwise sleeping scheduler immediately.

A 40-recipient SQLite test combines a slow recipient, a failed send, deletion,
and cancellation during delivery. Active operations drain, acknowledged sends
survive reopening, deleted state stays absent, unsent work resumes in order,
and a final crawl sends nothing. Existing process-crash tests also verify that
an acknowledged listing is not repeated after a process exits. These are local
deterministic checks, not a claim that a production shutdown was exercised.

## Reproduction

Install lockfile dependencies, archive the baseline into a disposable directory,
and create an empty `node_modules` directory inside that archive for the bind
mount. With the repository as the current directory:

```bash
docker run --rm --network none --cpus 1 --memory 512m \
  -v "$PWD:/app:ro" -w /app node:24.18.0-bookworm-slim \
  node --expose-gc scripts/private-concurrency-benchmark.js --users 88
```

Repeat with `--users 256`. For baseline runs, additionally mount the archive at
`/baseline:ro` and the installed dependencies at `/baseline/node_modules:ro`,
and add `--implementation-root /baseline`. The harness removes only the temporary
SQLite directory it creates. Defaults are 1,000 retained listings, 100 selected
per recipient, and 5 ms send latency; CLI flags expose each value.

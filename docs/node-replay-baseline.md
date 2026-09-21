# Node replay contract and local baseline

Issue [#29](https://github.com/monkeysees/arm-rental/issues/29) establishes the
private-delivery baseline for the language experiment in #22. All work stays on
`experiment/22-runtime-comparison`. The replay imports the existing crawler,
parser, normalization/filtering, SQLite repositories, bounded private scheduler,
and private rate limiter. Production runtime and deployment are unchanged.

## Reproduce

Use the lockfile dependencies (`npm ci`) and the pinned
`node:24.18.0-bookworm-slim` image. Docker must support cgroup v2 memory accounting.
From the repository root:

```bash
# Export identical HTML inputs, filters, seed rules, and independent expectations.
node experiments/node-replay/export.js /tmp/rental-replay-contract

# Small integration/negative-oracle check, without performance claims.
node --test test/node-replay.test.js

# One full behavior run at the required population.
docker run --rm --network none --cpus 1 --memory 512m --memory-swap 512m \
  -v "$PWD:/app:ro" -w /app node:24.18.0-bookworm-slim \
  node experiments/node-replay/run.js --users 500 --mode virtual \
  > /tmp/rental-replay-result.json
node experiments/node-replay/verify.js /tmp/rental-replay-result.json

# Complete protocol: virtual once, wall three times, at 500 recipients.
# The output directory must not exist. Keep the source unchanged during runs.
node experiments/node-replay/measure.js /tmp/rental-replay-measurements
```

The exporter also requires a new directory and refuses to overwrite one. The
runner creates its own temporary SQLite directory and removes it on completion.
Containers have networking disabled; synthetic HTML replaces List.am, a fixed
exchange-rate snapshot replaces CBA, and the simulated transport replaces
Telegram. No credentials, production data, HTTP endpoints, or deployment tools
are used. The four-recipient option exists only for the integration test; it is
not a capacity workload. There is no TypeScript/typechecking command in this
JavaScript repository; syntax checks, ESLint, the focused test, and `npm test`
are the applicable checks.

## Frozen workload and independent oracle

[`contract.json`](../experiments/node-replay/contract.json) is the versioned
language-independent contract. The exported `manifest.json` includes concrete
listing IDs, HTML filenames, recipient profiles, seed decisions, phase actions,
exact expected delivery arrays, and expected classification maps. Go and Rust
can consume these JSON/HTML files without running Node application code. The
fixture generator and independent result verifier are experiment tools only.

Every recipient retains **6,563 decisions**: 5,442 extant listings and 1,121
absent listings. That is 3,281,500 decisions at 500 recipients. This preserves the rounded per-recipient density of the earlier
577,501-decision/88-recipient harness, using its real HTML → crawl → SQLite
approach. Four equal recipient cohorts match one quarter of listings through
exact AMD price filters: 100,000, 200,000, 300,000, or 400,000. One cohort also
requires two rooms. Both housing kinds are enabled. Even IDs are apartments;
odd IDs are houses. The 200,000 AMD cohort uses original USD 500 prices and a
fixed 400 AMD/USD snapshot. Locations, room counts, area, floor, canonical URL,
original/canonical price, kind, title, and per-recipient order are asserted.

The seed marks matching extant/absent IDs notified and nonmatches filtered.
All four cohorts exist in the workload. Seed timestamps and listing IDs are
synthetic. Category HTML is descending by ID; expected deliveries are ascending
within each cohort, reflecting oldest-first delivery with the stable source
order for equal displayed posting dates. The September 15 retained cards and
September 16 new cards exercise both categories and the documented calendar-day
source window. Page sizes remain at least 20 per category using already known
padding; the real source-integrity checks remain enabled.

| Phase                   | Input/action                                             | Required outcome per recipient                                                               |
| ----------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Seed                    | 5,442 category cards; seed 6,563 decisions               | Retained history and absent decisions persist                                                |
| Bootstrap + 3 unchanged | Encounter 40 retained cards                              | Zero sends; bootstrap separately identified                                                  |
| Updated                 | Change titles on 8 retained cards                        | Exactly 2 matching updates, in explicit order                                                |
| Fresh                   | Introduce 8 new cards                                    | Exactly 2 matching new listings                                                              |
| Catch-up store          | Store 40 new cards without delivery                      | 10 potential matches per recipient                                                           |
| Catch-up                | Request initial selection for every recipient; limit 8   | Announcement, latest 8 matches oldest first; 2 older matches skipped; 30 nonmatches filtered |
| Interrupted             | Introduce 32 cards; fail third send per recipient        | Exactly 2 acknowledged messages; 6 matching messages remain pending                          |
| Resumed                 | New process, same SQLite database and cards              | Verify acknowledged prefix first; deliver exactly the remaining 6                            |
| Drained                 | Repeat unchanged                                         | Zero duplicate messages                                                                      |
| Returning               | Present 4 old-dated IDs previously absent but classified | Zero sends; all absent-decision timestamps unchanged                                         |

The returning cards are dated before the current category watermark. This phase
checks that presenting them does not send anything or alter retained decisions;
it does not establish suppression when an absent ID returns with a current date.

The hand-authored expected ID arrays come from this behavior, not from capturing
Node output. Every recipient is checked. Results compact identical observations
into four `deliveriesByProfile` arrays and four `classificationsByProfile` maps;
all recipients are compared with their cohort before that compression. Statuses
are `notified`, `filtered`, `skipped`, and `pending`. `recipientsAsserted` and
`classifiedRecipients` report the checked population. `verify.js` independently
compares those observed fields with the contract, including counts, order,
catch-up announcements/retries, and restart outcomes. The integration test
mutates valid results to prove that incorrect ordering and incorrect skipped
classifications are rejected. A future implementation must export this result
shape and check actual transport contents too; copying expected results is not
conformance. `status: passed` means behavior passed; capacity has separate fields
and may fail.

## Rate, time, fairness, and interruption

The declared routine workload is **8 source updates plus 8 fresh cards per
60-second interval**: four delivered listings per recipient, or 2,000
messages at 500 recipients. Catch-up is a separate burst of eight selected
listings plus an announcement per recipient. Transport takes 5 ms per attempt.
The global simulated ceiling is 200 attempts/second, in addition to the real
per-recipient limiter's 20 messages/minute and initial burst of five. Announcements
consume a recipient token. Every tenth recipient's first catch-up listing gets
one synthetic retry-after of 1,000 ms; the retry consumes another global attempt
but reuses its recipient token. This exercises two attempts, within the declared
four-attempt ceiling; it does not test exhaustion of all four attempts. Product
limits and retry deadlines release scheduler capacity. Each isolated phase
begins with full process-local buckets, modeling an idle interval between bursts;
restarting also resets these process-local limits, as production does.

Wall runs use real monotonic waits, actual SQLite work, and real transport delay.
Virtual runs serialize transport at a virtual clock boundary and advance waits
without real time. Their assertions verify rate/retry behavior and outputs;
**virtual drain time and virtual execution speed are not performance estimates**.
No wall throughput or capacity verdict is emitted for virtual mode. Source dates
use a fixed fixture epoch and logical crawl intervals, independently of the host
date; this is an offline replay rather than a long-running arrival simulator.

`classificationWallMs` ends when every recipient's classification worker has
completed. Routine capacity requires the combined updated + fresh work, and
separately their combined classification time, to fit 60 seconds. Catch-up's
ideal drain floor is the larger of global attempts/200 and the four refill
intervals needed after the initial five tokens. The permitted-rate target is
that floor times a predeclared 1.10 tolerance, including classification cost.
This deliberately exposes catch-up classification overhead rather than removing
it from the capacity verdict.

Fairness requires every recipient to make progress, and the last recipient's
first listing to arrive within complete classification time + two global-rate
sweeps (announcement and first listing) + retry-after + transport latency,
again with 1.10 tolerance. Results also retain maximum recipient lead, all first
progress percentiles, and send queue-age percentiles. A recipient waiting for
retry/rate eligibility can legitimately fall behind ready peers. Classification
and transport together constitute measured drain time; correctness checks after
a crawl contribute to reported wall/CPU totals, so these are conservative replay
measurements, not instrument-free application timings.

Interruption is a handled synthetic delivery failure followed by `process.exit(23)`
without closing SQLite. The crawler's `finally` has cleared its temporary batches.
A new process checks acknowledgements before it resumes pending work. This proves
acknowledged-prefix durability and pending-suffix reconstruction; it does not
simulate a kill during a transaction or in the external-send/local-acknowledgement
window. That latter window retains production's documented at-least-once risk.
Resumed queue age combines interrupted drain, restart gap, and resumed delay.
The virtual gap is 1,000 ms; wall mode measures the process gap. Retained-history
validation and resumed-prefix validation between those boundaries are excluded,
so this is modeled delivery/restart age, not total wall-clock outage age.

## Measurement boundary and repeat protocol

The primary RAM metric was frozen before final measurement: **the maximum
cgroup-v2 `memory.peak` over one complete replay in a fresh container**. Compare
three independent runs, reporting their range and median. This boundary includes
the coordinator, one live worker, Node managed memory, SQLite/native allocations,
fixture construction/verification, SQLite/WAL files in cache, and container kernel
charges. It is broader than process RSS and includes fixture seeding and bootstrap.
No forced GC or deliberate host cache flush is performed. Separate worker
processes seed, exercise/interruption, and resume. The seed database is not reused
between runs. Runs execute sequentially, with one virtual run followed by three
wall runs at 500 recipients. Source SHA-256 hashes accompany every result; the
measurement manifest records exact Docker arguments and image identity.

Idle memory is sampled just after each worker opens SQLite. Steady memory is
sampled before/after the three post-bootstrap unchanged crawls. Process RSS,
heap, external allocations, and process lifetime RSS high-water marks are
secondary measurements. Twenty-millisecond samplers provide phase samples, not
exact per-phase maxima: synchronous SQLite work may prevent sampling. Kernel
`memory.peak` and process lifetime high-water marks retain short-lived peaks.
Cgroup peaks are cumulative throughout one container; never subtract cumulative
peaks to estimate phase allocation. The primary includes the coordinator even
though a worker's process RSS does not. Missing cgroup data stays unknown and
cannot satisfy the memory criterion.

The measured host is a **four-vCPU x86-64 KVM guest**, AMD EPYC-Rome, with about
7.57 GiB visible RAM, a QEMU non-rotating virtual disk, ext4 backing storage,
and Docker overlayfs. Runs use Node 24.18.0, one CPU quota, 512 MiB application
memory, and zero allowed swap; `/proc/swaps` was empty. The manifest and per-run results contain
complete CPU, disk, kernel, container limits, and image details. The developer
host and existing unrelated services remain outside the experiment boundary;
virtualized storage and host scheduling introduce run variation.

**This is not a measured 512 MB machine or Raspberry Pi capacity result.** The
host OS, Docker daemon, production supervision, curl-impersonate subprocesses,
health checks, polling, channel delivery, backup, and migration do not run inside
this offline replay. Curl remains the intended production source transport; its
live cost is unmeasured here. Neither subtracting process RSS from 512 MiB nor
setting an application cgroup limit establishes full-machine headroom. The parent
experiment must account for those lifecycle and platform costs before claiming
whole-machine fit or a meaningful language improvement.

## Results and acceptance

All four retained full replays passed the independent behavior verifier: one virtual run
and three wall runs at 500 recipients. Original source hashes identify the
measured implementation. The [raw manifest](benchmarks/node-replay/final/manifest.json)
records exact commands, host details, image identity, timestamps, and individual
capacity verdicts. Raw wall results are available for
[500 run 1](benchmarks/node-replay/final/500-wall-1.json),
[run 2](benchmarks/node-replay/final/500-wall-2.json),
[run 3](benchmarks/node-replay/final/500-wall-3.json). The
[virtual result](benchmarks/node-replay/final/500-virtual-1.json) is
behavioral evidence only.

The table reports medians of the three wall runs. Steady entries first take the
median of each run's three post-bootstrap unchanged samples. Idle is the exercise
worker immediately after opening the seeded database. Process peak is the maximum
worker lifetime RSS high-water mark in each replay; the primary service peak is
the whole-container cgroup peak. MiB means 1,048,576 bytes.

| Metric                                                      |          500 recipients |
| ----------------------------------------------------------- | ----------------------: |
| Process RSS, idle / steady / peak (MiB)                     |    79.6 / 115.2 / 147.4 |
| Service memory, idle / steady / peak (MiB)                  |   132.7 / 173.1 / 282.4 |
| Primary service-peak range (MiB)                            |             281.6–284.9 |
| Unchanged crawl CPU / wall (ms)                             |           414.5 / 600.9 |
| One-time seeded-history reconciliation wall (s)             |                    86.4 |
| Routine classification / CPU / wall (s)                     |     2.12 / 4.52 / 15.27 |
| Catch-up classification / CPU / drain (s)                   | 93.92 / 101.13 / 123.00 |
| Catch-up listings per wall second, including classification |                   32.52 |
| Catch-up queue age p95 (s)                                  |                  121.46 |
| First listing per recipient, p95 / maximum age (s)          |         102.16 / 106.23 |
| Resumed drain / resumed queue age p95 (s)                   |           22.51 / 32.64 |
| Final database / WAL (MiB)                                  |            87.06 / 4.16 |

Routine work met the 60-second crawl target in all three wall runs:
15.22–15.44 seconds. Routine classification alone took 2.11–2.13 seconds.
Unchanged-crawl per-run median CPU varied from 377.0–418.6 ms.

**Catch-up failed the permitted-rate target in every wall run.** Its allowed
drain time was 25.025 seconds, whereas measured drain was 122.44–123.17 seconds.
Full-history classification dominated this cost and itself exceeded a 60-second
interval. The one-time bootstrap cost is also above that interval; it remains
separately reported. A synchronized catch-up burst can delay subsequent crawls
even though routine incremental work keeps pace.

The fair-progress target passed in all three runs. All runs completed under
the 512 MiB application limit without swap or OOM. Process RSS alone would
understate the accounting boundary substantially. Whole-machine/Pi fit remains
unvalidated for the reasons above. The retained 500-recipient measurements,
history density, rates and acceptance thresholds are unchanged.

Local verification passed all **425 tests** on Node 24.18.0, including the replay
and negative-oracle checks. Coverage was 94.56% lines, 88.22% branches, and 92.02%
functions; ESLint and the production deployment-contract validator also passed.
Independent standards and specification reviews left no implementation findings.
The performance misses are baseline evidence for #22, not a production runtime
change or a successful capacity claim.

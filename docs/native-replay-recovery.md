# Go and Rust interruption recovery

Issues [#32](https://github.com/monkeysees/arm-rental/issues/32) and
[#33](https://github.com/monkeysees/arm-rental/issues/33) extend the native
prototypes to the full [shared replay contract](node-replay-baseline.md), at
500 recipients. Production state, runtime and deployment are unchanged.
All work remains on `experiment/22-runtime-comparison`.

## Reproduce

Build and run the language checks using the commands in the
[Go slice](go-replay-slice.md#reproduce) and
[Rust slice](rust-replay-slice.md#reproduce) documents. Then, from the repository
root, run the complete acceptance protocol into new directories:

```bash
node experiments/node-replay/measure.js /tmp/go-recovery-measurements \
  --runtime go --go-binary /tmp/arm-rental-go-build/replay
node experiments/node-replay/measure.js /tmp/rust-recovery-measurements \
  --runtime rust \
  --rust-binary "$PWD/experiments/rust-replay/target/release/rental-replay"
```

Each command runs one virtual behavior check and three independent wall replays
at each population, sequentially in fresh offline containers with one CPU,
512 MiB application RAM and no swap. Keep source and binaries unchanged during
measurement. The manifest records exact Docker commands, image identity and host
details; each result records source and binary hashes. Virtual timings are not
performance evidence. Four recipients remain available for focused diagnostics.

For one diagnostic using either compiled executable:

```bash
node experiments/node-replay/run.js --runtime go \
  --go-binary /tmp/arm-rental-go-build/replay --users 4 --mode virtual \
  > /tmp/go-recovery-diagnostic.json
node experiments/node-replay/verify.js /tmp/go-recovery-diagnostic.json
```

## Recovery boundary

The coordinator exports the same HTML and manifest for both languages. It starts
an exercise process with a fresh SQLite database, waits for exit code 23, then
starts a resume process against that database. The exercise fails the third
listing send for every recipient after two durable acknowledgements. It emits
its observations and exits without closing SQLite. The new process checks the
acknowledged prefix and pending suffix before resuming delivery. It then runs
the unchanged drained phase and returning absent-card phase. The independent
oracle checks every phase's delivery order, classifications and actual payloads;
the completed replay must have no pending decisions.

This is the same handled-failure/unclean-process-exit boundary as the Node
baseline. It does not claim arbitrary instruction-level crash coverage or
exactly-once Telegram delivery. Acceptance by Telegram and a local SQLite
acknowledgement cannot commit atomically: a process that dies between them can
send that listing again after restart. Focused diagnostic tests model this
window separately from the frozen capacity workload. Durably acknowledged sends
must never be replayed.

Retained-history checks stream ordered recipient/listing/status/revision/time
rows with bounded memory. Go uses SHA-256; Rust uses the pinned executable's
deterministic 64-bit `DefaultHasher` as a non-cryptographic corruption fingerprint.
The latter is not an adversarial integrity mechanism. Its regression test changes
classification assignments while preserving grouped counts and ID sums, proving
the earlier aggregate check's blind spot is covered.

Catch-up retries that become eligible before their recipient's first successful
listing get a turn before the ordinary cursor resumes. This removes the extra
whole-recipient sweep observed in the earlier slices while retaining the same
global and per-recipient limits. Observations retain first-progress percentiles,
maximum recipient lead and queue-age percentiles as well as the shared deadline
verdict.

## Measurement interpretation

The primary memory metric remains the fresh container's cumulative cgroup-v2
`memory.peak`, including the Node coordinator/exporter, native workers, SQLite,
filesystem cache and kernel charges. Repeated phase samples and process RSS are
secondary; sampled values can miss short peaks. Workers execute sequentially,
so process peak RSS is their maximum, while process CPU and wall work are summed.
The original raw slice measurements remain historical evidence of their shorter
lifecycle and are not overwritten.

Wall queue ages include classification. Resumed queue ages add interrupted
classification/drain time and the measured process-restart gap; as in the Node
baseline, retained-history and acknowledged-prefix verification between those
boundaries is excluded. Virtual mode uses a fixed 1,000 ms restart gap and emits
no throughput estimate. Wall throughput divides successful listing count by the
complete phase wall duration, including classification and observation checks.
Integrity checks still contribute to whole-process CPU/wall and container memory.

The host OS, Docker daemon, live curl, production polling, supervision and other
operational services remain outside this boundary. These results cannot establish
whole-machine or Raspberry Pi capacity. The existing fixture-parser restrictions,
experimental schemas, and missing production features listed in the two slice
documents still apply. No production migration, deployment or live Telegram
acceptance is implied.

## Acceptance results

All eight retained replays passed the independent behavior oracle: one virtual
and three wall runs per language. All six wall runs passed
routine classification/crawl, fair progress and the 512 MiB application-memory
gate. Each completed replay retained 3,321,500 decisions at 500 recipients,
preserved historical/absent decisions, and had zero pending
work. All recipients received exactly two interrupted acknowledgements and six
resumed listings in order, with zero sends in drained and returning phases.

The [Go manifest](benchmarks/go-replay/recovery/manifest.json) and
[Rust manifest](benchmarks/rust-replay/recovery/manifest.json) record all commands,
timestamps, host/image details and individual verdicts. Each directory contains
the four complete raw results. Archived JSON values were compared with the
original output; all eight source/binary hash sets identify the measured code and
executables. Runs were sequential and source stayed frozen throughout.

Values below are medians of three wall runs, except the explicitly labeled
ranges. Queue age includes the boundaries described above. Each replay retains
16 memory snapshots covering both process openings and all phases, including
three post-bootstrap unchanged samples. The primary peak is the entire cgroup,
not the native process alone.

| Metric                                      |        Go 500 |      Rust 500 |
| ------------------------------------------- | ------------: | ------------: |
| Container peak RAM (MiB)                    |        197.89 |        185.58 |
| Container peak range (MiB)                  | 196.32–198.55 | 185.29–187.48 |
| Native process peak RSS (MiB)               |         23.08 |         16.08 |
| Native CPU / wall (s)                       | 35.99 / 90.48 | 10.27 / 65.02 |
| Routine classification / wall (s)           | 0.355 / 11.61 | 0.053 / 10.37 |
| Catch-up classification / complete wall (s) | 1.810 / 27.09 | 1.489 / 24.89 |
| Catch-up listings per wall second           |        147.65 |        160.74 |
| Catch-up queue age p95 (s)                  |         25.70 |         23.79 |
| Last first listing / allowed deadline (s)   | 8.377 / 8.596 | 7.714 / 8.243 |
| Maximum recipient lead (listings)           |             2 |             2 |
| Resumed transport drain / queue age p95 (s) | 16.56 / 24.58 | 15.37 / 22.36 |
| Final SQLite / WAL before close (MiB)       | 76.70 / 75.39 | 76.71 / 75.39 |

**Catch-up is not a passing capacity claim.** Go missed the
25.025-second target in all three runs (26.825–27.128 seconds).
Rust passed twice (24.879 and 24.885 seconds) but missed once (25.163 seconds).
No threshold, workload or rate was relaxed, and the passing Rust median does
not erase its failed individual run.

The scheduler fix establishes the declared fair-progress target in these runs;
it does not eliminate classification and local persistence costs. Native CPU
and total wall figures also include verification of millions of historical
rows, with different fingerprint algorithms, SQLite versions and drivers. They
are not measurements of language overhead alone. Remaining production gaps
include bot conversations/polling, live source/CBA transport, channel delivery,
migrations/backups, health/alerts, deployment and graceful shutdown integration.

Implementation and acceptance took approximately 45 minutes of elapsed agent
work, including parallel Astra-low native implementation, regression tests,
independent reviews, review fixes, repository checks, two interrupted diagnostic
attempts and the sequential constrained replays. No human
acceptance execution or production operation was required.

## Verification

All 425 repository tests pass on Node 24.18.0; source coverage is 94.54% lines,
88.19% branches and 92.02% functions. ESLint, changed-file formatting and the
production deployment-contract validator pass. Go tests/vet and Rust's eight
executable tests, Cargo check, Clippy with warnings denied, formatting and release
builds pass. JavaScript has no separate typechecking command; the Go compiler
and Cargo check provide the native type checks.

The new 500-recipient fairness regressions first failed at 7,460 ms in Go and
7,970 ms in Rust against the frozen 6,605.5 ms virtual first-progress bound, then
passed after preserving ordinary cursor turns during urgent retries. The
[superseded Go diagnostic](benchmarks/go-replay/recovery-diagnostics/README.md)
retains the observed result and explains interrupted measurement attempts.

### Standards

No remaining findings. Review removed the unnecessary optional-stage Go API and
consolidated Rust's retained-history validation.

### Specification

No remaining implementation findings. Review aligned restart-age boundaries with
Node, completed fairness metrics and strengthened retained-history verification.
Independent follow-up confirmed that urgent retries preserve ordinary turns and
retain global-rate, recipient-rate and retry-deadline checks. Capacity verdicts
remain separate from behavior verification.

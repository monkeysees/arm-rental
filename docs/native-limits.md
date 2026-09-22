# Native service at 75 MB and 50 MB

Issue [#43](https://github.com/monkeysees/arm-rental/issues/43) assesses the
implemented experimental Rust service and its offline maintenance commands on
`experiment/22-runtime-comparison`. Its packaged runtime is described in
[the minimal-image assessment](native-image.md), issue #42. Production runtime,
deployment and state remain unchanged.

**Both limits fail the full 500-recipient capacity gate.** All six repeats complete
correct delivery, forced-boundary recovery, backup/restore and populated migration
without OOM, but every catch-up run exceeds the unchanged 25.025-second deadline.
The native workload survives the configured memory limits; that alone does not
satisfy the agreed workload contract.

## Measurement contract

The two requested limits are **75,000,000 bytes (75 MB; 71.526 MiB)** followed by
**50,000,000 bytes (50 MB; 47.684 MiB)**, with swap disabled and one CPU. Each limit
requires three independent 500-recipient wall-clock runs. The original shared
contract's retained history, classifications, delivery order, acknowledgements,
rate limits, retries, fairness and capacity thresholds remain binding. Failures
and OOMs are evidence; a failed limit does not justify weakening the workload.

The service boundary includes the native executable, SQLite allocations, real
local curl children, native health checks, filesystem cache and kernel charges.
Fixture generation, the local fixture peer and independent verification remain
outside it and are accounted for separately. Maintenance is mutually exclusive
with serving; backup, restore and populated migration are evaluated separately,
and their peaks must not be added together.

All state is synthetic and transport uses local peers. Disk-backed files are
required for the constrained runs. Earlier acceptance used tmpfs and sometimes
reopened state whose cached pages remained charged to an ancestor cgroup; those
measurements cannot establish the complete cold-state budget at these limits.

## Scope of the conclusion

These are local Linux AMD64 container observations. They do not establish ARM or
Raspberry Pi performance, physical power-loss durability, or fit on a complete
512 MB machine. The Docker daemon, host OS and production supervision are outside
this service budget. Findings feed [#35](https://github.com/monkeysees/arm-rental/issues/35)
without replacing its whole-machine and lifecycle assessment or modifying #22.

The native implementation remains a replay prototype. Live Telegram/CBA/List.am
integration, complete source parsing, private conversation and channel parity,
production Node-to-Rust state migration, arbitrary-state maintenance and arbitrary
mid-stage service crash recovery remain unimplemented or unvalidated. The forced
service interruption is at the implemented durable pending-restart boundary;
recovery must preserve its acknowledged prefix and drain only its pending suffix.

## Acceptance results

The [raw manifest](benchmarks/native-limits/manifest.json),
[independent audit](benchmarks/native-limits/audit.json) and
[resource summary](benchmarks/native-limits/summary.json) retain all six ordered
repeats. All **42 measured operations** and **12 unmeasured input-preparation
operations** complete with expected exits. All 18 combined replay oracles and
their corrupted-order negative controls verify; all resource/cache checks pass,
with zero sampling errors and zero OOM events. The audited budget status remains
`failed`, while `verificationStatus` is `passed`.

| Observation across three repeats                  |           75 MB |           50 MB |
| ------------------------------------------------- | --------------: | --------------: |
| Full capacity decision                            |   **Fail, 0/3** |   **Fail, 0/3** |
| Correctness/recovery / backup-restore / migration |        3/3 each |        3/3 each |
| Requested hard limit, bytes                       |      75,000,000 |      50,000,000 |
| Kernel effective limit, bytes                     |      74,997,760 |      49,999,872 |
| Worst observed cgroup peak, bytes                 |      75,005,952 |      50,012,160 |
| Unchanged-phase steady cgroup memory, MB          |   70.099–72.610 |   46.486–48.194 |
| Post-exercise idle cgroup memory, MB              |   67.994–72.229 |   44.737–47.497 |
| Exercise cgroup CPU, seconds                      |   13.494–13.629 |   13.428–13.598 |
| Catch-up wall time, seconds                       |   25.260–25.340 |   25.125–25.170 |
| Catch-up queue age p95, seconds                   |   24.156–24.227 |   24.036–24.060 |
| Catch-up listing throughput, messages/second      | 157.856–158.352 | 158.918–159.203 |

The deadline remains 22.750 seconds ideal drain time × 1.1 tolerance = 25.025
seconds. Routine-crawl classification, routine delivery and fair first-recipient
progress pass in every repeat; the catch-up deadline is the only failed capacity
criterion. No recipients, retained decisions, durability operations or retries
were removed to improve the result. Every complete replay retains 3,321,500
decisions and resumes only the 3,000 pending sends after its 1,000-send acknowledged
prefix. Small differences between the two ordered sets are not a controlled
comparison of why one limit's timings differ from the other's.

Maintenance command wall-time ranges, including container launch/inspection, are
11.099–11.446 seconds for backup, 10.773–11.152 for restore and 14.153–14.556 for
migration at 75 MB. At 50 MB they are 11.555–12.425, 11.636–14.271 and
15.213–17.019 seconds. These operations each pass under their configured cap and
are mutually exclusive. Their native reports, CPU counters, pressure stalls,
I/O and per-operation min/median/max values remain in the raw records and summary.

Kernel peaks exceed the effective limit by at most 8,192 bytes at 75 MB and
12,288 bytes at 50 MB during transient charging/reclaim; no value is clamped.
The largest recorded per-operation `pgscan` counts are 387,417 and 432,659,
respectively, showing active reclamation. Sampled logical disk peaks are
615,488,404 and 615,488,447 bytes, including retained previous copies and private
runtime/fixture files. Separate category maxima are 560,218,112 database bytes,
12,372,456 WAL bytes and 158,130,176 temporary bytes; they occur at different
times and must not be added.

The [external process-tree record](benchmarks/native-limits/external.json) reports
965.60 seconds elapsed, 181.00 CPU seconds and a 626,356,224-byte largest-process
RSS high-water mark for the coordinator and waited-for helpers. The separate
fixture peer peaks at 55,377,920 cgroup bytes and consumes 2.60 CPU seconds.
These are external verification costs, excluded from the native service caps.

This evidence supplements the original [runtime comparison](runtime-comparison.md)
and [service-only replay](service-replay.md); their measurements and accounting
boundaries remain unchanged. For #35, both low-memory configurations remain
**capacity failures**, despite successful memory-constrained lifecycle execution.
Further investigation must address catch-up latency while preserving the existing
contract, then repeat this acceptance. Production feature gaps and the unmeasured
whole-machine budget remain separate work; no rewrite/deployment approval follows
from these results.

## Reproduce and account for cache

Use the pinned image from [#42](native-image.md) and the genuine version-0
executable built by the [migration recipe](native-migration.md#reproduction-and-resource-boundary).
The external tools require Node 24.18.0, Python 3, Linux cgroup v2, Docker,
`tar`, `gzip`, `findmnt` and `getconf`. Start with a new disk-backed output
directory and run sequentially without overlapping builds or benchmarks:

```bash
python3 experiments/native-limits/measure.py /tmp/native-limit-external.json \
  /tmp/arm-rental-node-24.18/node experiments/native-limits/run.js \
  /tmp/native-limit-acceptance arm-rental-issue42-frozen:local \
  /tmp/arm-rental-41/legacy-replay
node experiments/native-limits/audit.js /tmp/native-limit-acceptance
node experiments/native-limits/report.js /tmp/native-limit-acceptance
```

The runner and audit return nonzero when a budget fails. The audit separately
reports whether the completed phase evidence verifies, so a capacity failure is
not confused with missing or invalid measurements.

The runner fixes both limits, their order, three repeats and the population in
source. It requests the exact decimal byte values from Docker and verifies
`memory.max`, `memory.swap.max=0` and `cpu.max=100000 100000`. On this 4,096-byte-page
host, the effective limits are 74,997,760 and 49,999,872 bytes. A pass means the
full implemented workload completes under the configured limit with no OOM and
with the original capacity/fairness gates intact. Kernel `memory.peak` can briefly
exceed the effective limit during charging/reclaim; exact observed values are
retained, never clamped. This is not a claim that every transient observation is
mathematically below the requested number of bytes.

The image filesystem is exported once outside the measured containers. Each
repeat receives private, byte-identical copies of the native executable, curl,
ELF loader, complete library closure, certificates and account/NSS configuration,
plus its own fixture inputs. Every runtime file is hashed against the frozen
image and mounted read-only at its original path. Before **each** operation,
`sync`, `POSIX_FADV_DONTNEED` and `mincore` verify zero resident pages for the
repeat's runtime files, fixture inputs and state. Content checks precede eviction;
no host content read follows eviction before container launch. These private
inodes prevent shared image and ancestor-owned state cache from making a pass
artificially cheap. Runtime contents and behavior are unchanged; the measurement
uses explicit read-only file mounts to control cache attribution.

Docker-generated hosts, hostname and resolver files can remain daemon-charged.
They are part of the excluded container infrastructure, alongside Docker itself;
this is explicitly outside a whole-machine-fit claim. All repeats use the same
host disk and one-CPU quota, with no separate IOPS throttle. The service has local
network access only; maintenance has no network. No Node, shell or test coordinator
executes in the measured service container.

Each repeat starts a fresh 500-recipient service, observes real curl and native
health during replay, kills it with SIGKILL at the durable pending-restart
boundary, then resumes and shuts it down through its native control command.
Resume uses a fresh socket name because SIGKILL leaves the old socket entry.
The oracle checks the acknowledged prefix and pending suffix, all retained
history, ordered payloads, retry behavior and classifications. A deliberately
reversed delivery list must be rejected. The unchanged shared capacity evaluator
checks routine-crawl time, catch-up drain time and fair recipient progress.

Backup/restore and migration run separately, each in a new constrained cgroup.
Their populated inputs are produced by native executables in explicitly
**unmeasured 512 MiB preparation containers**. This lets maintenance still be
assessed if serving fails; preparation cannot turn a failed service repeat into
a pass. Migration uses the genuine old executable, preserves source hashes and
then checks migrated replay with the independent oracle. Successful synthetic
databases are hashed before removal. Failed-run databases are retained as verified
compressed archives with per-file hashes; raw failure reports remain.

## Recorded measurements

The sampler records cgroup current/peak memory, allocation categories, memory
and OOM events, reclaim counters, CPU, pressure stalls, block I/O, process lists,
and logical database/WAL/temporary disk sizes every 100 ms. Native reports also
retain phase timings, queue-age distributions, drain time, throughput and three
unchanged-phase memory snapshots after initial reconciliation. Post-work idle
samples come from the still-running service at pending-restart/drained readiness,
with its transport probe active. This differs from an empty-process idle figure.

Cgroup teardown can hide terminal events between samples; Docker's final
`OOMKilled` flag is checked separately, and raw native high-water marks are also
retained. Logical disk sampling cannot see every short-lived or unlinked file,
and category maxima must not be added. Previously retained databases and private
runtime copies remain in the disk accounting until explicitly removed.

The external fixture peer has its own cgroup observations. The Node coordinator
reports its resource usage, and `measure.py` adds CPU and largest-process RSS for
its waited-for helper process tree. That RSS is the largest individual high-water
mark, not simultaneous aggregate RAM. Docker daemon/host costs are excluded;
these figures must not be mistaken for a complete machine budget.

## Evidence provenance and reporting correction

The native source is unchanged from the frozen #41 implementation. The executable
and image match [#42's artifact manifest](benchmarks/native-image/artifacts.json).
The measured sampler is the `run.js` at commit `a8ddc2b`; its manifest also hashes
the external measurement wrapper and every harness input present at startup.
The native capacity adapter and independent audit were introduced in `fd644bb`;
the final reporting sources are identified by the audit's harness hashes.

The original sampler passed native phase objects directly to the shared capacity
evaluator. Native output calls its asserted recipient count `recipientsAsserted`,
where that evaluator expects `recipientsWithProgress`. This incorrectly marked
progress false after the actual service/recovery run had finished. Existing native
replay reporters already adapt these fields. The corrected adapter uses that same
mapping, including classification time in the first-progress deadline, and changes
no capacity threshold, fixture, runtime or measured operation.

The raw manifest and all observations remain unmodified. `audit.js` binds its
separate conclusions to the original manifest and oracle-input hashes, rechecks
all seven measured phases per repeat and both unmeasured preparation phases,
verifies cold runtime/fixture identity and every memory/swap/CPU check, and reruns
the independent oracles and negative controls. It also checks the curl/health and
recovery assertions that the reporting exception skipped. Corrected conclusions
are in `audit.json`; `report.js` requires that audit and verifies its manifest hash.
A genuine timing failure remains a failure. There was no need to repeat native
measurements merely to correct post-run classification.

A focused regression also caught a summary grouping error: a suffix match mixed
service resume with restored/migrated resume timings. Commit `e7424da` separates
the operation names exactly; the test failed before the correction and passes
after it. This changed only derived variation tables, not raw observations.

The audit runs against the full local output directory, which retains private
runtime copies and fixture inputs. The repository retains raw JSON, summaries and
hashes; generated runtime binaries and compressed synthetic database archives
remain in the recorded local output directory. Full reproduction rebuilds that
directory using the commands above.

## Final verification

All 437 Node tests pass with coverage (94.54% lines, 88.22% branches and
92.19% functions). The 22 Rust integration tests, Rust formatting/check/clippy,
JavaScript lint, repository formatting, shell checks and production deployment
contract check pass. The first full Node run found that the new README links were
not yet staged; staging the evidence and documentation resolved the checked-in
path guard, and the complete suite then passed.

### Standards review

Independent review found no remaining standards findings in the final source,
documentation or evidence.

### Spec review

Independent review found no remaining specification findings. It verified image
identity, evidence hashes, operation counts, cold-cache controls, oracles and the
six failed catch-up timings. Both tickets' assessment scope is complete; neither
memory limit is accepted as meeting capacity, and the whole-machine/rewrite
decision in #35 remains open.

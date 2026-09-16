# Fair runtime comparison

Issue #34 compares the full offline replay at 500 and 1,000 recipients on
`experiment/22-runtime-comparison`. The original Node baseline and native recovery
results remain under `docs/benchmarks/{node,go,rust}-replay/`.
The original Node data was committed at `43e6377`; native recovery data at
`0f099af`. Their raw manifests and per-run source/binary hashes remain unchanged.
The initial comparison is revalidated with the current shared oracle before
producing its summary; it is not silently relabeled as final evidence.

## Results and interpretation

**Neither prototype meets the combined acceptance gate.** At 1,000 recipients,
Go reduces the median primary service peak by **22.21%**, Rust by **24.22%**,
below the predeclared 25% threshold. At 500, both exceed 25% RAM savings, but Go
misses the catch-up rate target in all three runs, and Rust misses it in one.
This is a negative comparison result, not a reason to relax the limits or to
replace the production runtime.

All **30 full replays** pass behavior and interruption/recovery verification:
six cross-runtime gates plus eight protocol runs per runtime. The final
[protocol manifest](benchmarks/runtime-comparison/final/manifest.json),
[summary](benchmarks/runtime-comparison/final/summary.json), and per-runtime
[Node](benchmarks/runtime-comparison/final/node/manifest.json),
[Go](benchmarks/runtime-comparison/final/go/manifest.json) and
[Rust](benchmarks/runtime-comparison/final/rust/manifest.json) manifests retain
commands, limits, all repeats, capacity failures, source hashes and binary IDs.
The [fixture hashes](benchmarks/runtime-comparison/fixtures.json) identify every
exported HTML file and the shared manifest. The [initial summary](benchmarks/runtime-comparison/initial/summary.json)
retains the original comparison alongside the unchanged original raw data.

Tables report medians of three wall runs; ranges retain the minimum and maximum.
Idle means post-bootstrap for every runtime. Steady means each run's median of
three unchanged samples, then the median across runs. Process/service peaks are
lifetime high-water marks across the entire replay, including seed and recovery.
Routine means updated plus fresh. Catch-up and resumed wall times include the
phase's verification work; queue age retains the declared restart boundary.

### 500 recipients

| Metric                                      |                     Node |                       Go |                     Rust |
| ------------------------------------------- | -----------------------: | -----------------------: | -----------------------: |
| Process idle / steady / peak (MiB)          |   94.64 / 95.92 / 148.52 |    18.91 / 19.02 / 25.88 |    16.18 / 16.18 / 16.18 |
| Service idle / steady / peak (MiB)          | 151.68 / 152.91 / 286.99 | 191.93 / 192.47 / 194.57 | 183.81 / 183.70 / 185.77 |
| Primary service peak range (MiB)            |            284.28–290.32 |            194.24–196.43 |            185.26–187.57 |
| Unchanged CPU (ms)                          |                   385.32 |                   227.59 |                    47.99 |
| Routine classification / CPU / wall (s)     |      1.98 / 4.64 / 15.39 |      0.34 / 1.66 / 11.65 |      0.06 / 0.51 / 10.39 |
| Catch-up classification / CPU / wall (s)    |     6.49 / 12.99 / 35.57 |      1.82 / 4.54 / 27.03 |      1.43 / 2.31 / 24.81 |
| Catch-up wall range (s)                     |              35.50–35.65 |              27.02–27.11 |              24.72–25.09 |
| Catch-up listings per second                |                   112.46 |                   147.99 |                   161.24 |
| Catch-up queue p95 / last first listing (s) |            34.08 / 19.19 |             25.71 / 8.37 |             23.72 / 7.65 |
| Resumed wall / queue p95 (s)                |            22.93 / 33.09 |            16.76 / 24.61 |            15.43 / 22.39 |
| Final database / WAL (MiB)                  |             87.05 / 3.96 |            76.70 / 75.39 |            76.71 / 75.39 |
| Primary RAM reduction against Node          |                    0.00% |                   32.20% |                   35.27% |
| Required capacity runs passed               |                       no |                       no |                       no |
| Meets RAM + required capacity               |                       no |                       no |                       no |

### 1000 recipients

| Metric                                      |                     Node |                       Go |                     Rust |
| ------------------------------------------- | -----------------------: | -----------------------: | -----------------------: |
| Process idle / steady / peak (MiB)          |   95.47 / 96.17 / 151.56 |    17.86 / 18.04 / 25.26 |    16.00 / 16.00 / 16.16 |
| Service idle / steady / peak (MiB)          | 237.89 / 239.32 / 451.52 | 345.65 / 345.82 / 351.22 | 339.13 / 339.13 / 342.17 |
| Primary service peak range (MiB)            |            450.75–454.29 |            350.69–354.22 |            340.74–345.02 |
| Unchanged CPU (ms)                          |                   737.46 |                   434.26 |                    91.99 |
| Routine classification / CPU / wall (s)     |     4.08 / 11.39 / 30.28 |      0.77 / 3.61 / 23.47 |      0.13 / 0.99 / 20.75 |
| Catch-up classification / CPU / wall (s)    |    13.44 / 32.95 / 69.76 |      3.78 / 9.04 / 54.51 |      3.09 / 4.90 / 49.92 |
| Catch-up wall range (s)                     |              68.54–69.81 |              54.17–54.61 |              49.86–50.07 |
| Catch-up listings per second                |                   114.67 |                   146.76 |                   160.27 |
| Catch-up queue p95 / last first listing (s) |            66.78 / 44.25 |            51.81 / 16.17 |            47.77 / 14.78 |
| Resumed wall / queue p95 (s)                |            44.22 / 63.74 |            33.68 / 49.19 |            30.90 / 44.82 |
| Final database / WAL (MiB)                  |            170.45 / 3.96 |          152.64 / 150.01 |          152.65 / 150.01 |
| Primary RAM reduction against Node          |                    0.00% |                   22.21% |                   24.22% |
| Required capacity runs passed               |                       no |                      yes |                      yes |
| Meets RAM + required capacity               |                       no |                       no |                       no |

### Steady charged-memory attribution

| Recipients/runtime | Managed heap (MiB) | Charged anon (MiB) | Charged file (MiB) | Charged kernel (MiB) |
| ------------------ | -----------------: | -----------------: | -----------------: | -------------------: |
| 500 node           |              20.29 |              58.05 |              88.93 |                 5.49 |
| 500 go             |               2.00 |              28.41 |             152.49 |                 6.01 |
| 500 rust           |       not measured |              25.19 |             152.49 |                 5.77 |
| 1000 node          |              21.32 |              60.39 |             170.28 |                 7.90 |
| 1000 go            |               1.94 |              25.50 |             301.46 |                10.43 |
| 1000 rust          |       not measured |              26.92 |             301.74 |                10.21 |

The heap column is the worker's allocated managed heap; charged counters cover
the entire cgroup, including the coordinator. They are not additive partitions
of process RSS. Raw Node snapshots also retain external/array-buffer counters.
The native process RSS reduction is large, but native **steady service memory
regresses**: at 1,000 it is 345.82/339.13 MiB for Go/Rust versus Node's 239.32 MiB.
Native WAL files retain about 150 MiB, while Node closes its separate seed worker
and later retains about 4 MiB of WAL. File-cache snapshots expose this process/
checkpoint-policy difference; it is not a managed-runtime advantage. The final
lifecycle assessment should evaluate checkpoint policy explicitly.

Node's median catch-up classification falls from the original **93.92/190.57 s**
to **6.49/13.44 s** at 500/1,000; complete catch-up falls from **123.00/247.60 s**
to **35.57/69.76 s**. Most of the original catch-up gap therefore came from a
transferable query choice. Query preparation accounts for about 4.9 seconds of
the first final 500-recipient catch-up; acknowledgement transactions about 5.9
seconds. The query still scans retained history and retains general production
semantics. The remaining gap also includes different schemas, drivers,
prepared-statement use, transaction boundaries and schedulers, so it cannot be
assigned to language alone. The native classifiers commit a phase-wide batch;
Node commits bounded recipient operations and integrates live recipient
barriers, authorization and cancellation. Porting a whole phase into one Node
transaction would need a separate responsiveness/concurrency assessment.

Node's final primary peaks show a small regression rather than a RAM win:
median **286.99/451.52 MiB**, versus the original **282.4/450.7 MiB**; worst peaks
**290.32/454.29 MiB**, versus **284.9/459.1 MiB** originally. Thus the 500-recipient
worst peak grows even as latency and steady memory improve; the 1,000-recipient
worst peak decreases. These are unpaired runs with changed instrumentation, not
an isolated causal estimate of the query cache's memory cost. Node's primary
peak is dominated by seeded-history creation and its charged database/WAL cache,
not by the now-shorter catch-up phase. Neither native worst service/process peak
exceeds Node's corresponding final worst peak.

All runtimes meet the routine 60-second crawl/classification target and remain
below the application memory limit in every repeat. Go and Rust meet fair
progress at both populations. Node misses fair progress in all six wall runs.
The 500-recipient catch-up limit is **25.025 s**: Go takes **27.017–27.107 s**,
while Rust takes **24.725, 25.088, 24.807 s**. Rust's middle run misses by about
63 ms despite its passing median. At 1,000 the catch-up limit is 50.050 s;
Rust also misses that stricter rate target once, but longer stress catch-up is
permitted by the declared stress rule. Both native candidates pass the required
stress capacity checks, yet neither reaches the stress RAM reduction threshold.

## Runtime artifacts

The three separate real-curl exercises each passed all twenty body/cookie checks.
Observed child peak RSS was **2.887–2.906 MiB**; whole-container peak was
**20.74–22.83 MiB**, including the Node fixture peer. Request-window cgroup CPU
was **237.48–248.22 ms** per run, and individual request latency was
**102.64–116.80 ms**, including the artificial 100 ms peer delay. Counters are
frozen before executable hashing/version inspection. Raw observations retain
the curl executable hash, version and memory attribution:
[run 1](benchmarks/runtime-comparison/curl-1.json),
[run 2](benchmarks/runtime-comparison/curl-2.json),
[run 3](benchmarks/runtime-comparison/curl-3.json).

| Runtime | Compressed layers (bytes / MiB) | Unpacked layer tar (bytes / MiB) |
| ------- | ------------------------------: | -------------------------------: |
| node    |              60,723,671 / 57.91 |             168,757,760 / 160.94 |
| go      |              19,564,806 / 18.66 |               46,260,736 / 44.12 |
| rust    |              15,493,119 / 14.78 |               42,507,264 / 40.54 |

The [artifact manifest](benchmarks/runtime-comparison/artifacts.json) records all
layer digests, image IDs, input hashes and binary hashes. Both packaged native
binaries exactly match the measured executables, and the packaged Node source
hashes match the measured Node source. The [native artifact smoke](benchmarks/runtime-comparison/artifact-smoke.json)
passes the independent replay/recovery oracle at four diagnostic recipients;
the existing Node production runtime smoke also passes. All saved layers were
gzip encoded, so the compressed figures above are stored layer bytes. Runtime
archives are generated locally as `node.tar`, `go.tar` and `rust.tar`; they are
not committed or deployed. The smaller native functional scope and retained Go
debug symbols are described below.

## Declared optimization allowance

Before final measurement, allow one focused Node catch-up query improvement and
at most two additional changes justified by observed costs. Do not change the
fixture, correctness oracle, rate limits, durability, recipient counts, or
capacity thresholds. Record both adopted and rejected candidates. The allowance
excludes instrumentation, packaging, tests, and reporting; record elapsed effort
separately. Stop tuning after the final source freeze.
The focused Node query implementation and regression checks took approximately
15 minutes of elapsed agent work. No additional algorithm changes were adopted.
The final sequential replay protocol ran for 55.89 minutes; packaging, transport
checks, documentation and review are separate engineering effort. This is an
elapsed local experiment record, not an estimate of a production rewrite.

Retain the existing primary RAM metric: maximum cgroup-v2 `memory.peak` over a
complete replay in a fresh container, including coordinator, worker, SQLite,
filesystem cache and kernel charges. Compare medians of three wall runs and
report ranges and worst peaks. Each container has one CPU, 512 MiB and no swap.
Virtual runs gate behavior only. No benchmark runs overlap. Curl transport is a
separate controlled loopback exercise with its own process and cgroup accounting;
its peak must not be silently added to or omitted from the replay boundary.

Production deployment remains unchanged. Local AMD64 measurements cannot establish
Raspberry Pi performance or a complete 512 MB machine budget.

## Reproduce

Use the pinned Node 24.18.0 measurement image and the Go/Rust toolchains in the
[Go](go-replay-slice.md#reproduce) and [Rust](rust-replay-slice.md#reproduce)
build instructions. The Rust container must explicitly set
`-w /repo/experiments/rust-replay` when using a pre-existing local build image.
Build and test both native binaries before measuring; never run builds or other
benchmarks alongside resource runs. No new application dependency is introduced.

```bash
# Refuse existing output directories. All six virtual behavior/recovery gates
# finish before the repeated resource protocol starts. Keep sources unchanged.
node experiments/runtime-comparison/run.js /tmp/comparison-results \
  --go-binary /tmp/arm-rental-go-build/replay \
  --rust-binary "$PWD/experiments/rust-replay/target/release/rental-replay"

# Revalidate every raw result and regenerate the resource/capacity comparison.
node experiments/runtime-comparison/report.js \
  --node /tmp/comparison-results/node \
  --go /tmp/comparison-results/go \
  --rust /tmp/comparison-results/rust > /tmp/comparison-summary.json

# Build the minimal Node production target and package the exact measured native
# binaries. Caches are the ones populated by the pinned toolchain builds.
node experiments/runtime-comparison/artifacts.js /tmp/comparison-artifacts \
  --go-binary /tmp/arm-rental-go-build/replay \
  --rust-binary "$PWD/experiments/rust-replay/target/release/rental-replay" \
  --go-mod /tmp/arm-rental-go-mod \
  --rust-registry /tmp/arm-rental-rust-registry
node experiments/runtime-comparison/smoke-artifacts.js /tmp/artifact-smoke.json
scripts/smoke-production-runtime-image arm-rental-comparison-node:local

# Separate transport measurements, after replay/build activity has stopped.
# The same exact curl binary is present in all three packaged images.
for repeat in 1 2 3; do
  docker run --rm --network none --no-healthcheck --cpus 1 --memory 512m --memory-swap 512m \
    --read-only --cap-drop ALL --security-opt no-new-privileges \
    --tmpfs /tmp:rw,nosuid,size=64m \
    -v "$PWD:/app:ro" -w /app arm-rental-comparison-node:local \
    node experiments/runtime-comparison/transport.js \
    > "/tmp/curl-transport-${repeat}.json"
done
```

The measurement harness still runs a virtual check before the three wall runs
for each population. Those additional checks do not replace the initial six
cross-runtime gates. Every replay creates fresh state and runs sequentially.
The independent oracle rejects wrong delivery order, payloads, classifications,
acknowledgements and recovery; virtual results never contribute performance
estimates. The report recalculates capacity from observations instead of trusting
a stored success label. A 25% median RAM reduction is necessary but insufficient:
every 500-recipient normal capacity run must pass, and every 1,000-recipient
stress run must meet memory, routine progress and fairness requirements. Stress
catch-up may take longer. Failed individual runs remain visible.

## Optimization decisions

The retained initial Node results spent about 94/191 seconds classifying
catch-up at 500/1,000 recipients. Both native prototypes already avoid decoding
and preparing unchanged classified history. Node's transaction profile now records
operation count, changed rows and duration by phase, exposing the work behind
that cost without a profiler or forced GC in the measured run.
These transaction counters continue through preparation for the next crawl:
the seed insertion appears under `seed`, and monitoring-answer writes under
`catchup-store`. Crawl wall/CPU timing ends earlier, at crawl completion; do not
treat those inter-crawl transaction profiles as identical timing windows. The
catch-up preparation/classification and acknowledgement profiles themselves are
within the measured catch-up crawl.

Adopt the transferable query change in Node: leave skipped decisions and
unchanged notified payloads out of full-history classification; retain
unclassified history, matching filtered history, and notified cards with source
updates. Decode the inventory once per crawl and retain at most eight normalized
filter match sets. Clear the inventory and sets with delivery batches. SQL joins
still inspect history; this is not a constant-time catch-up claim. Changed
source and durable pending-work processing stay incremental.

The first narrower attempt incorrectly assumed that an unchanged filter
fingerprint made every old filtered decision irrelevant. An existing integration
test disproved that: a user can widen filters, decline immediate delivery, then
later request history. The adopted version preserves those matching filtered
rows. Another subtle case is an inventory consisting entirely of prior terminal
decisions: initial selection must still complete, so inventory presence is
reported separately from candidate count. Existing integration tests and the
full shared replay remain the behavior boundary.

Evaluate but reject a parser replacement: it would narrow Node's general List.am
support toward the prototypes' fixture-only parsers and does not address the
observed repeated history cost. Evaluate but reject a schema/representation
rewrite: all three already use compact decisions, while integer IDs and narrower
native schemas partly explain different database/cache sizes. Migrating Node's
public state contract would exceed this bounded experiment. Node already reuses
prepared SQL statements. No durability relaxation, acknowledgement batching,
rate-limit increase, timer busy-wait, or workload reduction is adopted. Go and
Rust algorithms remain unchanged; their added memory-stat snapshots are
instrumentation only. This stops within the declared allowance.

The native retry-priority scheduler is another implementation difference, not
evidence of a language advantage. Node's scheduler also integrates production
recipient barriers, cancellation and authorization checks. No transplant of
the fixture-specific event loop is attempted after the source freeze. Faster
classification tightens the shared first-progress deadline, so the final report
retains Node fairness failures instead of crediting the removed classification
delay as additional scheduling allowance.

## Accounting and artifact scope

Process RSS includes the language runtime, SQLite and allocator pages. Node's
heap/external fields and Go's allocated managed heap are reported separately in raw
snapshots; they are not interchangeable with committed/runtime-reserved memory.
Rust has no managed heap counter here. None of these measurements can separate
SQLite from all other native allocations exactly. Do not label RSS minus live
managed heap as “SQLite memory.” `memory.stat` snapshots expose charged anonymous,
file/cache and kernel memory; these counters are overlapping/hierarchical in
places and must not all be summed. Snapshot attribution does not identify the
composition of a short-lived cumulative cgroup peak.

The primary metric measures charged memory, not every physical page accessible
to the process. Linux assigns memory ownership to the cgroup that first
instantiates it, so already-shared image/source cache can be charged elsewhere.
No host cache flush or forced GC is used, and fresh databases are created for
every run. This is an attribution limit of the declared metric, particularly
when extrapolating to an otherwise empty machine. See the kernel's
[memory ownership documentation](https://cdn.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html#memory-ownership).

The entire replay cgroup includes the Node coordinator for every language,
fixture generation and verification, SQLite/WAL cache, and the live worker.
Native seeding and Node's separate seed process have different startup boundaries.
The summary aligns idle at the first unchanged phase after seeding/bootstrap
for all three runtimes, then uses the three subsequent unchanged phases for
steady values. Raw process-open samples remain available but are not comparable
startup points. These are explicit observed points,
not isolated language-runtime overhead. Verification algorithms and the native
schemas/drivers differ, so total replay CPU cannot be interpreted as language
speed alone.

Curl is measured separately through twenty sequential loopback requests per
fresh container, with two-second spacing, a 100 ms fixture-peer delay, exact-body
hash checks and cookie persistence. Sampling observes the actual curl child's
RSS high-water mark while alive. Whole-container peak and CPU include the Node
fixture peer, curl and cache. The local HTTP exercise does not model production
TLS handshakes, remote network delays, concurrent delivery, or every response
size. Report it alongside the replay, never as zero overhead and never by adding
mutually exclusive phase peaks to claim a measured combined peak.

Artifacts retain curl, certificates, shared-library closure, account/resolver
configuration and notices. The native roots deliberately retain the minimal
Node root's conservative common-library inventory, but remove Node itself and
all application code/npm dependencies. The exact measured native binaries are
copied into those roots. Smoke tests exercise both unclean exit and resume inside
the actual unprivileged, offline, read-only native images and rerun the shared
oracle. Node uses the existing production runtime smoke. Saved layer bytes and
unpacked layer-tar bytes are measured as in the prior minimal-image comparison;
raw uncompressed Docker layers are additionally gzip-compressed at level 9 and
labeled as normalized estimates. These figures do not measure unique host disk
usage or imply proportional RAM savings. Local image archives remain build
outputs rather than source-controlled binaries.
Go retains the symbols/debug information of the documented `go build -trimpath`
command; Rust uses its existing stripped release profile. These are the exact
measured binaries, not a claim that both artifact sizes are fully minimized.
Artifact manifests retain source hashes in addition to the Git revision, so a
build made from an uncommitted experiment tree is identified explicitly.

## Verification

The final pinned Node 24.18.0 suite passes **426/426 tests**, with **94.57% line**
and **88.23% branch coverage**. ESLint, Prettier and the production deployment
contract validator pass. Go tests, vet and the release build pass with Go 1.27.1;
Rust's eight tests, formatting, Clippy with warnings denied and release build
pass with Rust 1.94.0. The report CLI rejects corrupted delivery order, different
observed resource limits and a mislabeled runtime. All final raw reports were
revalidated, and measured/packaged source hashes still match the final source.
Independent Standards and Spec reviews against `0f099af` found no actionable
findings in implementation commit `a5ab8e5`.

## Local and ARM limitations

Measurements run on the existing x86-64 KVM host with Docker overlayfs and ext4
backing storage, not on a Pi. Per-run manifests retain CPU, disk, kernel, limits,
image IDs, source hashes and native binary hashes. Builds run outside the
512 MiB measurement boundary. The local Docker builder advertises only
`linux/amd64`, `linux/amd64/v2` and `linux/amd64/v3`; ARM execution is unavailable.
Go's SQLite driver uses cgo, and Rust's bundled SQLite uses C compilation, so
cross builds require the target C toolchain/linker as well as the language target.
An ARM binary and its native/curl dependency closure must be rebuilt for that
architecture; copying the AMD64 executable into an ARM image is not validation.
No ARM artifact, ARM execution, or Pi performance is claimed here.

The prototypes still omit bot conversations/polling, live source/CBA handling,
channel delivery, migrations, backups, health/alerts, and production shutdown
integration. They therefore have a smaller functional and artifact scope than
Node. OS, Docker daemon/supervision and full-machine lifecycle headroom remain
outside the application-container measurement. The final lifecycle assessment
must evaluate those missing pieces; this comparison neither establishes a
512 MB whole-machine fit nor authorizes deployment or a rewrite.

# Native service-only replay

Issue [#36](https://github.com/monkeysees/arm-rental/issues/36) measures the
unchanged Go and Rust replay workers with fixture export, coordination and the
independent oracle outside the service cgroup. This is a separate boundary from
[the original runtime comparison](runtime-comparison.md), whose protocol and raw
results remain unchanged. All work stays on `experiment/22-runtime-comparison`.
Production runtime, deployment and state are untouched.

## Reproduce

Use the existing native images built by the [comparison artifact commands](runtime-comparison.md#reproduce).
The runner checks the packaged binary against the original final comparison's
SHA-256 and checks native sources against that binary's recorded source hashes.
Rebuild those exact sources with the documented pinned toolchains if images are
missing. This experiment deliberately does not accept a different native worker.

For later experiments such as [the Rust storage policy](native-storage-policy.md),
`--image IMAGE --native-baseline FILE` selects an explicitly identified candidate.
The JSON file must contain `binarySha256` and native `sourceHashes`; the launcher
checks the image executable and current native sources against them. Omitting
these options retains the original comparison baseline. New reports also sample
database/WAL file lengths and cgroup `io.stat` from outside the service. Those
250 ms samples can miss short peaks; native storage observations cover known
transaction boundaries separately. Original #36 reports remain unchanged.

Prerequisites: local Linux Docker Engine with cgroup v2, host PID/cgroup visibility,
GNU `time`, `getconf`, a C compiler supporting static linking, and Node 24.18.0.
Run from the repository root. Docker socket access is required for the external
harness to start its isolated sibling service; do not use an untrusted harness.
The helper is built before measurement, on the same architecture as the images.
No new application or npm dependency is introduced.

```bash
gcc -std=c11 -O2 -static -Wall -Wextra -Werror \
  experiments/service-replay/hold.c -o /tmp/arm-rental-service-holder

# Live CLI regression: fresh service/harness containers, unclean exit and resume,
# independent oracle, then corrupted output/accounting rejection.
SERVICE_REPLAY_HOLDER=/tmp/arm-rental-service-holder \
  node --test test/service-replay.test.js

# Run these sequentially with no competing tests, builds or benchmarks.
# Each output directory must be new. Each command runs 500 recipients,
# one virtual gate and three fresh wall repeats.
/usr/bin/time -v -o /tmp/go-service-launcher.txt \
  node experiments/service-replay/run.js /tmp/go-service-results \
  --runtime go --holder /tmp/arm-rental-service-holder \
  --memory-bytes 536870912 --users 500
/usr/bin/time -v -o /tmp/rust-service-launcher.txt \
  node experiments/service-replay/run.js /tmp/rust-service-results \
  --runtime rust --holder /tmp/arm-rental-service-holder \
  --memory-bytes 536870912 --users 500

node experiments/service-replay/report.js \
  /tmp/go-service-results/*/result.json \
  /tmp/rust-service-results/*/result.json > /tmp/service-summary.json
```

`--memory-bytes` accepts an exact integer, at least Docker's 6 MiB minimum and
aligned to the host page size; other values are refused instead of silently
rounding the observed limit. `memory.max`, `memory.swap.max=0` and one CPU are
verified from the actual service cgroup and both workers. The fixed original
512 MiB capacity threshold remains unchanged even when another service limit is
selected. A four-recipient diagnostic at 268,435,456 bytes exercises this option.
`--users 4 --mode virtual` is diagnostic only; `--users 500 --mode all
--repeats 3` is the default full protocol. This task’s final requested validation was narrowed
to 500 recipients; the reproduction commands above select that population. `--mode wall|virtual` and
`--repeats N` allow focused reruns without implying complete acceptance evidence.

The manifest retains exact Docker commands, image identities, host information,
source hashes and binary hashes. Each run retains the two raw worker JSONs,
stderr logs, full combined result, actual container configuration, process
observations and resource samples. Generated fixture hashes cover every HTML
page and manifest. Temporary SQLite state is deleted after container removal, including on failure,
so repeats do not accumulate large databases. Exported fixtures and reports stay
in the chosen output directory; delete it after archiving desired evidence.
Errors stop the protocol and retain completed evidence. Failed capacity verdicts
remain in successful behavior reports; they are not silently promoted to passes.
The report CLI reruns the oracle and recalculates capacity from observations.

## Accounting boundary

The native image runs a small static C holder as PID 1. It copies exported
fixtures from a read-only input mount into service-owned tmpfs, then sleeps.
Both native workers run sequentially with `docker exec` inside this same fresh
cgroup. Exercise exits uncleanly with code 23; resume opens the same fresh
SQLite database and verifies the acknowledged prefix and unsent suffix. Keeping
the cgroup alive preserves cache ownership and cumulative `memory.peak` across
that process interruption. The holder's memory/CPU and brief `runc init`
processes are included, not subtracted.

Service charges include the native runtime, SQLite/native allocations, fixture
tmpfs, database/WAL filesystem cache and kernel charges. The external harness
never opens SQLite state. The native workers retain their existing internal
integrity scans; the shared independent behavior/recovery oracle runs in the
external Node harness. Transport is the unchanged local simulation: no network,
Telegram, production state or real source traffic is used.

The external Node container has its own fresh one-CPU, 512 MiB, no-swap cgroup.
Its reported RAM peak, CPU, process RSS and `memory.stat` include fixture export,
Docker clients, coordination, sampling, result parsing and independent
verification through the final snapshot. Final report serialization, service
teardown and process exit follow that snapshot. The host launcher separately
performs setup, hashes and repeat verification: the saved GNU `time -v` output
accounts for that process and its Docker CLI children. Neither number includes
the Docker daemon, host OS or unrelated services. These separate peaks are not
simultaneous whole-machine RAM measurements and must not be added as such.

The harness reads the service cgroup from the host PID/cgroup namespaces and
rejects overlapping harness/service paths. Samples enumerate service process
commands: only the holder, native replay and Docker's transient `runc init` are
allowed. Both native stages must be observed; Node is forbidden. The original
native-image binary hash provides a separate check of the executed worker.
Sampling is every 250 ms for measured populations, 10 ms for four-recipient
diagnostics. It can miss short-lived processes and RSS peaks; this is observed
process evidence, not an adversarial process-execution audit. Native getrusage
high-water marks and the kernel's cumulative cgroup peak retain peaks between
samples. No forced GC or cache flush is used.

Idle is the first post-bootstrap unchanged phase; steady comprises the next
three unchanged phases, matching the original comparison's observation points.
They are phase snapshots, not a separately timed long idle workload. The final
service cgroup peak and CPU extend through both workers' output and exit.
Queue-age, classification, drain, restart-gap and fairness semantics are those
of the [unchanged native recovery contract](native-replay-recovery.md).
`memory.stat` exposes anonymous, file/cache, tmpfs and kernel attribution but
contains overlapping counters; do not sum all fields or label RSS minus heap
as SQLite memory. Snapshot composition does not identify every component of a
short-lived peak. Shared image/library pages may already be charged elsewhere;
copying fixtures into service tmpfs avoids borrowing fixture-export cache charges
but does not make host page-cache ownership disappear.

## Results and limits

Measurements are local x86-64 Docker results, not Pi or ARM performance. They
characterize the existing incomplete native prototypes, not production-ready
bot replacements. Conversation/polling, live source/CBA/curl transport, channel
delivery, migration, backup, health and supervision remain outside their scope.
The original whole-replay boundary includes Node fixture/coordinator/oracle work;
this new boundary excludes it. Cross-boundary differences are not runtime RAM
savings, speedups, or evidence of whole-machine capacity.

The [selection manifest](benchmarks/service-replay/selection.json) identifies all
eight retained 500-recipient results and the interrupted launcher. The
[summary](benchmarks/service-replay/summary.json) is regenerated by the report CLI;
full worker output and cgroup/process observations accompany every selected run.
All selected reports pass the independent oracle and accounting verifier.

At **500 recipients**, medians of three wall repeats are:

| Metric                                                 |            Go |          Rust |
| ------------------------------------------------------ | ------------: | ------------: |
| Service lifetime peak (MiB)                            |        182.86 |        170.58 |
| Service lifetime peak range (MiB)                      | 181.08–187.62 | 170.56–170.80 |
| Post-bootstrap idle (MiB)                              |        179.39 |        168.75 |
| Steady (median of three samples per run, MiB)          |        179.06 |        168.75 |
| Native process peak RSS (MiB)                          |         27.36 |         16.02 |
| Service cgroup CPU (s)                                 |         35.43 |          9.70 |
| External harness peak (MiB)                            |         38.12 |         36.14 |
| External harness cgroup CPU through final snapshot (s) |          0.47 |          0.43 |
| Catch-up complete wall (s)                             |         26.85 |         24.76 |
| Catch-up queue age p95 (s)                             |         25.45 |         23.67 |
| Resumed transport drain (s)                            |         16.44 |         15.39 |
| Full normal-capacity passes                            |           0/3 |           3/3 |

Both runtimes pass routine progress, classification, fairness and the fixed
512 MiB memory gate in all three normal runs. Go misses the unchanged
25.025-second catch-up target at 26.754–26.903 seconds; Rust passes at
24.685–24.770 seconds. Correct recovery does not turn Go's failed capacity
verdict into a pass. Process RSS is much smaller than charged service RAM;
fixture/database/cache and kernel attribution remains visible in the raw phase
snapshots and sampled `memory.stat`. These are prototype and boundary results,
not measured language-runtime savings or production/Pi capacity claims.

## Execution record

The retained validation covers 500 recipients: one virtual gate and three
wall runs for each native runtime. The coordinator removes each synthetic
database after final sampling, independent verification and container removal.
The outside-service report validates mode consistency and process errors.
Exact initial coordinator and report sources remain under `initial-source/`;
hashes distinguish the harness revisions used by the retained measurements.

Stopping the broad Rust launcher left the already running second 500-recipient
worker to finish and clean up normally. Its complete result is retained even
though the interrupted launcher's manifest ends at the preceding run. A separate
500-only invocation produced the third wall repeat. The interrupted launcher’s
GNU-time record ends at termination, so it is partial host-launcher accounting;
the completed worker's own separate harness cgroup accounting remains available.
The selection manifest identifies all results and these interruptions explicitly.

A four-recipient live check once rejected an unexpected startup process. Forty-five
subsequent short diagnostics and a live regression passed without reproducing it.
The guard remains fail-closed and now includes rejected command arguments in its
error message. This is not evidence that arbitrary short-lived processes cannot
escape sampling; the process-observation limitation above still applies.

## Verification

The final Node 24.18.0 suite passes **433/433 tests**, with **94.54% line** and
**88.20% branch coverage**. The report CLI regression and the live four-recipient
Docker regression pass. Regression checks reject wrong deliveries, Node in the
service, overlapping cgroups, incorrect limits, missing external CPU accounting,
binary mismatches and relabeled virtual results. Accounting and mode checks were
observed failing before their verifier fixes.

ESLint passes with `--ignore-pattern '.scratch/**'`; unqualified `npm run lint`
finds 14 existing errors in untracked `.scratch/` investigation files, which were
left untouched. Prettier and the production deployment-contract validator pass.
The static holder builds and passes GCC warnings-as-errors checks with GCC
12.2.0. JavaScript has no separate repository typecheck command; Go and Rust
source/binaries are unchanged from the verified original comparison builds.
GNU Time came from Debian's `time` 1.9-0.2 package, extracted into a task-local
`/tmp` directory because the host did not have `/usr/bin/time` installed.

Independent Standards and Spec reviews against starting commit `23596944` found
no remaining findings after the callback cleanup fix and a table rounding
correction. Spec review independently revalidated every selected report's hash,
metadata, oracle, accounting and documented capacity outcome. No production code,
deployment files or original comparison results changed.

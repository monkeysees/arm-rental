# Native bulk writes and WAL retention

Issue [#37](https://github.com/monkeysees/arm-rental/issues/37) bounds the
experimental Rust seed/import path. Production state, runtime and deployment
remain unchanged. All work belongs to `experiment/22-runtime-comparison`.

## Baseline and policy boundary

The starting implementation inserts 3,281,500 retained decisions (6,563 per
recipient) in one transaction. Its SQLite default 1,000-page automatic
checkpoint runs after commit; it cannot bound an active transaction. The initial
500-recipient profile observed a 79,050,472-byte WAL, retained through delivery,
and a 159,483,624-byte combined database/WAL peak. The decision table grows to
3,321,500 rows through the complete replay. No historical rows may be dropped.

Crawls commit listing revisions atomically. Classification commits the complete
recipient selection, including skipped/filtered decisions, before transport.
Each successful send commits one acknowledgement with `synchronous=FULL`.
Those boundaries are independent of seed batching and must remain intact.

SQLite's [checkpoint and journal-limit documentation](https://www.sqlite.org/pragma.html)
distinguishes automatic checkpoint thresholds, completed-checkpoint file reuse,
and truncation. A journal retention setting is not an active-WAL size cap.
Readers can prevent checkpoint completion; a bounded writer must detect that
condition instead of indefinitely accumulating WAL or claiming successful
truncation. Process RSS, SQLite's page cache, and kernel filesystem cache are
different accounting boundaries. Removing WAL bytes need not reduce lifetime
RAM peaks or evict cached database pages.

## Implemented policy

Seed decisions use at most 8,192 rows per transaction. The compact immutable
input record binds recipient count, timestamp and ordered retained/absent IDs;
a separate progress row commits with each batch. A crash before commit rolls
back both rows and progress; a crash after commit resumes at the next row. The
input and mutable progress live in separate tables so updating progress does
not rewrite the full input document. Completed imports are idempotent until
exercise claims them; a consumed import cannot start another exercise.

Each connection explicitly selects WAL, FULL synchronization, a 1,000-page
automatic checkpoint, a 4 MiB retained-journal limit and a five-second busy
timeout. Explicit TRUNCATE checkpoints run before the next seed batch when the
WAL reaches 4 MiB, at seed completion, after large atomic crawl/classification
commits, and after a durable acknowledgement if its WAL reaches that threshold.
Statements and transactions have finished before these checkpoints. A busy
checkpoint stops further writes and reports its busy flag, page counts and
elapsed time. The already committed transaction remains durable.

The 4 MiB threshold is deliberately not a promised hard maximum. A transaction
can grow past it, particularly classification that touches pages throughout the
retained history. Automatic checkpoint work is included in commit latency;
explicit checkpoint latency is reported separately. The new storage observations
also expose transaction row counts, seed batch count, write time and WAL bytes.
They do not reinterpret sampled WAL or memory values as continuous maxima.

## Resumable seed commands

The standard `--stage exercise` still requires a new database and performs the
entire replay. The separate experimental seed commands support bulk-import
recovery before delivery begins:

```bash
node experiments/node-replay/export.js /tmp/native-storage-fixtures
replay=experiments/rust-replay/target/release/rental-replay
"$replay" --fixtures /tmp/native-storage-fixtures --database /tmp/native-seed.sqlite3 \
  --users 500 --stage seed --seed-stop before-commit:8192
# Expected exit 25, without SQLite destructors. Continue the same import:
"$replay" --fixtures /tmp/native-storage-fixtures --database /tmp/native-seed.sqlite3 \
  --users 500 --stage seed-resume
"$replay" --fixtures /tmp/native-storage-fixtures --database /tmp/native-seed.sqlite3 \
  --users 500 --stage exercise-seeded
# Expected exit 23 at the existing delivery interruption boundary.
"$replay" --fixtures /tmp/native-storage-fixtures --database /tmp/native-seed.sqlite3 \
  --users 500 --stage resume
```

`--seed-stop POINT:ROW` is a diagnostic process exit at `before-commit`,
`after-commit`, or `after-checkpoint`; ROW is the exclusive committed/attempted
offset, and the checkpoint stop is at the complete import. It is accepted only
by `seed`/`seed-resume`. `seed` refuses existing files. `seed-resume` requires a
recognized, matching, unconsumed import, and `exercise-seeded` additionally
requires completion. Setup failures before the durable import record exists
are refused rather than guessed to be resumable state. These commands use
synthetic experimental state and are not production migration or restore tools.

## Measurements and acceptance

The [before manifest](benchmarks/native-storage/before/manifest.json),
[after manifest](benchmarks/native-storage/after/manifest.json), and
[numeric summary](benchmarks/native-storage/summary.json) retain one virtual
replay and three independent wall repeats per implementation. All eight runs
passed the unchanged independent oracle; all six wall runs passed capacity,
fairness and recovery gates. Each completed replay retained 3,321,500 decisions
and zero pending rows. Source, executable, image, fixture and output hashes are
recorded. The baseline uses starting commit `619b55f`; the candidate contains
the policy described above. Original #22/#36 measurements are unchanged.

Both groups used fresh service-only cgroups with one CPU, 536,870,912 bytes
(512 MiB), no swap, and offline synthetic fixtures. The external Node harness,
Docker daemon and host OS are outside the service. The static holder, native
workers, SQLite, database/WAL cache and kernel charges are inside. Runs were
sequential with no concurrent tests/builds. These are local x86-64 KVM/Docker
observations, not Pi performance or whole-machine/lifecycle feasibility.

Values are medians of three wall runs:

| Metric                            |        Before |         After |
| --------------------------------- | ------------: | ------------: |
| Service lifetime peak (MiB)       |        170.90 |        101.91 |
| Peak range (MiB)                  | 170.85–170.90 | 101.67–101.92 |
| Post-bootstrap idle (MiB)         |        169.07 |         91.13 |
| Idle file/cache charge (MiB)      |        152.49 |         77.05 |
| Idle anonymous charge (MiB)       |         11.40 |         11.30 |
| Idle kernel charge (MiB)          |          4.93 |          2.70 |
| Process peak RSS (MiB)            |         16.16 |         16.00 |
| Observed WAL peak (MiB)           |         75.39 |          8.55 |
| Sampled database + WAL peak (MiB) |        152.10 |         83.60 |
| Final database (MiB)              |         76.71 |         76.77 |
| Seed wall time (s)                |          2.89 |          3.49 |
| Service CPU (s)                   |          9.59 |          9.93 |
| Cgroup writes (MiB)               |        344.56 |        359.80 |
| Catch-up classification (s)       |          1.37 |          1.38 |
| Complete catch-up (s)             |         24.77 |         24.77 |
| Catch-up listings/s               |        161.47 |        161.49 |
| Catch-up queue age p95 (s)        |         23.69 |         23.69 |

The roughly 40.4% service peak reduction comes primarily from file/cache
charges, not a reduced Rust heap. The 64 KiB database increase holds import
metadata. Seeding is about 20.8% slower and measured writes rise about 4.4%;
those are costs of additional durable commits and checkpoint work, not hidden
regressions. Memory remains above the later 75 MB/50 MB goals.

Seed writes now use 401 transactions. Median row-writing time is 2,740 ms;
aggregate commit time is 740 ms, including SQLite's automatic checkpoints.
All explicit checkpoints together take a median 12.47 ms across a complete
replay. The unchanged baseline has no explicit checkpoint timing: automatic
checkpoint work is included in its 2.89-second seed and phase timings, so this
evidence does not isolate the baseline's internal checkpoint cost. Classification
still atomically writes 4,000 decisions for each routine phase, 20,000 for
catch-up, and 16,000 for interrupted delivery. Its largest observed WAL is
8,969,272 bytes; the seed's is 4,342,512 bytes. A 250 ms file sampler misses some
short peaks, so the candidate WAL maximum also uses native transaction-boundary
observations. The combined database/WAL figures remain sampled lower bounds.
Read I/O was zero in these warm-image, newly generated local-state runs; this is
not evidence about cold-storage latency. `memory.stat` counters overlap and are
not summed as independent memory buckets.

The [manual recovery record](benchmarks/native-storage/recovery/manifest.json)
records repeated process exits before a batch commit, after a commit, and after
the final checkpoint at 500 recipients. The import completed, repeated completion
wrote zero rows, and its subsequent exercise/resume passed the full independent
oracle. Partial imports cannot exercise; changed recipient counts and reuse of
consumed imports are rejected. A held read transaction prevented TRUNCATE:
the writer stopped after 5,006 ms at 4,198,312 WAL bytes, reporting busy=1.
After the reader closed, import resumed from its durable progress marker.
The busy-reader recovery also completed exercise/resume and passed the same
independent oracle; its combined result is retained beside the crash result.

The existing Node 24.18.0 suite passes 433/433 tests with 94.54% line and
88.36% branch coverage. All eight Rust executable tests, Cargo check, Clippy
with warnings denied, formatting, and the production-contract validator pass.
ESLint excludes the pre-existing untracked `.scratch/` directory; generated Rust
`target` output is now excluded by configuration to avoid racing Cargo's
temporary directories. New raw evidence is excluded from formatting to preserve
recorded hashes. The production validator used ShellCheck 0.11.0 extracted from
its existing local image into a task-local tools directory.

## Reproduce the comparison

Build the Rust executable with the pinned toolchain commands in
[the Rust slice](rust-replay-slice.md#reproduce). Package that binary on top of
the existing comparison image without changing its dependency closure:

```dockerfile
FROM arm-rental-comparison-rust:local
COPY replay /usr/local/bin/replay
```

Use a new build directory containing this Dockerfile and the compiled binary
named `replay`, then build an explicitly named image. Create a baseline JSON
containing the SHA-256 of that binary and a `sourceHashes` mapping for files
under `experiments/rust-replay/`; the retained `native-baseline.json` files show
the exact structure. The launcher's checks reject a mismatched binary or source.
Keep those sources fixed throughout measurement:

```bash
node experiments/service-replay/run.js /tmp/native-storage-results \
  --runtime rust --image arm-rental-storage-after:local \
  --native-baseline /tmp/native-storage-baseline.json \
  --holder /tmp/arm-rental-service-holder --users 500 --mode all --repeats 3
node experiments/service-replay/report.js /tmp/native-storage-results/*/result.json
```

The manifests retain the actual Docker commands and host/image identity. To
rebuild the before side, use the Rust sources at `619b55f` with the same pinned
toolchain and this instrumented external sampler. The original comparison image
is only the runtime dependency base; each candidate's identified executable
replaces `/usr/local/bin/replay`. This does not claim a minimal-image redesign.

## Transfer to Go and Node

Go's experimental `Store.seed` also uses one transaction for all 3,281,500 rows,
with FULL durability and implicit default checkpointing. The frozen 500-recipient
comparison recorded a 79,050,472-byte retained WAL. The same bounded import and
explicit checkpoint principles apply, but safe chunking also needs persistent
progress, input binding and recovery gates; merely splitting its existing loop
would leave partial state that the current exercise command cannot resume.

The optimized Node fixture worker likewise wraps seed decisions in one
`replay_seed` transaction. Its frozen comparison recorded an 85,045,072-byte WAL.
Node then closes and checkpoints that seed-stage process before exercise;
retained WAL does not persist across those stages as it does in the native
workers. Batching could still reduce the seed-stage peak, but requires a new
fixture-import progress protocol and must preserve recipient selection
initialization. Production already has explicit checkpoint failure reporting
and maintenance checkpoints in `src/sqlite-database.js` and `src/maintenance.js`.

This ticket does not transplant Rust's experimental schema or fixture bootstrap
into either implementation. Their measured seeds are not a production import
API. Retaining their frozen implementations avoids presenting unverified partial
initialization as a safe optimization; separate adaptations must preserve those
different initialization and shutdown contracts. Production transactions and
acknowledgements are not candidates for blanket splitting or weaker durability.

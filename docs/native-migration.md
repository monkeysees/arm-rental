# Offline native schema migration

Issue [#41](https://github.com/monkeysees/arm-rental/issues/41) adds an experimental
Rust `migrate` command on `experiment/22-runtime-comparison`. It requires no Node
runtime. Production schemas, deployment and state are unchanged.

## Supported transition

The source is **version 0** (`PRAGMA user_version=0`, `application_id=0`): the
exact unversioned Rust schema at commit `d75fa00a8d277f5a572a239667b1dc8b17d90263`,
including its covering revision index and seed/recovery metadata. Only the frozen
interrupted exercise boundary with 4 diagnostic or 500 recipients is supported.
Incomplete imports, completed resumes, other old schema shapes, unknown objects,
wrong identities and newer versions fail before output creation.

The target is **version 1**, application ID `0x5252504c`. Its rebuilt `decisions`
table enforces nonnegative user/listing IDs, status codes 0–3 and positive source
revisions with SQLite CHECK constraints. All five decision fields retain their
values and meanings; listing payloads, seed progress, history fingerprints and
recovery timestamps are copied unchanged. New native databases use version 1.
Runtime opens validate the version, identity and exact schema before enabling
WAL or writing state. Existing version-0 databases require explicit migration;
there is no automatic upgrade or fallback. Backup/restore/validate now require
version 1; historical #40 measurements describe their pre-versioned executable.

## Operator sequence and recovery

Stop the experimental service and wait for its process to exit. Run commands
sequentially in operator-controlled directories on a local filesystem supporting
hard links and directory fsync. No service-stop or mutual-exclusion automation is
provided. Concurrent writers or hostile path replacement are outside this offline
contract. Preserve the old executable and source database plus any WAL/SHM files.

```bash
replay migrate --database /state/v0.sqlite3 --output /state/migrated-001
replay validate --database /state/migrated-001/state.sqlite3
replay --fixtures /fixtures --database /state/migrated-001/state.sqlite3 \
  --users 500 --mode virtual --stage resume
```

Configure the new service to use only the published `state.sqlite3` after success.
Never start it against `incomplete.sqlite3`. The command never replaces the source
or an existing destination. Repeating with the same output directory fails safely;
retry with a fresh directory. An already version-1 input is rejected as an
unsupported source version, without creating output. To roll back before the new
service advances state, resume the original source with the retained old binary.
There is no version-1-to-0 downgrade or reconciliation of post-cutover writes.

A read-only source transaction pins a consistent snapshot including committed WAL.
SQLite backup copies 128 pages at a time into a mode-0600 temporary database in a
new mode-0700 directory. The copy switches to DELETE journaling, then one transaction
rebuilds decisions through keyset batches of at most 8,192 rows. Row counts and
primary-key lookups compare every decision field before dropping the old table.
The schema version and identity commit with the rebuild. Schema, SQLite integrity,
history and acknowledgement/pending-prefix checks run again before the closed
file is fsynced and published through a non-overwriting hard link. Directory fsync
precedes temporary-name removal. No intermediate database is published.

`--stop` injects process death with exit 26 at `before-copy`, `during-copy`,
`after-copy`, `during-migration`, `before-migration-commit`, `after-migration`,
`before-publish` or `after-publish`. Before publication, retain the failed directory
for inspection and retry from the intact source into a new directory. An
interruption before copying creates no directory. After publication, validate the
final file; its temporary name may remain as a hard link to the same inode.
Process-death tests do not establish physical power-loss or disk-failure behavior.

## Reproduction and resource boundary

Build the current binary with the pinned Rust 1.94.0 toolchain and Cargo.lock as
in [Rust replay](rust-replay-slice.md#reproduce). Build the legacy input generator
from the fixed source revision in a separate ordinary directory:

```bash
mkdir -p /tmp/native-v0-source
git archive d75fa00a8d277f5a572a239667b1dc8b17d90263 experiments/rust-replay \
  | tar -x -C /tmp/native-v0-source
docker run --rm -w /repo/experiments/rust-replay \
  -v /tmp/native-v0-source:/repo \
  -v /tmp/arm-rental-rust-cargo:/usr/local/cargo/registry \
  arm-rental-rust-replay-build cargo build --locked --release
node experiments/native-migration/check.js /tmp/native-migration-acceptance \
  "$PWD/experiments/rust-replay/target/release/rental-replay" \
  /tmp/native-v0-source/experiments/rust-replay/target/release/rental-replay \
  arm-rental-native-service:local
```

Use Node 24.18.0 for the **external** fixture exporter, disk sampler and independent
oracle. No Node executes inside the measured native containers. Each operation
runs separately with one CPU, 512 MiB RAM, no swap, a read-only root filesystem
and no network. The image supplies the native library closure, and the candidate
binary is mounted read-only. The manifest records exact commands, image identity,
source/binary/harness hashes, host and per-operation disk samples. Source fixtures
are reproducible through the checked-in exporter; source state comes from the
actual old executable, not a database relabeled as an older version.

Migration streams through two 512 KiB connection caches. It does not materialize
decisions in RAM; the rebuild's transaction is atomic but its insert statements
are bounded. Primary-key comparison avoids an unbounded EXCEPT temporary table.
The destination retains freed pages from the old table; no VACUUM is performed.
Allow space for source + source WAL + destination (including both tables during
rebuild) + a source-sized rollback journal + 4 MiB scratch margin. The report's
`peakDiskBudgetBytes` expresses this logical estimate, not a capacity reservation;
allow extra space for filesystem blocks, metadata and retained backups.

The external sampler observes logical database/WAL/temporary sizes every 10 ms,
counts hard links once and reports per-category maxima separately from the maximum
total. SQLite scratch files are directed to the sampled directory. Short peaks,
unlinked open files and filesystem metadata can escape sampling. Failed and retry
databases are removed only after their checks; JSON evidence remains. Process RSS
high-water mark, main-thread CPU, wall time and fresh-container cgroup memory peak
are reported separately. File-cache charges may remain in ancestor cgroups, so
these are local x86-64 observations, not whole-machine or measured Pi capacity.

The independent oracle checks delivery order, payloads, decisions, acknowledgements
and drained/returning phases after migration and every retry. An external streaming
SHA-256 comparison verifies every row of all six persisted tables. The acceptance
also proves byte-for-byte preservation of source database/WAL until the explicit
old-binary rollback replay, and rejects deliberately reordered oracle output.

Production Node-to-Rust state conversion, production schema migration, arbitrary
native database states, online migration, downgrade after new writes and physical
power-loss acceptance remain migration gaps outside this ticket.

## Acceptance record

The retained [manifest](benchmarks/native-migration/acceptance.json) records all
**39 passing operations**, including eight process-death boundaries, eight fresh
migration/replay retries, validation of the published result, safe rejection of
reused destinations/current-version input, and actual rollback replay using the
old executable. The [combined replay](benchmarks/native-migration/result.json)
and every retry pass the independent oracle. Its negative control rejects
reordered delivery output.

All **3,321,500 decisions**, **5,522 listing payloads**, seed metadata and recovery
metadata have identical streaming SHA-256 fingerprints before and after migration.
The interrupted state's **1,000 acknowledged sends** and **3,000 pending sends**
are preserved; resume drains only the suffix, and unchanged/returning phases send
nothing. Source database and WAL bytes remain unchanged through all migration,
rejection and retry commands, until the deliberately invoked rollback replay.

| Migration measurement                                            |               Observed value |
| ---------------------------------------------------------------- | ---------------------------: |
| Wall time                                                        |                      7.948 s |
| Main-thread CPU                                                  |                      7.839 s |
| Process peak RSS                                                 |                    6.871 MiB |
| Fresh cgroup memory peak                                         |                  157.871 MiB |
| Source database / WAL                                            | 80,412,672 / 4,124,152 bytes |
| Published destination database / WAL                             |        158,130,176 / 0 bytes |
| Sampled peak database category (source + published destination)  |            238,542,848 bytes |
| Sampled peak WAL category                                        |              4,124,152 bytes |
| Sampled peak temporary category (unpublished database + journal) |            158,312,168 bytes |
| Sampled maximum total, including retained reports/SHM            |            242,978,014 bytes |
| Conservative per-operation logical disk budget                   |            327,273,976 bytes |

Category peaks occur at different times and must not be added together. Temporary
bytes include the unpublished database; its final hard link is counted only once.
The larger target retains freed old-table pages. The main migration measurement
ran without concurrent test suites; these are individual local observations, not
repeated throughput or Pi benchmarks. The measured executable and native source
hashes correspond to implementation commit `0c49edd`; the exact legacy generator
was built from `d75fa00` using the pinned toolchain.

Acceptance initially exposed a source-preservation bug: opening rejected legacy
state read-write allowed SQLite to checkpoint its WAL on connection close. The
fix validates existing state read-only before opening it for writes. The retained
run includes this fix, and a focused process-death regression verifies unchanged
source database/WAL bytes on a rejected newer version.

### Standards

No findings. The independent review confirmed documented standards, explicit
persisted-data compatibility, focused integration tests and shared harness reuse.

### Spec

No findings. The independent review confirmed the supported transition,
interruption/retry boundaries, source-preserving publication and bounded native
implementation. Closure was held until all acceptance operations completed.

Review totals: **0 Standards findings; 0 Spec findings**.

Final verification passes all **433 Node tests** with **94.54% line / 88.22%
branch coverage**, all **22 Rust integration tests**, Cargo check across all
targets, Clippy with warnings denied, Rust formatting, ESLint (excluding the
pre-existing untracked `.scratch/`), Prettier and the production deployment
contract validator. Archived raw JSON is byte-identical to the acceptance output;
source, executable and harness hashes were rechecked. Independent Spec follow-up
reran the archived oracle and confirmed the documented resource values.

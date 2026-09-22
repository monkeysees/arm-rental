# Offline native backup and restore

Issue [#40](https://github.com/monkeysees/arm-rental/issues/40) adds `backup`,
`validate` and `restore` to the experimental Rust executable on
`experiment/22-runtime-comparison`. Production recovery and state are unchanged.
The commands require no Node, shell, live network, Telegram or production files.

Stop the experimental service and wait for its process to exit before maintenance.
These commands do not stop it automatically. Run backup, validation and restore
sequentially; restart only after maintenance finishes. SQLite's read transaction
pins a consistent source snapshot, including committed WAL contents, but overlapping
writers can retain WAL indefinitely and invalidate the stopped-service disk budget.

Only the exact current native schema at the frozen shared replay contract's
interrupted exercise boundary (4 diagnostic or 500 recipients) is supported.
A completed resume has no pending suffix and is rejected. Incomplete seed imports, older schemas, production databases and unknown
schema objects are rejected. Current commands require native schema version 1;
use the explicit [version-0 migration](native-migration.md) for the supported
older interrupted state. The historical evidence below used the pre-versioned
#40 executable. Validation checks SQLite
integrity, schema, decision domains, recovery metadata and the existing streaming
historical-decision fingerprint. It also checks every active acknowledgement and
pending decision against the frozen contract, including swaps that preserve totals.
This is accidental-corruption checking, not a cryptographic authenticity check or
proof that every possible logical edit of listing payloads or recovery timestamps is valid.
The independent replay oracle supplies the delivery/recovery acceptance check.

## Commands

Build with Rust 1.94.0 and the pinned offline registry as described in
[Rust replay](rust-replay-slice.md). Enablement of the existing rusqlite `backup`
feature adds no crate or version. Use the same executable for all commands:

```bash
replay backup --database /state/source.sqlite3 --output /state/backup-001
replay validate --database /state/backup-001/state.sqlite3
replay restore --database /state/backup-001/state.sqlite3 --output /state/restored-001
replay --fixtures /fixtures --database /state/restored-001/state.sqlite3 \
  --users 500 --mode virtual --stage resume
```

The source and its existing sidecars must be regular files, not symlinks. Use
operator-controlled parent directories; hostile concurrent path replacement is
outside this offline tool's contract. Each output directory must be absent,
including on retry. It is created with mode 0700, and the database with mode 0600.
Existing directories, databases and unrelated contents are never overwritten.

The copy is written as `incomplete.sqlite3`, using SQLite's incremental backup API
in 128-page steps and 512 KiB page caches. It is converted to DELETE journal mode,
closed, validated and fsynced before a non-overwriting hard link publishes
`state.sqlite3`. The directory is fsynced before removing the temporary name.
Publication requires a local filesystem supporting hard links and directory fsync.
The two names share one inode and do not consume two full database copies.

For failure injection, add `--stop during-copy|after-copy|before-publish|after-publish`
to backup or restore. Exit 26 deliberately bypasses destructors. Before publication,
no `state.sqlite3` exists; never resume from the incomplete file. After publication,
the valid final file may coexist with its temporary hard link. Validate the final
file before use. Retain failed output for inspection and retry into a new directory;
remove only that known operation's abandoned directory when no process uses it.
Ordinary I/O failures follow the same retained-output policy. Process-death tests
do not establish physical power-loss behavior.

## Resource boundary and reproducible acceptance

The external harness requires Node 24.18.0 and Docker. It runs the native binary
in separate, mutually exclusive containers with one CPU, 512 MiB RAM, no swap,
no network and a read-only root filesystem. The existing native service image
supplies only the native library closure; the candidate executable is mounted
read-only. No Node executes inside any measured container.

```bash
node experiments/native-maintenance/check.js /dev/shm/native-maintenance-acceptance \
  /absolute/path/to/rental-replay arm-rental-native-service:local
```

The new directory retains fixtures, state, raw operation reports, combined oracle
result and an acceptance manifest with source/binary hashes and exact commands.
It exercises 500 recipients, preserves 3,321,500 decisions and 3,000 pending sends
through backup/restore, then resumes and independently checks the complete replay.
It also rejects a deliberately reordered oracle result, injects all four boundaries
for both copy commands, rejects destination reuse and verifies a fresh retry.
Focused Rust executable tests additionally reject truncated, incompatible,
history-corrupted and symlinked inputs without creating output.

Maintenance reports wall time, main-thread CPU time, process RSS high-water mark
and the current cgroup's kernel memory peak separately per command. These commands
are single-threaded; CPU includes validation and copying. Never add mutually
exclusive memory peaks. The external Node harness, Docker daemon, fixtures and
host OS are outside the native measurement. Warm file-cache charges can remain
with ancestor cgroups after earlier containers exit; a smaller validation peak is
not the whole resident-database budget. These are local x86-64 observations, not
Pi performance or repeated throughput measurements.

SQLite copies pages and streams history rows; it does not materialize the decision
table in RAM. Validation uses bounded SQLite caches and FILE temporary storage.
There are at most two full disk databases per copy operation: source and new output,
plus the source WAL/SHM, destination journal and filesystem overhead. The reported
`peakDiskBudgetBytes` is source database + source WAL + destination database + 1 MiB
scratch allowance for this schema/page size; it is not a filesystem free-space
reservation. Keep additional margin for block allocation and retained previous
backups. Do not overlap maintenance with writers. The harness samples logical file
sizes every 10 ms, counts hard links once, and separates database, WAL and temporary
bytes; sampling is a lower bound and reports exclude filesystem metadata. All
retained test outputs together need more space than one operation's budget.

The first diagnostic acceptance used tmpfs during host disk pressure. After
reclaiming build and scanner caches, final acceptance uses the host filesystem.
Neither process-death injection nor this single run establishes power-loss
recovery or Raspberry Pi storage latency. Using the example tmpfs destination
counts database storage against host RAM; select a disk directory to measure local
filesystem behavior.

## Acceptance record

The retained [manifest](benchmarks/native-maintenance/acceptance.json) records all
25 operations, exact container commands and binary/source hashes. The
[combined oracle result](benchmarks/native-maintenance/result.json) preserves all
3,321,500 decisions, the 1,000 acknowledged interrupted sends and 3,000 pending
sends, then drains that suffix without repetition. A fresh restore/replay retry
also passes. Both copy commands pass interruption checks at all four boundaries;
published outputs validate, incomplete outputs remain unpublished and reusing
any operation directory is rejected.

| Operation | Wall (s) | Process CPU (s) | Process peak RSS (MiB) | Cgroup peak (MiB) |
| --------- | -------: | --------------: | ---------------------: | ----------------: |
| Backup    |    4.736 |           4.723 |                   6.80 |             81.64 |
| Validate  |    2.262 |           2.291 |                   5.93 |             11.04 |
| Restore   |    4.777 |           4.721 |                   6.78 |             81.68 |

CPU covers process startup as well as the timed operation, so it can slightly
exceed the operation wall interval. These are individual maintenance observations;
virtual delivery timing is not a throughput measurement. Existing file-cache
charges and the external harness remain outside the fresh operation cgroup.

The source database is 80,412,672 bytes with a 4,124,152-byte committed WAL. The
standalone backup and restored database are each 80,420,864 bytes, with no WAL.
The conservative per-operation logical budgets are 166,006,264 bytes for backup
and 161,890,304 for restore. The harness observed up to 80,425,480 temporary bytes
during backup; restored output briefly needs 80,421,888 temporary bytes.
Its whole retained-directory peak at restore was 245,509,509 bytes because it also
retained the original source/WAL, backup and reports. Retain space for old copies
separately from the per-operation budget.

The measured executable and Rust sources match commit `7a830bb`. The executed
harness hash identifies that same commit; the subsequent removal of one unused
import for ESLint does not change its behavior. Earlier tmpfs acceptance passed,
but only the final host-filesystem measurements above are retained here. Review
found and corrected a wildcard schema-filter gap and incomplete active-prefix
validation before this run. Neither issue remains in the measured executable.

Final verification on Node 24.18.0 and Rust 1.94.0 passes all **433 Node tests**
with **94.53% line / 88.20% branch coverage** and all **17 Rust integration tests**.
Cargo check across all targets, Clippy with warnings denied, Rust formatting,
ESLint (excluding the pre-existing untracked `.scratch/`), Prettier and the
production-contract validator pass. Independent review has **0 remaining
Standards findings** and **0 remaining Spec findings**. The initial negative schema
regression failed before the correction and passes with the strengthened validator.

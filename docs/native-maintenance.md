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

Only the exact current native schema with a completed exercise or resume is
supported. Incomplete seed imports, older schemas, production databases and unknown
schema objects are rejected. There is no migration. Validation checks SQLite
integrity, schema, decision domains, recovery metadata and the existing streaming
historical-decision fingerprint. This is accidental-corruption checking, not a
cryptographic authenticity check or proof that every possible logical edit is valid.
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

The retained acceptance run uses tmpfs due to initial host disk pressure. Tmpfs
counts against host RAM and cannot establish durable power-loss recovery or real
storage latency. The deterministic copy/recovery behavior remains testable there.

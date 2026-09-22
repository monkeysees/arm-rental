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
older interrupted state. Validation checks SQLite
integrity, schema, decision domains, recovery metadata and the existing streaming
historical-decision fingerprint. It also checks every active acknowledgement and
pending decision against the frozen contract, including swaps that preserve totals.
This is accidental-corruption checking, not a cryptographic authenticity check or
proof that every possible logical edit of listing payloads or recovery timestamps is valid.
The independent replay oracle supplies the delivery/recovery acceptance check.

## Commands

Build with Rust 1.94.0 and the pinned offline registry as described in
[Rust development](rust-development.md). Enablement of the existing rusqlite `backup`
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

See the [Rust development guide](rust-development.md) for build and acceptance tooling.

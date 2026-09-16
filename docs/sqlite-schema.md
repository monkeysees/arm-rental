# SQLite schema and delivery history

`PRAGMA user_version` and the transactional `schema_migrations` ledger describe
the physical database schema. The SQLite application ID is `0x41524d52`.
Release metadata and the image label accept schemas 1 through 4; opening any
older supported schema advances it to 4 before repositories become available.
A newer schema, missing application identity, or wrong source/channel binding
fails before journal configuration or migration can change the database.

Version 1 introduced SQLite. Version 2 backfilled apartment housing kinds,
subscription kind selections, and per-kind source integrity history. Version 3
indexes retained apartment metadata and replaces the serialized listing order
with encounter sequence/position columns. Version 4 compacts private delivery
decisions; channel delivery storage keeps its existing representation because
the measured storage bottleneck is the private recipient/listing history.

## Private decision representation

`private_delivery_decisions` is a `STRICT, WITHOUT ROWID` table whose primary
key is `(recipient_id, item_id)`. Each decision contains an integer status:
`0` means notified, `1` skipped, and `2` filtered. An absent row still means
pending; no checkpoint substitutes for a historical decision. The decision time
is a signed integer count of milliseconds from the Unix epoch, bounded to
JavaScript's valid date range, inclusive ±8,640,000,000,000,000. Repository APIs
continue returning and accepting the original status names and canonical ISO
timestamps. This includes negative epochs, expanded years, and exact fractional
milliseconds; no SQLite floating-point date conversion is involved.

The migration converts canonical timestamps with the same JavaScript parser as
the repository boundary. A noncanonical or invalid timestamp aborts the complete
upgrade instead of silently changing its meaning. SQL copies rows through a
scalar conversion function, so migration does not materialize decision history
in JavaScript. Recipient identifiers, listing identifiers, initial-selection
flags, decisions for absent listings, and foreign-key `ON DELETE CASCADE`
behavior remain intact. Deleting a listing cannot delete its delivery decision;
a returning listing sees the same retained decision.

The old `(recipient_id, status)` index is removed. Actual private-delivery
queries select one recipient and explicit listing IDs, read all decisions for
validation/export, update a composite key, or delete a recipient. Query plans
use the composite primary key for bounded reads, filtered re-admission, and
foreign-key cascade. No serving query selects only recipient/status. Candidate
size and query evidence are recorded in [the compaction benchmark](compact-decisions-benchmark.md).

## Upgrade and interruption

All pending version transitions, data copies, table replacements, ledger rows,
and `user_version` changes commit in one `BEGIN IMMEDIATE` transaction. A late
ledger failure, invalid timestamp, or process interruption rolls back that whole
transaction. A foreign-key check runs before commit. This preserves restartable
upgrades from schemas 1, 2, and 3, as well as fresh initialization.

Dropping the old table leaves reusable pages in the database. To actually shrink
both the main file and future SQLite backup snapshots, version 4 adds
`application_metadata.compaction_pending = 1` in the same transaction. After
commit, startup runs `VACUUM`, then clears this marker. VACUUM cannot be part of
the migration transaction; if it fails or is interrupted, the valid upgraded
data remains and the next startup retries reclamation. A failed startup never
exposes repositories or starts Telegram work. This one-time operation needs
space for the original database, replacement pages, WAL, and SQLite's temporary
VACUUM database; do not size the free-space reserve from the smaller final file.
The benchmark's WAL measurements are observations, not a disk-space upper bound.

Keep the stopped-service pre-deploy snapshot and previous immutable image until
the candidate is accepted. Schemas advance forward only. An old image whose
range ends below 4 must first restore its matching pre-deploy snapshot; it must
never open the schema-4 database. See [release rollback](release-and-rollback.md)
and [state recovery](state-recovery.md).

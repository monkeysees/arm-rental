import { decisionMilliseconds } from "./sqlite-decision-values.js";

export const COMPACT_DECISIONS_SCHEMA = `
  CREATE TABLE private_delivery_decisions_compact (
    recipient_id TEXT NOT NULL,
    item_id TEXT NOT NULL CHECK(length(item_id) > 0),
    status INTEGER NOT NULL CHECK(status IN (0, 1, 2)),
    decided_at INTEGER NOT NULL CHECK(decided_at BETWEEN -8640000000000000 AND 8640000000000000),
    PRIMARY KEY(recipient_id, item_id),
    FOREIGN KEY(recipient_id) REFERENCES private_recipients(recipient_id) ON DELETE CASCADE
  ) STRICT, WITHOUT ROWID;
`;

export function migrateCompactDecisions(database) {
  // JavaScript's exact ISO parser also supports expanded years and negative
  // epochs; SQLite's date functions cannot round-trip that complete domain.
  database.function(
    "decision_milliseconds",
    { deterministic: true },
    decisionMilliseconds,
  );
  database.exec(COMPACT_DECISIONS_SCHEMA);
  database.exec(`
    INSERT INTO private_delivery_decisions_compact
      SELECT recipient_id, item_id,
        CASE status WHEN 'notified' THEN 0 WHEN 'skipped' THEN 1 WHEN 'filtered' THEN 2 END,
        decision_milliseconds(decided_at)
      FROM private_delivery_decisions;
    DROP TABLE private_delivery_decisions;
    ALTER TABLE private_delivery_decisions_compact RENAME TO private_delivery_decisions;
    ALTER TABLE application_metadata ADD COLUMN compaction_pending INTEGER NOT NULL DEFAULT 1 CHECK(compaction_pending IN (0, 1));
  `);
}

export function finishDecisionCompaction(database) {
  const metadata = database
    .prepare(
      "SELECT compaction_pending FROM application_metadata WHERE singleton = 1",
    )
    .get();
  if (metadata?.compaction_pending !== 1) return;
  // VACUUM cannot run inside the migration transaction. A durable marker
  // makes an interruption here retryable without repeating the data migration.
  database.exec("VACUUM");
  database.exec(
    "UPDATE application_metadata SET compaction_pending = 0 WHERE singleton = 1",
  );
}

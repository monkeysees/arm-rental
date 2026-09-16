export function migrateIncrementalPrivate(database) {
  database.exec(`
    ALTER TABLE apartments ADD COLUMN changed_sequence INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX apartments_changed_sequence_idx ON apartments(changed_sequence);
    ALTER TABLE private_recipients ADD COLUMN source_cursor INTEGER;
    ALTER TABLE private_recipients ADD COLUMN filter_fingerprint TEXT;
    CREATE TABLE private_delivery_work (
      work_id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      UNIQUE(recipient_id, item_id),
      FOREIGN KEY(recipient_id) REFERENCES private_recipients(recipient_id) ON DELETE CASCADE
    ) STRICT;
  `);
}

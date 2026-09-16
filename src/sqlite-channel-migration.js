export function migrateIncrementalChannel(database) {
  database.exec(`
    ALTER TABLE channel_state ADD COLUMN source_sequence INTEGER NOT NULL DEFAULT -1;
    CREATE TABLE channel_work (
      work_id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id TEXT NOT NULL UNIQUE
    ) STRICT;
    CREATE INDEX channel_delivery_status_idx ON channel_deliveries(status, item_id);
    INSERT INTO channel_work(item_id)
      SELECT a.item_id FROM apartments a JOIN channel_deliveries d USING(item_id)
      WHERE d.status IN ('pending', 'published')
      ORDER BY a.encounter_sequence ASC, a.encounter_position DESC;
  `);
}

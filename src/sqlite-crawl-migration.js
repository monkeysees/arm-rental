import { postingDateIndex } from "./posting-date.js";
import { propertyKindOf } from "./property-kind.js";

/** Runs once inside the schema migration transaction, before normal reads. */
export function migrateIncrementalCrawl(connection) {
  connection.exec(`
    ALTER TABLE apartments ADD COLUMN kind TEXT NOT NULL DEFAULT 'apartment' CHECK(kind IN ('apartment', 'house'));
    ALTER TABLE apartments ADD COLUMN date_bucket TEXT NOT NULL DEFAULT 'fixed' CHECK(date_bucket IN ('fixed', 'relative', 'annual'));
    ALTER TABLE apartments ADD COLUMN posting_date_key INTEGER;
    ALTER TABLE apartments ADD COLUMN posting_date TEXT;
    ALTER TABLE apartments ADD COLUMN encounter_sequence INTEGER NOT NULL DEFAULT 0 CHECK(encounter_sequence >= 0);
    ALTER TABLE apartments ADD COLUMN encounter_position INTEGER NOT NULL DEFAULT 0 CHECK(encounter_position >= 0);
    ALTER TABLE apartments ADD COLUMN last_seen_at TEXT;
    ALTER TABLE crawl_state ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0 CHECK(sequence >= 0);
    ALTER TABLE crawl_state ADD COLUMN total_count INTEGER NOT NULL DEFAULT 0 CHECK(total_count >= 0);
  `);
  const metadata = connection
    .prepare("SELECT apartment_order_json FROM crawl_state WHERE singleton = 1")
    .get();
  const order = metadata ? JSON.parse(metadata.apartment_order_json) : [];
  const positions = new Map(order.map((id, index) => [id, index]));
  const rows = connection
    .prepare("SELECT item_id, payload_json FROM apartments")
    .all();
  if (
    order.length !== rows.length ||
    positions.size !== rows.length ||
    rows.some((row) => !positions.has(row.item_id))
  ) {
    throw new TypeError(
      "Apartment order must contain every apartment exactly once",
    );
  }
  const update = connection.prepare(
    `UPDATE apartments SET kind = ?, date_bucket = ?, posting_date_key = ?, posting_date = ?, encounter_position = ?, last_seen_at = ? WHERE item_id = ?`,
  );
  for (const row of rows) {
    const apartment = JSON.parse(row.payload_json);
    const { bucket, key } = postingDateIndex(apartment.date);
    update.run(
      propertyKindOf(apartment),
      bucket,
      key,
      apartment.date ?? null,
      positions.get(row.item_id),
      apartment.lastSeenAt ?? null,
      row.item_id,
    );
  }
  connection.exec(`
    UPDATE crawl_state SET total_count = (SELECT count(*) FROM apartments);
    ALTER TABLE crawl_state DROP COLUMN apartment_order_json;
    CREATE INDEX apartments_watermark_idx ON apartments(kind, date_bucket, posting_date_key DESC);
    CREATE INDEX apartments_encounter_order_idx ON apartments(encounter_sequence DESC, encounter_position ASC);
    CREATE INDEX apartments_legacy_price_idx ON apartments(item_id)
      WHERE json_type(payload_json, '$.price.amountAmd') IS NULL;
  `);
}

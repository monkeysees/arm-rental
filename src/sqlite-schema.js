import { migrateIncrementalCrawl } from "./sqlite-crawl-migration.js";
import { migrateCompactDecisions } from "./sqlite-decisions-migration.js";
import { migrateIncrementalPrivate } from "./sqlite-private-migration.js";
import { migrateIncrementalChannel } from "./sqlite-channel-migration.js";

export const SQLITE_APPLICATION_ID = 0x41524d52;
export const SQLITE_SCHEMA_VERSION = 6;

const SCHEMA_V1 = `
  CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL,
    source_revision TEXT NOT NULL CHECK(length(source_revision) > 0)
  ) STRICT;

  CREATE TABLE application_metadata (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    database_id TEXT NOT NULL UNIQUE CHECK(length(database_id) > 0),
    list_url_template TEXT NOT NULL CHECK(length(list_url_template) > 0),
    channel_id TEXT,
    created_at TEXT NOT NULL,
    migrated_from TEXT,
    migration_id TEXT
  ) STRICT;

  CREATE TABLE crawl_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    checked_at TEXT NOT NULL,
    last_crawl_json TEXT NOT NULL CHECK(json_valid(last_crawl_json) AND json_type(last_crawl_json) = 'object'),
    apartment_order_json TEXT NOT NULL CHECK(json_valid(apartment_order_json) AND json_type(apartment_order_json) = 'array'),
    source_integrity_json TEXT NOT NULL CHECK(json_valid(source_integrity_json) AND json_type(source_integrity_json) = 'object')
  ) STRICT;

  CREATE TABLE apartments (
    item_id TEXT PRIMARY KEY CHECK(length(item_id) > 0),
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND json_type(payload_json) = 'object')
  ) STRICT;

  CREATE TABLE private_recipients (
    recipient_id TEXT PRIMARY KEY CHECK(length(recipient_id) > 0),
    initial_selection_applied INTEGER NOT NULL CHECK(initial_selection_applied IN (0, 1))
  ) STRICT;

  CREATE TABLE private_delivery_decisions (
    recipient_id TEXT NOT NULL,
    item_id TEXT NOT NULL CHECK(length(item_id) > 0),
    status TEXT NOT NULL CHECK(status IN ('notified', 'skipped', 'filtered')),
    decided_at TEXT NOT NULL CHECK(length(decided_at) > 0),
    PRIMARY KEY(recipient_id, item_id),
    FOREIGN KEY(recipient_id) REFERENCES private_recipients(recipient_id) ON DELETE CASCADE
  ) STRICT;
  CREATE INDEX private_delivery_status_idx
    ON private_delivery_decisions(recipient_id, status);

  CREATE TABLE channel_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    channel_id TEXT NOT NULL CHECK(length(channel_id) > 0),
    list_url_template TEXT NOT NULL CHECK(length(list_url_template) > 0),
    initialized INTEGER NOT NULL CHECK(initialized IN (0, 1)),
    filter_fingerprint TEXT NOT NULL CHECK(
      length(filter_fingerprint) = 64 AND
      filter_fingerprint NOT GLOB '*[^a-f0-9]*'
    )
  ) STRICT;

  CREATE TABLE channel_deliveries (
    item_id TEXT PRIMARY KEY CHECK(length(item_id) > 0),
    status TEXT NOT NULL CHECK(status IN ('pending', 'published', 'filtered', 'skipped_initial')),
    classified_at TEXT NOT NULL CHECK(length(classified_at) > 0),
    reencountered_at TEXT,
    message_id INTEGER CHECK(message_id > 0 AND message_id <= 9007199254740991),
    content_hash TEXT CHECK(
      content_hash IS NULL OR (
        length(content_hash) = 64 AND content_hash NOT GLOB '*[^a-f0-9]*'
      )
    ),
    published_at TEXT,
    updated_at TEXT,
    CHECK(
      (status = 'published' AND message_id IS NOT NULL AND content_hash IS NOT NULL AND published_at IS NOT NULL) OR
      (status <> 'published' AND message_id IS NULL AND content_hash IS NULL AND published_at IS NULL AND updated_at IS NULL)
    )
  ) STRICT;

  CREATE TABLE telegram_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    update_offset INTEGER NOT NULL CHECK(update_offset >= 0 AND update_offset <= 9007199254740991),
    legacy_recipient_id INTEGER CHECK(legacy_recipient_id > 0 AND legacy_recipient_id <= 9007199254740991)
  ) STRICT;

  CREATE TABLE telegram_users (
    chat_id INTEGER PRIMARY KEY CHECK(chat_id > 0 AND chat_id <= 9007199254740991),
    active INTEGER NOT NULL CHECK(active IN (0, 1)),
    send_initial_apartments INTEGER NOT NULL CHECK(send_initial_apartments IN (0, 1)),
    filters_json TEXT NOT NULL CHECK(json_valid(filters_json) AND json_type(filters_json) = 'object'),
    pending_filter_input TEXT CHECK(pending_filter_input IN ('price', 'rooms')),
    deletion_pending_at TEXT,
    CHECK(deletion_pending_at IS NULL OR (active = 0 AND pending_filter_input IS NULL))
  ) STRICT;

  CREATE TABLE exchange_rate_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json) AND json_type(snapshot_json) = 'object')
  ) STRICT;
`;

/**
 * Backfills the housing kind every stored record now carries.
 *
 * Apartments were the only category this bot crawled, so every listing already
 * in the database is one, and every subscription filter meant apartments even
 * though it never had to say so. Both are made explicit here rather than being
 * inferred at read time. The crawl's first-page history splits the same way:
 * one series per category, seeded with what was collected for apartments.
 */
const SCHEMA_V2 = `
  UPDATE apartments
    SET payload_json = json_set(payload_json, '$.kind', 'apartment')
    WHERE json_extract(payload_json, '$.kind') IS NULL;

  UPDATE telegram_users
    SET filters_json = json_set(filters_json, '$.kinds', json_array('apartment'))
    WHERE json_extract(filters_json, '$.kinds') IS NULL;

  UPDATE crawl_state
    SET source_integrity_json = json_set(
      source_integrity_json,
      '$.recentFirstPageCounts',
      json_object(
        'apartment',
        json(json_extract(source_integrity_json, '$.recentFirstPageCounts'))
      )
    )
    WHERE json_type(source_integrity_json, '$.recentFirstPageCounts') = 'array';
`;

const MIGRATIONS = [
  { version: 1, sql: SCHEMA_V1 },
  { version: 2, sql: SCHEMA_V2 },
  { version: 3, migrate: migrateIncrementalCrawl },
  { version: 4, migrate: migrateCompactDecisions },
  { version: 5, migrate: migrateIncrementalPrivate },
  { version: 6, migrate: migrateIncrementalChannel },
];

function exactIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

export function applySqliteMigrations(
  database,
  {
    sourceRevision = process.env.SOURCE_REVISION || "development",
    now = () => new Date(),
  } = {},
) {
  const current = Number(
    database.prepare("PRAGMA user_version").get().user_version,
  );
  if (!Number.isSafeInteger(current) || current < 0) {
    throw new Error("SQLite reported an invalid schema version");
  }
  if (current > SQLITE_SCHEMA_VERSION) {
    const error = new Error(
      "SQLite schema is newer than this application supports",
    );
    error.code = "ERR_STATE_DATABASE_SCHEMA_NEWER";
    throw error;
  }
  if (current === SQLITE_SCHEMA_VERSION) return current;

  const appliedAt = now().toISOString();
  if (!exactIsoTimestamp(appliedAt)) {
    throw new TypeError(
      "Migration clock must return a canonical ISO timestamp",
    );
  }
  if (typeof sourceRevision !== "string" || sourceRevision.length === 0) {
    throw new TypeError("Migration source revision must be non-empty");
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      if (migration.sql) database.exec(migration.sql);
      else migration.migrate(database);
      database
        .prepare(
          "INSERT INTO schema_migrations(version, applied_at, source_revision) VALUES (?, ?, ?)",
        )
        .run(migration.version, appliedAt, sourceRevision);
      database.exec(`PRAGMA user_version = ${migration.version}`);
    }
    if (database.prepare("PRAGMA foreign_key_check").get()) {
      throw new Error("Migrated state violates foreign-key constraints");
    }
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the migration failure; close/reopen validation remains authoritative.
    }
    throw error;
  }
  return SQLITE_SCHEMA_VERSION;
}

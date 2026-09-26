-- Frozen Node production schema v1 and synthetic rows. See ../README.md.
PRAGMA application_id = 1095912786;
PRAGMA user_version = 1;
PRAGMA foreign_keys = ON;
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

INSERT INTO schema_migrations VALUES
  (1, '2026-09-15T10:00:00.000Z', 'node-baseline-b5a4f09');
INSERT INTO application_metadata VALUES
  (1, 'native-acceptance-v1',
   'https://www.list.am/ru/category/56/{page}?n=0&cmtype=0&crc=0&gl=2&srt=3',
   NULL, '2026-09-15T10:00:00.000Z', NULL, NULL);
INSERT INTO crawl_state VALUES
  (1, '2026-09-15T10:00:00.000Z', '{}', '["100001","100002"]',
   '{"recentFirstPageCounts":[20],"lastSuccessfulAt":"2026-09-15T10:00:00.000Z"}');
INSERT INTO apartments VALUES
  ('100001', '{"itemId":"100001","title":"Baseline apartment 100001","url":"https://www.list.am/ru/item/100001","location":"Арабкир","rooms":2,"areaSqM":60,"floor":"3/9","date":"Вторник, Сентябрь 15, 2026, 10:00","price":{"amount":100000,"currency":"AMD"},"lastSeenAt":"2026-09-15T10:00:00.000Z"}'),
  ('100002', '{"itemId":"100002","title":"Baseline apartment 100002","url":"https://www.list.am/ru/item/100002","location":"Кентрон","rooms":3,"areaSqM":75,"floor":"4/9","date":"Вторник, Сентябрь 15, 2026, 10:00","price":{"amount":500,"currency":"USD"},"lastSeenAt":"2026-09-15T10:00:00.000Z"}');
INSERT INTO private_recipients VALUES ('123', 1);
INSERT INTO private_delivery_decisions VALUES
  ('123', '100001', 'notified', '2026-09-15T10:00:01.000Z'),
  ('123', '100002', 'skipped', '2026-09-15T10:00:02.000Z'),
  ('123', '150001', 'filtered', '2026-09-15T10:00:03.000Z');
INSERT INTO telegram_state VALUES (1, 42, NULL);
INSERT INTO telegram_users VALUES
  (123, 1, 1,
   '{"price":{"min":null,"max":null},"rooms":{"min":null,"max":null},"locations":[]}',
   NULL, NULL);
INSERT INTO exchange_rate_state VALUES
  (1, '{"fetchedAt":"2026-09-15T09:00:00.000Z","effectiveDate":"2026-09-15","rates":{"USD":{"amount":1,"rate":400}}}');

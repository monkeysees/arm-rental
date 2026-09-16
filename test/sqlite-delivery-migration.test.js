import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openStateDatabase } from "../src/sqlite-database.js";
import { migrateIncrementalCrawl } from "../src/sqlite-crawl-migration.js";
import { migrateCompactDecisions } from "../src/sqlite-decisions-migration.js";
import { SQLITE_SCHEMA_VERSION } from "../src/sqlite-schema.js";
import { createLegacyDatabase } from "./helpers/sqlite-legacy.js";

for (const rejectedVersion of [5, 6]) {
  test(`failed delivery migration ${rejectedVersion} preserves schema 4 and retries cleanly`, (t) => {
    const directory = mkdtempSync(path.join(tmpdir(), "delivery-upgrade-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const options = {
      dataDirectory: directory,
      listUrlTemplate: "https://www.list.am/ru/category/56/{page}",
    };
    const legacy = createLegacyDatabase(directory, options);
    legacy.exec(`
      INSERT INTO private_recipients VALUES ('42', 1);
      INSERT INTO private_delivery_decisions VALUES
        ('42', 'absent', 'skipped', '2026-09-16T10:00:00.999Z');
    `);
    migrateIncrementalCrawl(legacy);
    migrateCompactDecisions(legacy);
    legacy.exec(`
      INSERT INTO schema_migrations VALUES
        (3, '2026-09-16T10:00:00.000Z', 'previous'),
        (4, '2026-09-16T10:00:00.000Z', 'previous');
      PRAGMA user_version = 4;
      CREATE TRIGGER reject_delivery_migration BEFORE INSERT ON schema_migrations
        WHEN NEW.version = ${rejectedVersion}
        BEGIN SELECT RAISE(ABORT, 'injected delivery migration failure'); END;
    `);
    const before = legacy
      .prepare("SELECT * FROM private_delivery_decisions")
      .all();
    legacy.close();

    assert.throws(() => openStateDatabase(options));
    const refused = new DatabaseSync(path.join(directory, "state.sqlite3"));
    assert.equal(refused.prepare("PRAGMA user_version").get().user_version, 4);
    assert.deepEqual(
      refused.prepare("SELECT * FROM private_delivery_decisions").all(),
      before,
    );
    assert.equal(
      refused.prepare("SELECT count(*) n FROM schema_migrations").get().n,
      4,
    );
    assert.equal(
      refused
        .prepare(
          "SELECT count(*) n FROM sqlite_master WHERE name IN ('private_delivery_work', 'channel_work')",
        )
        .get().n,
      0,
    );
    assert.equal(
      refused
        .prepare("PRAGMA table_info(apartments)")
        .all()
        .some(({ name }) => name === "changed_sequence"),
      false,
    );
    refused.exec("DROP TRIGGER reject_delivery_migration");
    refused.close();

    const recovered = openStateDatabase(options);
    t.after(() => recovered.close());
    assert.equal(
      recovered.prepare("PRAGMA user_version").get().user_version,
      SQLITE_SCHEMA_VERSION,
    );
    assert.deepEqual(
      recovered.prepare("SELECT * FROM private_delivery_decisions").all(),
      before,
    );
    assert.equal(
      recovered.prepare("PRAGMA integrity_check").get().integrity_check,
      "ok",
    );
    assert.equal(
      recovered.prepare("PRAGMA foreign_key_check").get(),
      undefined,
    );
  });
}

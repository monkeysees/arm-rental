import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import runTest from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openStateDatabase } from "../src/sqlite-database.js";
import { LIST_AM_URL_TEMPLATE } from "../src/target.js";

const binary = process.env.RENTAL_APP_BINARY;
const test = (name, check) => runTest(name, { skip: !binary }, check);
function run(command, directory) {
  return spawnSync(binary, [command, "--data-directory", directory], {
    encoding: "utf8",
  });
}
function temporary(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "rental-rust-storage-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
test("Rust maintenance initializes production state readable by Node", (t) => {
  const directory = temporary(t);
  const result = run("state:init", directory);
  assert.equal(result.status, 0, result.stderr || String(result.error));
  const database = openStateDatabase({
    dataDirectory: directory,
    listUrlTemplate: LIST_AM_URL_TEMPLATE,
  });
  try {
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 6);
    assert.equal(
      database.prepare("PRAGMA application_id").get().application_id,
      0x41524d52,
    );
    assert.deepEqual(
      database
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all()
        .map((r) => r.version),
      [1, 2, 3, 4, 5, 6],
    );
    assert.equal(
      database.prepare("SELECT update_offset FROM telegram_state").get()
        .update_offset,
      0,
    );
  } finally {
    database.close();
  }
  assert.notEqual(run("state:init", directory).status, 0);
});
test("Rust maintenance fails closed for absent, wrong target, newer and unsafe-mode state", (t) => {
  const directory = temporary(t);
  assert.notEqual(run("state:validate", directory).status, 0);
  const database = openStateDatabase({
    dataDirectory: directory,
    listUrlTemplate: LIST_AM_URL_TEMPLATE,
    create: true,
  });
  database.close();
  assert.equal(run("state:validate", directory).status, 0);
  const filename = path.join(directory, "state.sqlite3");
  const mutate = (sql) => {
    const db = new DatabaseSync(filename);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
  };
  mutate("PRAGMA user_version=7");
  assert.notEqual(run("state:validate", directory).status, 0);
  mutate(
    "PRAGMA user_version=6; UPDATE application_metadata SET list_url_template='wrong'",
  );
  assert.notEqual(run("state:validate", directory).status, 0);
  mutate(
    `UPDATE application_metadata SET list_url_template='${LIST_AM_URL_TEMPLATE}'`,
  );
  chmodSync(filename, 0o644);
  assert.notEqual(run("state:validate", directory).status, 0);
});

function legacyDatabase(directory, timestamp) {
  const filename = path.join(directory, "state.sqlite3");
  const database = new DatabaseSync(filename);
  chmodSync(filename, 0o600);
  const source = readFileSync(
    new URL("../src/sqlite-schema.js", import.meta.url),
    "utf8",
  );
  database.exec(source.match(/const SCHEMA_V1 = `([\s\S]*?)`;/u)[1]);
  database.exec("PRAGMA application_id=1095912786; PRAGMA user_version=1");
  database
    .prepare("INSERT INTO schema_migrations VALUES(1,?,?)")
    .run("2026-01-01T00:00:00.000Z", "node-oracle");
  database
    .prepare("INSERT INTO application_metadata VALUES(1,?,?,NULL,?,NULL,NULL)")
    .run("oracle-database", LIST_AM_URL_TEMPLATE, "2026-01-01T00:00:00.000Z");
  database.exec(
    "INSERT INTO telegram_state(singleton,update_offset) VALUES(1,42); INSERT INTO private_recipients VALUES('123',1)",
  );
  database
    .prepare(
      "INSERT INTO private_delivery_decisions VALUES('123','missing-listing','notified',?)",
    )
    .run(timestamp);
  database.close();
  return filename;
}
test("Rust upgrades production v1 with exact expanded-year private decisions", (t) => {
  const directory = temporary(t);
  const timestamp = "+275760-09-13T00:00:00.000Z";
  const filename = legacyDatabase(directory, timestamp);
  const result = run("state:validate", directory);
  assert.equal(result.status, 0, result.stderr);
  const database = new DatabaseSync(filename);
  try {
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 6);
    const row = database
      .prepare("SELECT status, decided_at FROM private_delivery_decisions")
      .get();
    assert.equal(row.status, 0);
    assert.equal(row.decided_at, Date.parse(timestamp));
    assert.equal(
      database.prepare("SELECT update_offset FROM telegram_state").get()
        .update_offset,
      42,
    );
    assert.equal(
      database
        .prepare("SELECT compaction_pending FROM application_metadata")
        .get().compaction_pending,
      0,
    );
  } finally {
    database.close();
  }
});
test("Rust rejects noncanonical decisions and rolls back the complete migration", (t) => {
  const directory = temporary(t);
  const filename = legacyDatabase(directory, "2026-01-01T00:00:00Z");
  assert.notEqual(run("state:validate", directory).status, 0);
  const database = new DatabaseSync(filename);
  try {
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 1);
    assert.equal(
      database.prepare("SELECT count(*) AS n FROM schema_migrations").get().n,
      1,
    );
    assert.equal(
      database.prepare("SELECT status FROM private_delivery_decisions").get()
        .status,
      "notified",
    );
  } finally {
    database.close();
  }
});
for (const version of [2, 3, 4, 5]) {
  test(`Rust upgrades production schema ${version} without changing retained identities`, async (t) => {
    const directory = temporary(t);
    const timestamp = "-000001-12-31T23:59:59.999Z";
    const filename = legacyDatabase(directory, timestamp);
    const db = new DatabaseSync(filename);
    try {
      const source = readFileSync(
        new URL("../src/sqlite-schema.js", import.meta.url),
        "utf8",
      );
      db.exec(source.match(/const SCHEMA_V2 = `([\s\S]*?)`;/u)[1]);
      if (version >= 3)
        (
          await import("../src/sqlite-crawl-migration.js")
        ).migrateIncrementalCrawl(db);
      if (version >= 4)
        (
          await import("../src/sqlite-decisions-migration.js")
        ).migrateCompactDecisions(db);
      if (version >= 5)
        (
          await import("../src/sqlite-private-migration.js")
        ).migrateIncrementalPrivate(db);
      for (let current = 2; current <= version; current++)
        db.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(
          current,
          "2026-01-01T00:00:00.000Z",
          "node-oracle",
        );
      db.exec(`PRAGMA user_version=${version}`);
    } finally {
      db.close();
    }
    const result = run("state:validate", directory);
    assert.equal(result.status, 0, result.stderr);
    const database = openStateDatabase({
      dataDirectory: directory,
      listUrlTemplate: LIST_AM_URL_TEMPLATE,
    });
    try {
      assert.equal(
        database.prepare("SELECT database_id FROM application_metadata").get()
          .database_id,
        "oracle-database",
      );
      const row = database
        .prepare(
          "SELECT recipient_id,item_id,status,decided_at FROM private_delivery_decisions",
        )
        .get();
      assert.deepEqual(
        { ...row },
        {
          recipient_id: "123",
          item_id: "missing-listing",
          status: 0,
          decided_at: Date.parse(timestamp),
        },
      );
      assert.equal(
        database.prepare("SELECT count(*) AS n FROM schema_migrations").get().n,
        6,
      );
    } finally {
      database.close();
    }
  });
}
test("a late migration ledger failure rolls back all production schema changes", (t) => {
  const directory = temporary(t);
  const filename = legacyDatabase(directory, "1969-12-31T23:59:59.999Z");
  const fixture = new DatabaseSync(filename);
  fixture.exec(
    "CREATE TRIGGER fail_late BEFORE INSERT ON schema_migrations WHEN NEW.version=6 BEGIN SELECT RAISE(ABORT,'injected late ledger failure'); END",
  );
  fixture.close();
  assert.notEqual(run("state:validate", directory).status, 0);
  const database = new DatabaseSync(filename);
  try {
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 1);
    assert.equal(
      database.prepare("SELECT count(*) AS n FROM schema_migrations").get().n,
      1,
    );
    assert.equal(
      database
        .prepare("SELECT decided_at FROM private_delivery_decisions")
        .get().decided_at,
      "1969-12-31T23:59:59.999Z",
    );
    assert.equal(
      database
        .prepare(
          "SELECT count(*) AS n FROM sqlite_schema WHERE name='channel_work'",
        )
        .get().n,
      0,
    );
  } finally {
    database.close();
  }
});

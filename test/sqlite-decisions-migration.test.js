import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openStateDatabase } from "../src/sqlite-database.js";
import { createSqliteRepositories } from "../src/sqlite-repositories.js";
import {
  applySqliteMigrations,
  SQLITE_SCHEMA_VERSION,
} from "../src/sqlite-schema.js";
import { migrateIncrementalCrawl } from "../src/sqlite-crawl-migration.js";
import { finishDecisionCompaction } from "../src/sqlite-decisions-migration.js";
import { createLegacyDatabase } from "./helpers/sqlite-legacy.js";

const listUrlTemplate = "https://www.list.am/ru/category/56/{page}";
const stamps = [
  "2026-09-15T10:11:12.001Z",
  "2026-09-15T10:11:12.999Z",
  "1969-12-31T23:59:59.999Z",
  "1970-01-01T00:00:00.000Z",
  "0000-01-01T00:00:00.001Z",
  "+010000-01-01T00:00:00.999Z",
  "-271821-04-20T00:00:00.000Z",
  "+275760-09-13T00:00:00.000Z",
];
function fixture(t, version = 2) {
  const directory = mkdtempSync(path.join(tmpdir(), "decision-upgrade-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = createLegacyDatabase(directory, {
    version: Math.min(version, 2),
    listUrlTemplate,
  });
  db.exec("INSERT INTO private_recipients VALUES ('42', 1), ('43', 0)");
  const insert = db.prepare(
    "INSERT INTO private_delivery_decisions VALUES (?, ?, ?, ?)",
  );
  for (let index = 0; index < stamps.length; index++) {
    insert.run(
      "42",
      `absent-${index}`,
      ["notified", "skipped", "filtered"][index % 3],
      stamps[index],
    );
  }
  insert.run("43", "absent-0", "filtered", stamps[0]);
  if (version === 3) {
    db.exec("BEGIN IMMEDIATE");
    migrateIncrementalCrawl(db);
    db.exec(
      "INSERT INTO schema_migrations VALUES (3, '2026-09-15T10:00:00.000Z', 'previous-release'); PRAGMA user_version = 3; COMMIT",
    );
  }
  db.close();
  return directory;
}
function open(directory) {
  return openStateDatabase({ dataDirectory: directory, listUrlTemplate });
}

for (const version of [1, 2, 3]) {
  test(`schema ${version} upgrades every retained decision with exact milliseconds and recipient deletion`, (t) => {
    const directory = fixture(t, version);
    const db = open(directory);
    const repository = createSqliteRepositories(db, {
      listUrlTemplate,
    }).privateDeliveries;
    assert.equal(
      db.prepare("PRAGMA user_version").get().user_version,
      SQLITE_SCHEMA_VERSION,
    );
    assert.equal(
      db.prepare("SELECT compaction_pending FROM application_metadata").get()
        .compaction_pending,
      0,
    );
    const expected = {
      notified: {},
      skipped: {},
      filtered: {},
      initialSelectionApplied: true,
    };
    for (let index = 0; index < stamps.length; index++)
      expected[["notified", "skipped", "filtered"][index % 3]][
        `absent-${index}`
      ] = stamps[index];
    assert.deepEqual(
      repository.loadRecipient(
        "42",
        stamps.map((_, index) => `absent-${index}`),
      ),
      expected,
    );
    assert.equal(repository.validate(), true);
    assert.match(
      db
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE name = 'private_delivery_decisions'",
        )
        .get().sql,
      /WITHOUT ROWID/u,
    );
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM sqlite_schema WHERE name = 'private_delivery_status_idx'",
        )
        .get().n,
      0,
    );
    assert.equal(
      db
        .prepare(
          "SELECT typeof(decided_at) AS t FROM private_delivery_decisions LIMIT 1",
        )
        .get().t,
      "integer",
    );
    repository.acknowledge("42", "returned", stamps[1]);
    repository.addDecisions("42", "filtered", { returning: stamps[0] });
    assert.equal(repository.removeFilteredDecision("42", "returning"), 1);
    assert.equal(repository.removeFilteredDecision("42", "absent-1"), 0);
    repository.deleteRecipient("42");
    assert.equal(db.logicalCounts().privateDecisions, 1);
    assert.deepEqual(repository.loadRecipient("43", ["absent-0"]).filtered, {
      "absent-0": stamps[0],
    });
    db.validate({ full: true });
    db.close();
    const reopened = open(directory);
    reopened.validate({ full: true });
    reopened.close();
  });
}

test("invalid legacy timestamp and late migration failure leave the original schema and rows intact", (t) => {
  for (const fault of ["timestamp", "ledger"]) {
    const directory = fixture(t, 3);
    const filename = path.join(directory, "state.sqlite3");
    const before = new DatabaseSync(filename);
    if (fault === "timestamp")
      before.exec(
        "UPDATE private_delivery_decisions SET decided_at = '2026-09-15T10:11:12Z' WHERE item_id = 'absent-7'",
      );
    else
      before.exec(
        "CREATE TRIGGER reject_v4 BEFORE INSERT ON schema_migrations WHEN NEW.version = 4 BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END",
      );
    const original = before
      .prepare(
        "SELECT * FROM private_delivery_decisions ORDER BY recipient_id, item_id",
      )
      .all();
    before.close();
    assert.throws(() => open(directory));
    const after = new DatabaseSync(filename);
    assert.equal(after.prepare("PRAGMA user_version").get().user_version, 3);
    assert.deepEqual(
      after
        .prepare(
          "SELECT * FROM private_delivery_decisions ORDER BY recipient_id, item_id",
        )
        .all(),
      original,
    );
    assert.equal(
      after.prepare("SELECT count(*) AS n FROM schema_migrations").get().n,
      3,
    );
    assert.equal(
      after
        .prepare(
          "SELECT count(*) AS n FROM sqlite_schema WHERE name = 'private_delivery_decisions_compact'",
        )
        .get().n,
      0,
    );
    after.close();
  }
});

test("a killed migration rolls back on reopen and subsequently completes", (t) => {
  const directory = fixture(t, 3);
  const filename = path.join(directory, "state.sqlite3");
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { DatabaseSync } from 'node:sqlite';
    import { applySqliteMigrations } from ${JSON.stringify(new URL("../src/sqlite-schema.js", import.meta.url).href)};
    const db = new DatabaseSync(${JSON.stringify(filename)});
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL');
    const register = db.function.bind(db);
    db.function = (name, options, fn) => register(name, options, (value) => {
      if (value === '1969-12-31T23:59:59.999Z') process.kill(process.pid, 'SIGKILL');
      return fn(value);
    });
    applySqliteMigrations(db);
  `,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.signal, "SIGKILL", result.stderr);
  const raw = new DatabaseSync(filename);
  assert.equal(raw.prepare("PRAGMA user_version").get().user_version, 3);
  assert.equal(
    raw
      .prepare(
        "SELECT decided_at FROM private_delivery_decisions WHERE recipient_id = '42' AND item_id = 'absent-2'",
      )
      .get().decided_at,
    stamps[2],
  );
  raw.close();
  const db = open(directory);
  assert.equal(db.logicalCounts().privateDecisions, 9);
  db.close();
});

test("failed space reclamation retains its retry marker and reopening finishes it", (t) => {
  const directory = fixture(t, 3);
  const db = new DatabaseSync(path.join(directory, "state.sqlite3"));
  applySqliteMigrations(db);
  const execute = db.exec.bind(db);
  db.exec = (sql) => {
    if (sql === "VACUUM") throw new Error("injected interruption");
    return execute(sql);
  };
  assert.throws(() => finishDecisionCompaction(db), /injected interruption/u);
  assert.equal(
    db.prepare("SELECT compaction_pending FROM application_metadata").get()
      .compaction_pending,
    1,
  );
  db.close();
  const resumed = open(directory);
  assert.equal(
    resumed.prepare("SELECT compaction_pending FROM application_metadata").get()
      .compaction_pending,
    0,
  );
  assert.equal(resumed.logicalCounts().privateDecisions, 9);
  resumed.close();
});

test("older wrong-target and newer schemas are refused without mutating their files", (t) => {
  for (const scenario of ["target", "newer"]) {
    const directory = fixture(t, 2);
    const filename = path.join(directory, "state.sqlite3");
    if (scenario === "newer") {
      const db = new DatabaseSync(filename);
      db.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION + 1}`);
      db.close();
    }
    const before = readFileSync(filename);
    assert.throws(
      () =>
        openStateDatabase({
          dataDirectory: directory,
          listUrlTemplate:
            scenario === "target"
              ? "https://wrong.invalid/{page}"
              : listUrlTemplate,
        }),
      {
        code:
          scenario === "target"
            ? "ERR_STATE_DATABASE_TARGET"
            : "ERR_STATE_DATABASE_SCHEMA_NEWER",
      },
    );
    assert.deepEqual(readFileSync(filename), before);
  }
});

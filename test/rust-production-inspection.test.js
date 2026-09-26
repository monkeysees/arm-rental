import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  chmodSync,
  readFileSync,
  statSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { LIST_AM_URL_TEMPLATE } from "../src/target.js";
const binary = process.env.RENTAL_APP_BINARY;
function fixture(t, version = 6) {
  const directory = mkdtempSync(join(tmpdir(), "rust-inspect-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "state.sqlite3");
  const db = new DatabaseSync(file);
  db.exec(
    `PRAGMA application_id=${0x41524d52}; PRAGMA user_version=${version}; PRAGMA journal_mode=WAL; CREATE TABLE application_metadata(singleton INTEGER PRIMARY KEY,database_id TEXT,list_url_template TEXT);`,
  );
  db.prepare("INSERT INTO application_metadata VALUES(1,?,?)").run(
    "synthetic-inspection",
    LIST_AM_URL_TEMPLATE,
  );
  chmodSync(file, 0o600);
  t.after(() => db.close());
  return { directory, file, db };
}
function inspect(directory) {
  return spawnSync(binary, ["state:inspect", "--data-directory", directory], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
}

test(
  "native state inspection reads an active WAL snapshot without acquiring the service lease or upgrading",
  { skip: !binary },
  async (t) => {
    const { directory, file, db } = fixture(t, 5);
    chmodSync(directory, 0o750);
    const socket = join(directory, ".singleton.sock");
    const listener = createServer((connection) =>
      connection.end("active writer"),
    );
    await new Promise((resolve) => listener.listen(socket, resolve));
    t.after(() => new Promise((resolve) => listener.close(resolve)));
    db.exec("BEGIN IMMEDIATE");
    db.prepare("UPDATE application_metadata SET database_id=?").run(
      "uncommitted-writer",
    );
    const before = readFileSync(file);
    const walBefore = readFileSync(`${file}-wal`);
    const result = inspect(directory);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      stateBackend: "sqlite",
      stateSchema: 5,
    });
    assert.deepEqual(readFileSync(file), before);
    assert.deepEqual(readFileSync(`${file}-wal`), walBefore);
    assert.equal(statSync(directory).mode & 0o777, 0o750);
    assert.ok(existsSync(socket));
    db.exec("ROLLBACK");
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 5);
    assert.equal(
      db.prepare("SELECT database_id FROM application_metadata").get()
        .database_id,
      "synthetic-inspection",
    );
  },
);

test(
  "native state inspection reports newer schemas for the independent rollback range check",
  { skip: !binary },
  (t) => {
    const { directory } = fixture(t, 7);
    const result = inspect(directory);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      stateBackend: "sqlite",
      stateSchema: 7,
    });
  },
);

test(
  "native state inspection refuses foreign source identity and never creates an absent database",
  { skip: !binary },
  (t) => {
    const { directory, db } = fixture(t);
    db.prepare("UPDATE application_metadata SET list_url_template=?").run(
      "https://other.invalid/{page}",
    );
    assert.notEqual(inspect(directory).status, 0);
    db.prepare("UPDATE application_metadata SET list_url_template=?").run(
      LIST_AM_URL_TEMPLATE,
    );
    db.exec("PRAGMA application_id=123");
    assert.notEqual(inspect(directory).status, 0);
    const absent = join(directory, "absent");
    assert.notEqual(inspect(absent).status, 0);
    assert.ok(!existsSync(absent));
  },
);

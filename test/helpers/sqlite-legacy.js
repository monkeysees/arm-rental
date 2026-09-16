import { chmodSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SQLITE_APPLICATION_ID } from "../../src/sqlite-schema.js";

export function createLegacyDatabase(
  directory,
  { version = 2, listUrlTemplate, channelId = null } = {},
) {
  const filename = path.join(directory, "state.sqlite3");
  const database = new DatabaseSync(filename);
  chmodSync(filename, 0o600);
  database.exec(
    readFileSync(new URL("../fixtures/sqlite-v2.sql", import.meta.url), "utf8"),
  );
  database.exec(
    `PRAGMA application_id = ${SQLITE_APPLICATION_ID}; PRAGMA user_version = ${version}`,
  );
  database
    .prepare(
      "INSERT INTO application_metadata VALUES (1, 'legacy-database', ?, ?, '2026-08-18T10:11:12.000Z', NULL, NULL)",
    )
    .run(listUrlTemplate, channelId);
  database.exec("INSERT INTO telegram_state VALUES (1, 0, NULL)");
  for (let current = 1; current <= version; current++) {
    database
      .prepare(
        "INSERT INTO schema_migrations VALUES (?, '2026-08-18T10:11:12.000Z', 'legacy-release')",
      )
      .run(current);
  }
  return database;
}

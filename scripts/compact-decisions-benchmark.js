import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createLegacyDatabase } from "../test/helpers/sqlite-legacy.js";
import { openStateDatabase } from "../src/sqlite-database.js";
import { migrateIncrementalCrawl } from "../src/sqlite-crawl-migration.js";
import { decisionMilliseconds } from "../src/sqlite-decision-values.js";

const url = "https://www.list.am/ru/category/56/{page}";
const stamp = "2026-09-15T10:00:00.999Z";
const variants = [
  "legacy",
  "milliseconds",
  "integer-rowid",
  "integer-without-rowid-index",
  "text-without-rowid",
  "compact",
];
const [mode, directory, rowsText, recipientsText, variant] =
  process.argv.slice(2);
const rows = Number(rowsText);
const recipients = Number(recipientsText);
const bytes = (filename) => {
  try {
    return statSync(filename).size;
  } catch {
    return 0;
  }
};
const filename = directory && path.join(directory, "state.sqlite3");
function seed() {
  const db = createLegacyDatabase(directory, { listUrlTemplate: url });
  db.exec(
    "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; BEGIN IMMEDIATE",
  );
  const recipient = db.prepare("INSERT INTO private_recipients VALUES (?, 1)");
  for (let i = 0; i < recipients; i++) recipient.run(String(100000000 + i));
  const decision = db.prepare(
    "INSERT INTO private_delivery_decisions VALUES (?, ?, ?, ?)",
  );
  for (let i = 0; i < rows; i++) {
    decision.run(
      String(100000000 + (i % recipients)),
      String(900000000 + Math.floor(i / recipients)),
      i % 10 === 0 ? "notified" : i % 10 < 3 ? "skipped" : "filtered",
      stamp,
    );
  }
  const listing = db.prepare("INSERT INTO apartments VALUES (?, ?)");
  for (let i = 0; i < 5442 * (recipients / 88); i++) {
    const id = String(900000000 + i);
    listing.run(
      id,
      JSON.stringify({
        itemId: id,
        kind: i % 2 === 0 ? "apartment" : "house",
        url: `https://www.list.am/ru/item/${id}`,
        title: `Synthetic retained rental ${i}`,
        price: {
          amountAmd: 200000,
          originalAmount: 200000,
          originalCurrency: "AMD",
          exchangeRate: null,
          exchangeRateFetchedAt: null,
          exchangeRateEffectiveDate: null,
        },
        rooms: 2,
        area: 60,
        floor: "3/9",
        location: "Арабкир",
        date: "Вторник, Сентябрь 15, 2026, 10:00",
        firstSeenAt: stamp,
        lastSeenAt: stamp,
      }),
    );
  }
  db.prepare("INSERT INTO crawl_state VALUES (1, ?, ?, ?, ?)").run(
    stamp,
    JSON.stringify({ initialRun: false, pagesParsed: 2 }),
    JSON.stringify(
      Array.from({ length: 5442 * (recipients / 88) }, (_, i) =>
        String(900000000 + i),
      ),
    ),
    JSON.stringify({
      recentFirstPageCounts: {
        apartment: [100, 100, 100],
        house: [100, 100, 100],
      },
      lastSuccessfulAt: stamp,
    }),
  );
  migrateIncrementalCrawl(db);
  db.exec(
    "INSERT INTO schema_migrations VALUES (3, '2026-09-15T10:00:00.999Z', 'benchmark-v3'); PRAGMA user_version = 3; COMMIT; VACUUM; PRAGMA wal_checkpoint(TRUNCATE)",
  );
  db.close();
}
async function measure() {
  const beforeRss = process.memoryUsage().rss;
  const start = performance.now();
  let db;
  if (variant === "compact") {
    db = openStateDatabase({ dataDirectory: directory, listUrlTemplate: url });
  } else {
    db = new DatabaseSync(filename);
    db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON",
    );
    if (variant !== "legacy") {
      const integerTime = variant !== "text-without-rowid";
      const integerStatus = variant.startsWith("integer");
      const withoutRowid = variant.includes("without-rowid");
      db.function(
        "decision_milliseconds",
        { deterministic: true },
        decisionMilliseconds,
      );
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE candidate(recipient_id TEXT NOT NULL, item_id TEXT NOT NULL,
          status ${integerStatus ? "INTEGER" : "TEXT"} NOT NULL,
          decided_at ${integerTime ? "INTEGER" : "TEXT"} NOT NULL,
          PRIMARY KEY(recipient_id, item_id),
          FOREIGN KEY(recipient_id) REFERENCES private_recipients(recipient_id) ON DELETE CASCADE
        ) STRICT${withoutRowid ? ", WITHOUT ROWID" : ""};
        INSERT INTO candidate SELECT recipient_id, item_id,
          ${integerStatus ? "CASE status WHEN 'notified' THEN 0 WHEN 'skipped' THEN 1 ELSE 2 END" : "status"},
          ${integerTime ? "decision_milliseconds(decided_at)" : "decided_at"} FROM private_delivery_decisions;
        DROP TABLE private_delivery_decisions;
        ALTER TABLE candidate RENAME TO private_delivery_decisions;
        ${variant === "text-without-rowid" ? "" : "CREATE INDEX private_delivery_status_idx ON private_delivery_decisions(recipient_id, status);"}
        COMMIT; VACUUM;`);
    }
  }
  const connection = db.connection || db;
  const migrationMs = performance.now() - start;
  const migrationPeakRssBytes = process.resourceUsage().maxRSS * 1024;
  const migrationWalBytes = bytes(`${filename}-wal`);
  const integerTime = variant !== "legacy" && variant !== "text-without-rowid";
  const integerStatus = variant === "compact" || variant.startsWith("integer");
  const ids = JSON.stringify(
    Array.from({ length: 5442 }, (_, i) => String(900000000 + i)),
  );
  const sql =
    "SELECT item_id, status, decided_at FROM private_delivery_decisions WHERE recipient_id = ? AND item_id IN (SELECT value FROM json_each(?)) ORDER BY item_id";
  const queryPlan = connection
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all("100000000", ids)
    .map((row) => row.detail);
  const releasePlan = connection
    .prepare(
      `EXPLAIN QUERY PLAN DELETE FROM private_delivery_decisions WHERE recipient_id = ? AND item_id = ? AND status = ?`,
    )
    .all("100000000", "900000000", integerStatus ? 2 : "filtered")
    .map((row) => row.detail);
  const deletionPlan = connection
    .prepare(
      "EXPLAIN QUERY PLAN DELETE FROM private_recipients WHERE recipient_id = ?",
    )
    .all("100000000")
    .map((row) => row.detail);
  const lookup = connection.prepare(sql);
  const lookupTimes = [];
  for (let i = 0; i < 30; i++) {
    const started = performance.now();
    assert(lookup.all(String(100000000 + (i % recipients)), ids).length > 0);
    lookupTimes.push(performance.now() - started);
  }
  connection.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const writeTimes = [];
  const update = connection.prepare(
    "UPDATE private_delivery_decisions SET status = ?, decided_at = ? WHERE recipient_id = ? AND item_id = ?",
  );
  for (let i = 0; i < 100; i++) {
    const started = performance.now();
    connection.exec("BEGIN IMMEDIATE");
    update.run(
      integerStatus ? 0 : "notified",
      integerTime
        ? Date.parse(stamp) + i
        : new Date(Date.parse(stamp) + i).toISOString(),
      String(100000000 + (i % recipients)),
      "900000000",
    );
    connection.exec("COMMIT");
    writeTimes.push(performance.now() - started);
  }
  const writeWalBytes = bytes(`${filename}-wal`);
  connection.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const snapshot = path.join(directory, "snapshot.sqlite3");
  const backupStart = performance.now();
  await backup(connection, snapshot);
  const snapshotMs = performance.now() - backupStart;
  assert.equal(
    connection
      .prepare("SELECT count(*) AS n FROM private_delivery_decisions")
      .get().n,
    rows,
  );
  assert.equal(
    connection.prepare("PRAGMA integrity_check").get().integrity_check,
    "ok",
  );
  assert.deepEqual(connection.prepare("PRAGMA foreign_key_check").all(), []);
  const median = (samples) =>
    samples.toSorted((a, b) => a - b)[Math.floor(samples.length / 2)];
  const result = {
    variant,
    rows,
    recipients,
    node: process.version,
    sqlite: connection.prepare("SELECT sqlite_version() AS v").get().v,
    databaseBytes: bytes(filename),
    snapshotBytes: bytes(snapshot),
    snapshotMs,
    migrationWalBytes,
    writeWalBytes,
    migrationMs,
    migrationPeakRssBytes,
    migrationRssGrowthBytes: migrationPeakRssBytes - beforeRss,
    lookupMedianMs: median(lookupTimes),
    writeMedianMs: median(writeTimes),
    queryPlan,
    releasePlan,
    deletionPlan,
  };
  db.close();
  return result;
}
if (mode === "seed") seed();
else if (mode === "measure") console.log(JSON.stringify(await measure()));
else {
  const results = [];
  for (const [populationRows, populationRecipients] of [
    [577501, 88],
    [2310004, 352],
  ]) {
    const seeded = mkdtempSync(path.join(tmpdir(), "compact-seed-"));
    try {
      execFileSync(
        process.execPath,
        [
          fileURLToPath(import.meta.url),
          "seed",
          seeded,
          String(populationRows),
          String(populationRecipients),
        ],
        { stdio: ["ignore", "ignore", "inherit"] },
      );
      for (const candidate of variants) {
        const root = mkdtempSync(path.join(tmpdir(), "compact-decisions-"));
        try {
          cpSync(
            path.join(seeded, "state.sqlite3"),
            path.join(root, "state.sqlite3"),
          );
          const args = [
            fileURLToPath(import.meta.url),
            "measure",
            root,
            String(populationRows),
            String(populationRecipients),
            candidate,
          ];
          const result = JSON.parse(
            execFileSync(process.execPath, args, { encoding: "utf8" }),
          );
          results.push(result);
          process.stderr.write(
            `${populationRows} ${candidate}: ${result.databaseBytes} bytes, ${result.migrationMs.toFixed(1)} ms\n`,
          );
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    } finally {
      rmSync(seeded, { recursive: true, force: true });
    }
  }
  console.log(
    JSON.stringify({ capturedAt: new Date().toISOString(), results }, null, 2),
  );
}

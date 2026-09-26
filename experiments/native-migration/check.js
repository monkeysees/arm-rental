import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRunner } from "../native-maintenance/runner.js";
import { verifyReplayResult } from "../node-replay/verify.js";
import { hash, hashes } from "../service-replay/common.js";

const [
  destination,
  executable,
  legacyExecutable,
  image = "arm-rental-native-service:local",
] = process.argv.slice(2);
assert(
  destination && executable && legacyExecutable,
  "Usage: node experiments/native-migration/check.js NEW_DIRECTORY ABSOLUTE_BINARY LEGACY_BINARY [IMAGE]",
);
const output = path.resolve(destination);
const binary = path.resolve(executable);
const legacy = path.resolve(legacyExecutable);
mkdirSync(output);
execFileSync(process.execPath, [
  "experiments/node-replay/export.js",
  path.join(output, "fixtures"),
]);
const { run, records, imageId } = await createRunner(output, binary, image);
const save = (name, data) =>
  writeFileSync(
    path.join(output, `${name}.json`),
    JSON.stringify(data, null, 2) + "\n",
  );
const replay = (database, stage) => [
  "--fixtures",
  "/state/fixtures",
  "--database",
  database,
  "--users",
  "500",
  "--mode",
  "virtual",
  "--stage",
  stage,
];
const migrate = (name, stop) => [
  "migrate",
  "--database",
  "/state/source.sqlite3",
  "--output",
  `/state/${name}`,
  ...(stop ? ["--stop", stop] : []),
];
const exercise = await run(
  "exercise",
  replay("/state/source.sqlite3", "exercise"),
  23,
  legacy,
);
const sourceFile = path.join(output, "source.sqlite3");
const sourceHash = hash(sourceFile);
const sourceWalHash = hash(`${sourceFile}-wal`);
function unchanged() {
  assert.equal(hash(sourceFile), sourceHash);
  assert.equal(hash(`${sourceFile}-wal`), sourceWalHash);
}
function fingerprints(file, version) {
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec("PRAGMA cache_size=-512; PRAGMA query_only=ON");
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, version);
  const digests = {};
  for (const [table, order] of [
    ["decisions", "user,id"],
    ["listings", "id"],
    ["seed_input", "id"],
    ["seed_progress", "id"],
    ["history", "digest"],
    ["recovery", "drain,stamp"],
  ]) {
    const digest = createHash("sha256");
    let rows = 0;
    for (const row of db
      .prepare(`SELECT * FROM ${table} ORDER BY ${order}`)
      .iterate()) {
      digest.update(JSON.stringify(row) + "\n");
      rows++;
    }
    digests[table] = { rows, sha256: digest.digest("hex") };
  }
  db.close();
  return digests;
}
const original = fingerprints(sourceFile, 0);
assert.equal(original.decisions.rows, 3321500);
await run(
  "legacy-service-rejected",
  replay("/state/source.sqlite3", "resume"),
  1,
);
unchanged();
const migration = await run("migration", migrate("migrated"));
unchanged();
assert.equal(migration.sourceVersion, 0);
assert.equal(migration.targetVersion, 1);
assert.equal(migration.state.pendingRows, 3000);
assert.deepEqual(
  fingerprints(path.join(output, "migrated/state.sqlite3"), 1),
  original,
);
await run("validate", [
  "validate",
  "--database",
  "/state/migrated/state.sqlite3",
]);
await run(
  "already-current",
  [
    "migrate",
    "--database",
    "/state/migrated/state.sqlite3",
    "--output",
    "/state/already",
  ],
  1,
);
assert(!existsSync(path.join(output, "already")));
async function resume(label, database, executable = binary) {
  const resumed = await run(label, replay(database, "resume"), 0, executable);
  const combined = {
    ...resumed,
    phases: [...exercise.phases, ...resumed.phases],
  };
  verifyReplayResult(combined);
  return combined;
}
const result = await resume("resume", "/state/migrated/state.sqlite3");
save("result", result);
const wrong = structuredClone(result);
wrong.phases.find((p) => p.name === "resumed").deliveriesByProfile[0].reverse();
assert.throws(() => verifyReplayResult(wrong));
for (const point of [
  "before-copy",
  "during-copy",
  "after-copy",
  "during-migration",
  "before-migration-commit",
  "after-migration",
  "before-publish",
  "after-publish",
]) {
  const name = `stop-${point}`;
  await run(name, migrate(name, point), 26);
  const published = path.join(output, name, "state.sqlite3");
  assert.equal(existsSync(published), point === "after-publish");
  if (point === "after-publish")
    await resume(`${name}-resume`, `/state/${name}/state.sqlite3`);
  if (point !== "before-copy") await run(`${name}-reuse`, migrate(name), 1);
  const retry = `${name}-retry`;
  await run(retry, migrate(retry));
  await resume(`${retry}-resume`, `/state/${retry}/state.sqlite3`);
  unchanged();
  // Only directories created by this invocation are discarded; reports remain.
  rmSync(path.join(output, name), { recursive: true, force: true });
  rmSync(path.join(output, retry), { recursive: true });
}
unchanged();
// The original binary can still resume the original database: actual rollback.
await resume("rollback-resume", "/state/source.sqlite3", legacy);
save("acceptance", {
  version: 1,
  status: "passed",
  users: 500,
  sourceVersion: 0,
  targetVersion: 1,
  oraclePassed: true,
  oracleNegativeControlPassed: true,
  rollbackOraclePassed: true,
  sourceDatabaseSha256BeforeRollback: sourceHash,
  sourceWalSha256BeforeRollback: sourceWalHash,
  preservedTables: original,
  binarySha256: hash(binary),
  legacyBinarySha256: hash(legacy),
  legacySourceRevision: "d75fa00a8d277f5a572a239667b1dc8b17d90263",
  imageId,
  sourceHashes: hashes("experiments/rust-replay"),
  harnessSha256: hash("experiments/native-migration/check.js"),
  runnerSha256: hash("experiments/native-maintenance/runner.js"),
  nodeVersion: process.version,
  host: execFileSync("uname", ["-a"], { encoding: "utf8" }).trim(),
  diskSampling:
    "10 ms logical file sizes, per-category maxima; excludes filesystem metadata and unlinked open files; retained failed/retry databases removed after verification",
  records,
});
console.log(
  JSON.stringify({ status: "passed", output, operations: records.length }),
);

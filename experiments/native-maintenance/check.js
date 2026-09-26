import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { verifyReplayResult } from "../node-replay/verify.js";
import { hash, hashes } from "../service-replay/common.js";

import { createRunner } from "./runner.js";

const execute = promisify(execFile);
const [destination, executable, image = "arm-rental-native-service:local"] =
  process.argv.slice(2);
assert(
  destination && executable,
  "Usage: node experiments/native-maintenance/check.js NEW_DIRECTORY ABSOLUTE_BINARY [IMAGE]",
);
const output = path.resolve(destination);
const binary = path.resolve(executable);
mkdirSync(output);
await execute(process.execPath, [
  "experiments/node-replay/export.js",
  path.join(output, "fixtures"),
]);
const { run, records, imageId } = await createRunner(output, binary, image);
const exercise = await run(
  "exercise",
  [
    "--fixtures",
    "/state/fixtures",
    "--database",
    "/state/source.sqlite3",
    "--users",
    "500",
    "--mode",
    "virtual",
  ],
  23,
);
await run("backup", [
  "backup",
  "--database",
  "/state/source.sqlite3",
  "--output",
  "/state/backup",
]);
await run("validate", [
  "validate",
  "--database",
  "/state/backup/state.sqlite3",
]);
await run("restore", [
  "restore",
  "--database",
  "/state/backup/state.sqlite3",
  "--output",
  "/state/restored",
]);
const resumed = await run("resume", [
  "--fixtures",
  "/state/fixtures",
  "--database",
  "/state/restored/state.sqlite3",
  "--users",
  "500",
  "--mode",
  "virtual",
  "--stage",
  "resume",
]);
const result = { ...resumed, phases: [...exercise.phases, ...resumed.phases] };
verifyReplayResult(result);
const wrong = structuredClone(result);
wrong.phases
  .find((phase) => phase.name === "resumed")
  .deliveriesByProfile[0].reverse();
assert.throws(() => verifyReplayResult(wrong));
writeFileSync(
  path.join(output, "result.json"),
  JSON.stringify(result, null, 2) + "\n",
);
for (const command of ["backup", "restore"]) {
  for (const point of [
    "during-copy",
    "after-copy",
    "before-publish",
    "after-publish",
  ]) {
    const label = `${command}-${point}`;
    await run(
      label,
      [
        command,
        "--database",
        "/state/backup/state.sqlite3",
        "--output",
        `/state/${label}`,
        "--stop",
        point,
      ],
      26,
    );
    const files = readdirSync(path.join(output, label));
    assert.equal(files.includes("state.sqlite3"), point === "after-publish");
    if (point === "after-publish")
      await run(`${label}-validate`, [
        "validate",
        "--database",
        `/state/${label}/state.sqlite3`,
      ]);
    await run(
      `${label}-reuse`,
      [
        command,
        "--database",
        "/state/backup/state.sqlite3",
        "--output",
        `/state/${label}`,
      ],
      1,
    );
  }
}
await run("retry", [
  "restore",
  "--database",
  "/state/backup/state.sqlite3",
  "--output",
  "/state/retry",
]);
const retry = await run("retry-resume", [
  "--fixtures",
  "/state/fixtures",
  "--database",
  "/state/retry/state.sqlite3",
  "--users",
  "500",
  "--mode",
  "virtual",
  "--stage",
  "resume",
]);
verifyReplayResult({ ...retry, phases: [...exercise.phases, ...retry.phases] });
writeFileSync(
  path.join(output, "acceptance.json"),
  JSON.stringify(
    {
      version: 1,
      status: "passed",
      users: 500,
      oraclePassed: true,
      oracleNegativeControlPassed: true,
      binarySha256: hash(binary),
      imageId,
      sourceHashes: hashes("experiments/rust-replay"),
      harnessSha256: hash("experiments/native-maintenance/check.js"),
      nodeVersion: process.version,
      records,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({ status: "passed", output, operations: records.length }),
);

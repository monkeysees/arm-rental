import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir, arch, cpus, release } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { contract } from "./fixture.js";
import { cgroup, memory } from "./metrics.js";
import { evaluateCapacity } from "./capacity.js";
const { values } = parseArgs({
  options: {
    users: { type: "string", default: "500" },
    mode: { type: "string", default: "virtual" },
    runtime: { type: "string", default: "node" },
    "go-binary": { type: "string" },
  },
});
const users = Number(values.users),
  mode = values.mode;
assert(
  [4, ...contract.populations].includes(users),
  "Use 500 or 1000 recipients (4 is a diagnostic)",
);
assert(["virtual", "wall"].includes(mode));
assert(["node", "go"].includes(values.runtime));
if (values.runtime === "go") {
  const { runGoReplay } = await import("../go-replay/run.js");
  await runGoReplay({ users, mode, binary: values["go-binary"] });
  process.exit(0);
}
const directory = mkdtempSync(path.join(tmpdir(), "node-replay-"));
const root = fileURLToPath(new URL("../..", import.meta.url));
const sourceHashes = {};
for (const folder of ["src", "experiments/node-replay"]) {
  for (const name of readdirSync(path.join(root, folder)).sort()) {
    if (!/\.(js|json)$/.test(name)) continue;
    sourceHashes[`${folder}/${name}`] = createHash("sha256")
      .update(readFileSync(path.join(root, folder, name)))
      .digest("hex");
  }
}
const workers = [];
try {
  for (const stage of ["seed", "exercise", "resume"]) {
    const resultFile = path.join(directory, `${stage}.json`);
    const exitCode = await new Promise((resolve, reject) => {
      const worker = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("./worker.js", import.meta.url)),
          directory,
          stage,
          String(users),
          mode,
          resultFile,
        ],
        { stdio: ["ignore", "ignore", "inherit"] },
      );
      worker.on("error", reject);
      worker.on("exit", (code, signal) =>
        signal
          ? reject(new Error(`worker killed by ${signal}`))
          : resolve(code),
      );
    });
    assert.equal(exitCode, stage === "exercise" ? 23 : 0, `${stage} exit code`);
    workers.push(JSON.parse(readFileSync(resultFile, "utf8")));
  }
  const phases = workers.flatMap((worker) => worker.results);
  const primaryRamBytes = memory().servicePeakBytes;
  console.log(
    JSON.stringify(
      {
        version: 1,
        status: "passed",
        node: process.version,
        mode,
        diagnostic: users === 4,
        host: {
          arch: arch(),
          kernel: release(),
          cpu: cpus()[0].model,
          logicalCpus: cpus().length,
        },
        limits: {
          cpu: cgroup("cpu.max"),
          memory: cgroup("memory.max"),
          swap: cgroup("memory.swap.max"),
        },
        workload: {
          users,
          decisionsPerRecipient: contract.seed.decisionsPerRecipient,
          retainedListings: contract.seed.listingCount,
          absentListings: contract.seed.absentCount,
        },
        sourceHashes,
        workers,
        phases,
        primaryRamBytes,
        restart: {
          uncleanExitCode: 23,
          acknowledgedPrefixPreserved: true,
          unsentSuffixDelivered: true,
        },
        capacity: evaluateCapacity({ users, mode, phases, primaryRamBytes }),
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}

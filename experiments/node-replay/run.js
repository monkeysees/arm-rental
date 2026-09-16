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
const { values } = parseArgs({
  options: {
    users: { type: "string", default: "500" },
    mode: { type: "string", default: "virtual" },
  },
});
const users = Number(values.users),
  mode = values.mode;
assert(
  [4, ...contract.populations].includes(users),
  "Use 500 or 1000 recipients (4 is a diagnostic)",
);
assert(["virtual", "wall"].includes(mode));
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
  const routine = phases.filter((phase) =>
    ["updated", "fresh"].includes(phase.name),
  );
  const catchup = phases.find((phase) => phase.name === "catchup");
  const primaryRamBytes = memory().servicePeakBytes;
  const fairProgressDeadlineMs =
    catchup.classificationWallMs +
    (2 * users * 1000) / contract.transport.globalAttemptsPerSecond +
    contract.transport.retryAfterMs +
    contract.transport.latencyMs;
  const idealDrainMs = Math.max(
    (catchup.attempts * 1000) / contract.transport.globalAttemptsPerSecond,
    ((contract.initialDeliveryLimit + 1 - contract.transport.recipientBurst) *
      60000) /
      contract.transport.recipientMessagesPerMinute,
  );
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
        capacity:
          mode === "wall"
            ? {
                routineWithinCrawlInterval:
                  routine.reduce((sum, phase) => sum + phase.wallMs, 0) <=
                  contract.crawlIntervalMs,
                classificationWithinCrawlInterval:
                  routine.every(
                    (phase) => phase.classifiedRecipients === users,
                  ) &&
                  routine.reduce(
                    (sum, phase) => sum + phase.classificationWallMs,
                    0,
                  ) <= contract.crawlIntervalMs,
                catchupIdealDrainMs: idealDrainMs,
                catchupWithinPermittedRateTarget:
                  catchup.wallMs <=
                  idealDrainMs * contract.measurement.capacityDrainTolerance,
                tolerance: contract.measurement.capacityDrainTolerance,
                allRecipientsProgressed:
                  catchup.recipientsWithProgress === users,
                fairProgressDeadlineMs,
                fairProgress:
                  catchup.firstRecipientProgressMs.max <=
                  fairProgressDeadlineMs *
                    contract.measurement.capacityDrainTolerance,
                withinApplicationMemoryLimit:
                  primaryRamBytes === null
                    ? null
                    : primaryRamBytes <= contract.measurement.memoryBytes,
              }
            : null,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}

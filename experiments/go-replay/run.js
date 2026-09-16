import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyGoSlice } from "../node-replay/verify.js";
import { contract } from "../node-replay/fixture.js";

export async function runGoReplay({ users, mode, binary }) {
  assert(
    binary && path.isAbsolute(binary),
    "--go-binary must be an absolute executable path",
  );
  const directory = mkdtempSync(path.join(tmpdir(), "go-replay-"));
  const root = fileURLToPath(new URL("../..", import.meta.url));
  try {
    const fixtures = path.join(directory, "fixtures");
    execFileSync(process.execPath, [
      path.join(root, "experiments/node-replay/export.js"),
      fixtures,
    ]);
    const output = await new Promise((resolve, reject) => {
      const child = spawn(
        binary,
        [
          "--fixtures",
          fixtures,
          "--database",
          path.join(directory, "state.sqlite3"),
          "--users",
          String(users),
          "--mode",
          mode,
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      const chunks = [];
      child.stdout.on("data", (chunk) => chunks.push(chunk));
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0
          ? resolve(Buffer.concat(chunks))
          : reject(new Error(`Go replay exit ${code}`)),
      );
    });
    const result = JSON.parse(output);
    verifyGoSlice(result);
    result.sourceHashes = {};
    for (const folder of ["experiments/go-replay", "experiments/node-replay"]) {
      for (const name of readdirSync(path.join(root, folder)).sort()) {
        if (!/\.(go|mod|sum|js|json)$/.test(name)) continue;
        result.sourceHashes[`${folder}/${name}`] = createHash("sha256")
          .update(readFileSync(path.join(root, folder, name)))
          .digest("hex");
      }
    }
    result.binarySha256 = createHash("sha256")
      .update(readFileSync(binary))
      .digest("hex");
    const routine = result.phases.filter((p) =>
      ["updated", "fresh"].includes(p.name),
    );
    const catchup = result.phases.find((p) => p.name === "catchup");
    const idealDrainMs = Math.max(
      (catchup.attempts * 1000) / contract.transport.globalAttemptsPerSecond,
      ((contract.initialDeliveryLimit + 1 - contract.transport.recipientBurst) *
        60000) /
        contract.transport.recipientMessagesPerMinute,
    );
    const fairProgressDeadlineMs =
      catchup.classificationWallMs +
      (2 * users * 1000) / contract.transport.globalAttemptsPerSecond +
      contract.transport.retryAfterMs +
      contract.transport.latencyMs;
    result.capacity =
      mode === "wall"
        ? {
            routineWithinCrawlInterval:
              routine.reduce((sum, p) => sum + p.wallMs, 0) <=
              contract.crawlIntervalMs,
            classificationWithinCrawlInterval:
              routine.reduce((sum, p) => sum + p.classificationWallMs, 0) <=
              contract.crawlIntervalMs,
            catchupIdealDrainMs: idealDrainMs,
            catchupWithinPermittedRateTarget:
              catchup.wallMs <=
              idealDrainMs * contract.measurement.capacityDrainTolerance,
            fairProgressDeadlineMs,
            fairProgress:
              catchup.classificationWallMs + catchup.firstProgressMaxMs <=
              fairProgressDeadlineMs *
                contract.measurement.capacityDrainTolerance,
            withinApplicationMemoryLimit:
              result.resources.primaryRamBytes === null
                ? null
                : result.resources.primaryRamBytes <=
                  contract.measurement.memoryBytes,
          }
        : null;
    console.log(JSON.stringify(result, null, 2));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

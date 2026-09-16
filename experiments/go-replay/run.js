import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyGoSlice } from "../node-replay/verify.js";
import { evaluateCapacity } from "../node-replay/capacity.js";
import { memory } from "../node-replay/metrics.js";

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
    result.resources.primaryRamBytes = memory().servicePeakBytes;
    result.capacity = evaluateCapacity({
      users,
      mode,
      primaryRamBytes: result.resources.primaryRamBytes,
      phases: result.phases.map((phase) => ({
        ...phase,
        recipientsWithProgress: phase.sent > 0 ? phase.recipientsAsserted : 0,
        firstRecipientProgressMs: {
          max: phase.classificationWallMs + phase.firstProgressMaxMs,
        },
      })),
    });
    await new Promise((resolve, reject) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

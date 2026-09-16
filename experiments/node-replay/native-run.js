import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyNativeSlice } from "./verify.js";
import { evaluateCapacity } from "./capacity.js";
import { memory } from "./metrics.js";

function sourceFiles(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "target") return [];
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory())
      return sourceFiles(path.join(directory, entry.name), relative);
    return /\.(go|mod|sum|js|json|rs|toml|lock)$/.test(entry.name)
      ? [relative]
      : [];
  });
}

export async function runNativeReplay({ users, mode, binary, runtime }) {
  assert(
    binary && path.isAbsolute(binary),
    `--${runtime}-binary must be an absolute executable path`,
  );
  const directory = mkdtempSync(path.join(tmpdir(), `${runtime}-replay-`));
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
          : reject(new Error(`${runtime} replay exit ${code}`)),
      );
    });
    const result = JSON.parse(output);
    assert.equal(result.scope, `${runtime}-500-slice`);
    verifyNativeSlice(result);
    result.sourceHashes = {};
    for (const folder of [
      `experiments/${runtime}-replay`,
      "experiments/node-replay",
    ]) {
      for (const name of sourceFiles(path.join(root, folder)).sort()) {
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

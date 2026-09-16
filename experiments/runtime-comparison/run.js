import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { finished } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { verifyReplayResult } from "../node-replay/verify.js";

const {
  values,
  positionals: [output],
} = parseArgs({
  allowPositionals: true,
  options: {
    "go-binary": { type: "string" },
    "rust-binary": { type: "string" },
  },
});
assert(
  output,
  "Usage: run.js NEW_OUTPUT --go-binary ABSOLUTE_PATH --rust-binary ABSOLUTE_PATH",
);
for (const key of ["go-binary", "rust-binary"])
  assert(path.isAbsolute(values[key] ?? ""));
mkdirSync(output);
mkdirSync(path.join(output, "gates"));
const digest = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
const manifest = {
  startedAt: new Date().toISOString(),
  revision: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  workingTree: execFileSync("git", ["status", "--short"], {
    encoding: "utf8",
  }).trim(),
  binaryHashes: Object.fromEntries(
    Object.entries(values).map(([key, file]) => [key, digest(file)]),
  ),
  fixtureHashes: Object.fromEntries(
    ["contract.json", "fixture.js", "export.js"].map((name) => [
      name,
      digest(`experiments/node-replay/${name}`),
    ]),
  ),
  gates: [],
};
const save = () =>
  writeFileSync(
    path.join(output, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
save();
async function execute(program, args, stdoutFile) {
  const stream = stdoutFile ? createWriteStream(stdoutFile) : null;
  const child = spawn(program, args, {
    stdio: ["ignore", stream ? "pipe" : "inherit", "inherit"],
  });
  if (stream) child.stdout.pipe(stream);
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (stream) await finished(stream);
  assert.equal(code, 0, `${program} failed`);
}
// Gate every runtime and population before starting the final resource protocol.
for (const runtime of ["node", "go", "rust"]) {
  for (const users of [500, 1000]) {
    const filename = path.join(output, "gates", `${runtime}-${users}.json`);
    const args = [
      "run",
      "--rm",
      "--network",
      "none",
      "--cpus",
      "1",
      "--memory",
      "512m",
      "--memory-swap",
      "512m",
      "-v",
      `${process.cwd()}:/app:ro`,
      "-w",
      "/app",
      ...(runtime === "node"
        ? []
        : ["-v", `${values[`${runtime}-binary`]}:/replay:ro`]),
      "node:24.18.0-bookworm-slim",
      "node",
      "experiments/node-replay/run.js",
      "--users",
      String(users),
      "--mode",
      "virtual",
      ...(runtime === "node"
        ? []
        : ["--runtime", runtime, `--${runtime}-binary`, "/replay"]),
    ];
    console.error(`Behavior gate: ${runtime} ${users}`);
    await execute("docker", args, filename);
    verifyReplayResult(JSON.parse(readFileSync(filename, "utf8")));
    manifest.gates.push({
      runtime,
      users,
      args,
      sha256: digest(filename),
      status: "passed",
    });
    save();
  }
}
for (const runtime of ["node", "go", "rust"]) {
  await execute(process.execPath, [
    "experiments/node-replay/measure.js",
    path.join(output, runtime),
    "--runtime",
    runtime,
    ...(runtime === "node"
      ? []
      : [`--${runtime}-binary`, values[`${runtime}-binary`]]),
  ]);
}
await execute(
  process.execPath,
  [
    "experiments/runtime-comparison/report.js",
    ...["node", "go", "rust"].flatMap((runtime) => [
      `--${runtime}`,
      path.join(output, runtime),
    ]),
  ],
  path.join(output, "summary.json"),
);
for (const [key, file] of Object.entries(values))
  assert.equal(
    digest(file),
    manifest.binaryHashes[key],
    "Binary changed during protocol",
  );
manifest.finishedAt = new Date().toISOString();
save();

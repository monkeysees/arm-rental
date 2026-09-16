import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import {
  createWriteStream,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { contract } from "./fixture.js";
import { verifyReplayResult } from "./verify.js";

const {
  values,
  positionals: [output],
} = parseArgs({
  allowPositionals: true,
  options: {
    runtime: { type: "string", default: "node" },
    "go-binary": { type: "string" },
  },
});
assert(["node", "go"].includes(values.runtime));
if (values.runtime === "go") assert(path.isAbsolute(values["go-binary"] ?? ""));
assert(
  output,
  "Usage: node experiments/node-replay/measure.js NEW_RESULTS_DIRECTORY",
);
mkdirSync(output);
const root = fileURLToPath(new URL("../..", import.meta.url));
const image = "node:24.18.0-bookworm-slim";
function command(program, args) {
  try {
    return execFileSync(program, args, { encoding: "utf8" }).trim();
  } catch (error) {
    return `unavailable: ${error.message}`;
  }
}
const manifest = {
  protocol: contract.measurement,
  startedAt: new Date().toISOString(),
  image,
  runtime: values.runtime,
  scope: values.runtime === "go" ? "go-500-slice" : "full-contract",
  imageId: command("docker", [
    "image",
    "inspect",
    image,
    "--format",
    "{{.Id}}",
  ]),
  host: {
    cpu: command("lscpu", []),
    storage: command("lsblk", ["-d", "-o", "NAME,MODEL,SIZE,ROTA"]),
    filesystem: command("df", ["-T", "/tmp"]),
    swap: readFileSync("/proc/swaps", "utf8"),
    docker: command("docker", [
      "info",
      "--format",
      "{{.Architecture}} {{.Driver}} {{.MemTotal}}",
    ]),
  },
  runs: [],
};
const save = () =>
  writeFileSync(
    path.join(output, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
save();
for (const users of values.runtime === "go" ? [500] : contract.populations) {
  for (const [mode, count] of [
    ["virtual", 1],
    ["wall", contract.measurement.repeats],
  ]) {
    for (let repeat = 1; repeat <= count; repeat++) {
      const name = `${users}-${mode}-${repeat}`;
      console.error(`Starting ${name}`);
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
        `${root}:/app:ro`,
        "-w",
        "/app",
        ...(values.runtime === "go"
          ? ["-v", `${values["go-binary"]}:/replay:ro`]
          : []),
        image,
        "node",
        "experiments/node-replay/run.js",
        "--users",
        String(users),
        "--mode",
        mode,
        ...(values.runtime === "go"
          ? ["--runtime", "go", "--go-binary", "/replay"]
          : []),
      ];
      const stdout = createWriteStream(path.join(output, `${name}.json`));
      const stderr = createWriteStream(path.join(output, `${name}.log`));
      const startedAt = new Date().toISOString();
      const exitCode = await new Promise((resolve, reject) => {
        const child = spawn("docker", args, {
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout.pipe(stdout);
        child.stderr.pipe(stderr);
        child.on("error", reject);
        child.on("close", (code) => resolve(code));
      });
      await Promise.all(
        [stdout, stderr].map((stream) =>
          stream.writableFinished
            ? null
            : new Promise((resolve) => stream.on("finish", resolve)),
        ),
      );
      const run = {
        name,
        args,
        startedAt,
        finishedAt: new Date().toISOString(),
        exitCode,
      };
      if (exitCode === 0) {
        try {
          const result = JSON.parse(
            readFileSync(path.join(output, `${name}.json`), "utf8"),
          );
          verifyReplayResult(result);
          run.behavior = "passed";
          run.capacity = result.capacity;
        } catch (error) {
          run.behavior = "failed";
          run.failure = error.message;
        }
      } else {
        run.behavior = "failed";
      }
      manifest.runs.push(run);
      save();
      console.error(`Finished ${name}: ${run.behavior}`);
    }
  }
}
manifest.finishedAt = new Date().toISOString();
save();
if (manifest.runs.some((run) => run.behavior !== "passed"))
  process.exitCode = 1;

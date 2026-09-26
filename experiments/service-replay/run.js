import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { boundary, hash, hashes } from "./common.js";
import { verifyServiceReplay } from "./report.js";
import { contract } from "../node-replay/fixture.js";

const {
  values,
  positionals: [output],
} = parseArgs({
  allowPositionals: true,
  options: {
    runtime: { type: "string" },
    image: { type: "string" },
    "native-baseline": { type: "string" },
    holder: { type: "string" },
    "memory-bytes": { type: "string", default: "536870912" },
    users: { type: "string", default: "500" },
    mode: { type: "string", default: "all" },
    repeats: { type: "string", default: "3" },
  },
});
assert(
  output && path.isAbsolute(output),
  "Usage: run.js /ABSOLUTE/NEW_OUTPUT --runtime go|rust --holder /ABSOLUTE/HOLDER --native-baseline /ABSOLUTE/BASELINE.json [--memory-bytes INTEGER]",
);
assert(["go", "rust"].includes(values.runtime));
assert(path.isAbsolute(values.holder ?? ""));
assert(
  path.isAbsolute(values["native-baseline"] ?? ""),
  "--native-baseline must identify the current native binary and source hashes",
);
const memoryBytes = Number(values["memory-bytes"]);
assert(
  /^\d+$/.test(values["memory-bytes"]) &&
    Number.isSafeInteger(memoryBytes) &&
    memoryBytes >= 6 * 1024 * 1024,
  "memory limit must be exact bytes, at least Docker's 6 MiB minimum",
);
const populations = values.users.split(",").map(Number);
assert(
  populations.length &&
    populations.every((users) => [4, ...contract.populations].includes(users)),
);
assert(["all", "virtual", "wall"].includes(values.mode));
const repeats = Number(values.repeats);
assert(Number.isInteger(repeats) && repeats > 0);
const command = (program, args) =>
  execFileSync(program, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
assert.equal(
  memoryBytes % Number(command("getconf", ["PAGESIZE"])),
  0,
  "exact-byte memory limit must be page-aligned",
);
const root = process.cwd();
const runtime = values.runtime;
const image = values.image ?? `arm-rental-comparison-${runtime}:local`;
const imageInfo = JSON.parse(command("docker", ["image", "inspect", image]))[0];
assert.equal(
  imageInfo.Config.Labels["com.rental-apartments.experiment.runtime"],
  runtime,
);
const harnessImage = command("docker", [
  "image",
  "inspect",
  "node:24.18.0-bookworm-slim",
  "--format",
  "{{.Id}}",
]);
mkdirSync(output);
chmodSync(output, 0o777);
const temporary = command("docker", ["create", imageInfo.Id]);
try {
  command("docker", [
    "cp",
    `${temporary}:/usr/local/bin/replay`,
    path.join(output, "replay"),
  ]);
} finally {
  command("docker", ["rm", temporary]);
}
const binarySha256 = hash(path.join(output, "replay"));
rmSync(path.join(output, "replay"));
const sourceHashes = Object.fromEntries(
  [
    `experiments/${runtime}-replay`,
    "experiments/node-replay",
    "experiments/service-replay",
  ].flatMap((folder) =>
    Object.entries(hashes(folder)).map(([name, digest]) => [
      `${folder}/${name}`,
      digest,
    ]),
  ),
);
const baseline = JSON.parse(readFileSync(values["native-baseline"], "utf8"));
assert.equal(
  binarySha256,
  baseline.binarySha256,
  "image must contain the identified baseline binary",
);
const nativeSourceHashes = Object.fromEntries(
  Object.entries(baseline.sourceHashes).filter(([file]) =>
    file.startsWith(`experiments/${runtime}-replay/`),
  ),
);
for (const [file, digest] of Object.entries(nativeSourceHashes))
  assert.equal(
    sourceHashes[file],
    digest,
    "native source differs from the measured comparison binary",
  );
const nativeBaseline = {
  binarySha256: baseline.binarySha256,
  sourceHashes: nativeSourceHashes,
};
const manifest = {
  boundary,
  originalProtocol: contract.measurement,
  runtime,
  memoryBytes,
  startedAt: new Date().toISOString(),
  revision: command("git", ["rev-parse", "HEAD"]),
  workingTree: command("git", ["status", "--short"]),
  imageInfo,
  harnessImage,
  binarySha256,
  holderSha256: hash(values.holder),
  sourceHashes,
  nativeBaseline,
  host: {
    cpu: command("lscpu", []),
    kernel: command("uname", ["-a"]),
    filesystem: command("df", ["-T", output]),
    docker: command("docker", [
      "info",
      "--format",
      "{{.Architecture}} {{.Driver}} {{.MemTotal}}",
    ]),
    swap: readFileSync("/proc/swaps", "utf8"),
  },
  runs: [],
};
const save = () =>
  writeFileSync(
    path.join(output, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
save();
for (const users of populations) {
  for (const mode of values.mode === "all"
    ? ["virtual", "wall"]
    : [values.mode]) {
    for (
      let repeat = 1;
      repeat <= (mode === "virtual" ? 1 : repeats);
      repeat++
    ) {
      const name = `${users}-${mode}-${repeat}`;
      const directory = path.join(output, name);
      mkdirSync(directory);
      chmodSync(directory, 0o777);
      const configFile = path.join(directory, "config.json");
      writeFileSync(
        configFile,
        JSON.stringify({
          directory,
          runtime,
          users,
          mode,
          memoryBytes,
          imageId: imageInfo.Id,
          holder: values.holder,
          binarySha256,
          sourceHashes,
          nativeBaseline,
        }),
      );
      const args = [
        "run",
        "--rm",
        "--network",
        "none",
        "--cgroupns",
        "host",
        "--pid",
        "host",
        "--cpus",
        "1",
        "--memory",
        "536870912",
        "--memory-swap",
        "536870912",
        "-v",
        "/var/run/docker.sock:/var/run/docker.sock",
        "-v",
        "/usr/bin/docker:/usr/local/bin/docker:ro",
        "-v",
        "/proc:/host-proc:ro",
        "-v",
        "/sys/fs/cgroup:/host-cgroup:ro",
        "-v",
        `${root}:${root}:ro`,
        "-v",
        `${output}:${output}`,
        "-v",
        `${values.holder}:${values.holder}:ro`,
        "-w",
        root,
        harnessImage,
        "node",
        "experiments/service-replay/worker.js",
        configFile,
      ];
      console.error(`Starting ${runtime} ${name}`);
      const run = { name, args, startedAt: new Date().toISOString() };
      run.exitCode = await new Promise((resolve, reject) => {
        const child = spawn("docker", args, {
          stdio: ["ignore", "inherit", "inherit"],
        });
        child.on("error", reject);
        child.on("close", resolve);
      });
      run.finishedAt = new Date().toISOString();
      if (run.exitCode === 0) {
        const resultFile = path.join(directory, "result.json");
        const result = JSON.parse(readFileSync(resultFile, "utf8"));
        run.capacity = verifyServiceReplay(result);
        run.sha256 = hash(resultFile);
        run.behavior = "passed";
      } else {
        run.behavior = "failed";
      }
      manifest.runs.push(run);
      save();
      console.error(`Finished ${name}: ${run.behavior}`);
      assert.equal(
        run.exitCode,
        0,
        `Replay failed; evidence retained at ${directory}`,
      );
    }
  }
}
for (const [file, digest] of Object.entries(sourceHashes))
  assert.equal(hash(file), digest, "source changed during measurement");
assert.equal(hash(values.holder), manifest.holderSha256);
manifest.finishedAt = new Date().toISOString();
save();

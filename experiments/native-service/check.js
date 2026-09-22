import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { verifyReplayResult } from "../node-replay/verify.js";
import { cgroupSample, hashes } from "../service-replay/common.js";

const execute = promisify(execFile);
const docker = async (...args) =>
  (
    await execute("docker", args, { maxBuffer: 16 * 1024 * 1024 })
  ).stdout.trim();
const [destination, image = "arm-rental-native-service:local"] =
  process.argv.slice(2);
assert(
  destination,
  "Usage: node experiments/native-service/check.js NEW_DIRECTORY [IMAGE]",
);
const output = path.resolve(destination);
mkdirSync(output);
await execute(process.execPath, [
  "experiments/node-replay/export.js",
  path.join(output, "fixtures"),
]);
const runId = `native-service-${process.pid}`;
const network = `${runId}-net`;
const behavior = (value) =>
  writeFileSync(path.join(output, "behavior.txt"), value);
const requests = () =>
  readFileSync(path.join(output, "requests.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
writeFileSync(path.join(output, "requests.jsonl"), "");
behavior("normal");
const containers = new Set();
const records = [];
const timers = new Set();
async function health(name) {
  try {
    return {
      ready: true,
      text: await docker(
        "exec",
        name,
        "/usr/local/bin/replay",
        "health",
        "--socket",
        "/state/control.sock",
      ),
    };
  } catch (error) {
    return { ready: false, text: error.stdout?.trim() || error.stderr?.trim() };
  }
}
async function until(predicate, label, timeout = 120000) {
  const start = Date.now();
  while (!(await predicate())) {
    assert(Date.now() - start < timeout, `timeout: ${label}`);
    await delay(50);
  }
}
async function launch(
  label,
  stage,
  mode = "virtual",
  users = "4",
  directory = label,
) {
  const state = path.join(output, directory);
  if (!existsSync(state)) mkdirSync(state);
  const name = `${runId}-${label}`;
  const args = [
    "run",
    "-d",
    "--name",
    name,
    "--network",
    network,
    "--cpus",
    "1",
    "--memory",
    "512m",
    "--memory-swap",
    "512m",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "-v",
    `${state}:/state`,
    image,
    "serve",
    "--socket",
    "/state/control.sock",
    "--directory",
    "/state/work",
    "--url",
    "http://fixture:8080",
    "--stage",
    stage,
    "--mode",
    mode,
    "--users",
    users,
  ];
  await docker(...args);
  containers.add(name);
  const config = JSON.parse(await docker("inspect", name))[0];
  const pid = config.State.Pid;
  const relative = pid
    ? readFileSync(`/proc/${pid}/cgroup`, "utf8").trim().split("::")[1]
    : "/exited";
  const cgroup = path.join("/sys/fs/cgroup", relative);
  assert.notEqual(
    relative,
    readFileSync("/proc/self/cgroup", "utf8").trim().split("::")[1],
  );
  const record = { label, args, config, samples: [], health: [] };
  records.push(record);
  const timer = setInterval(() => {
    try {
      const sample = cgroupSample(cgroup);
      sample.at = Date.now();
      sample.processes = readFileSync(path.join(cgroup, "cgroup.procs"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .flatMap((pid) => {
          try {
            return [
              {
                pid: Number(pid),
                command: readFileSync(`/proc/${pid}/cmdline`, "utf8")
                  .replaceAll("\0", " ")
                  .trim(),
              },
            ];
          } catch {
            return [];
          }
        });
      record.samples.push(sample);
    } catch {
      /* The cgroup vanishes after process exit. */
    }
  }, 100);
  timers.add(timer);
  async function finish(expected = 0) {
    const code = Number(await docker("wait", name));
    clearInterval(timer);
    record.exitCode = code;
    record.logs = await docker("logs", name);
    assert.equal(code, expected, `${label}: ${record.logs}`);
    const inspected = JSON.parse(await docker("inspect", name))[0];
    assert.equal(inspected.State.OOMKilled, false);
    assert.equal(inspected.State.Pid, 0);
    await docker("rm", name);
    containers.delete(name);
    return record;
  }
  return { name, state, record, finish };
}
try {
  await docker("network", "create", "--internal", network);
  const peer = `${runId}-peer`;
  await docker(
    "run",
    "-d",
    "--name",
    peer,
    "--network",
    network,
    "--network-alias",
    "fixture",
    "-v",
    `${output}:/fixtures`,
    "-v",
    `${path.resolve("experiments/native-service/peer.js")}:/peer.js:ro`,
    "node:24.18.0-bookworm-slim",
    "node",
    "/peer.js",
    "/fixtures",
  );
  containers.add(peer);
  await delay(500);
  behavior("stall");
  const early = await launch("early-stop", "exercise");
  await until(() => requests().length > 0, "curl started");
  await delay(150);
  assert.equal((await health(early.name)).ready, false);
  await docker("kill", "--signal", "SIGTERM", early.name);
  await early.finish();
  assert.equal(
    JSON.parse(
      readFileSync(path.join(early.state, "work/exercise-transport.json")),
    ).transport.cancelled,
    1,
  );
  for (const failure of [
    "http-error",
    "oversized",
    "oversized-chunked",
    "bad-body",
  ]) {
    behavior(failure);
    const service = await launch(failure, "exercise");
    await service.finish(1);
    assert(!existsSync(path.join(service.state, "work/state.sqlite3")));
  }
  behavior("normal");
  writeFileSync(path.join(output, "requests.jsonl"), "");
  const exercise = await launch(
    "exercise",
    "exercise",
    "wall",
    "500",
    "recovery",
  );
  await until(async () => {
    const result = await health(exercise.name);
    exercise.record.health.push(result);
    return result.text === "ok active";
  }, "native active readiness");
  await delay(7000);
  assert.equal((await health(exercise.name)).text, "ok active");
  assert(requests().filter((r) => r.name === "probe").length > 2);
  behavior("stall-probe");
  const before = requests().length;
  await until(() => requests().length > before, "active curl child");
  await docker("kill", "--signal", "SIGINT", exercise.name);
  assert.equal((await health(exercise.name)).ready, false);
  await exercise.finish();
  const first = JSON.parse(
    readFileSync(path.join(exercise.state, "work/exercise.json")),
  );
  assert.equal(first.resources.pendingRows, 3000);
  const transport = JSON.parse(
    readFileSync(path.join(exercise.state, "work/exercise-transport.json")),
  );
  assert.equal(transport.transport.cancelled, 1);
  behavior("normal");
  const resume = await launch("resume", "resume", "wall", "500", "recovery");
  await until(async () => {
    const result = await health(resume.name);
    resume.record.health.push(result);
    return result.text === "ok drained";
  }, "durable suffix drain");
  assert.equal(
    await docker(
      "exec",
      resume.name,
      "/usr/local/bin/replay",
      "shutdown",
      "--socket",
      "/state/control.sock",
    ),
    "ok draining",
  );
  await resume.finish();
  const second = JSON.parse(
    readFileSync(path.join(resume.state, "work/resume.json")),
  );
  const combined = { ...second, phases: [...first.phases, ...second.phases] };
  assert(verifyReplayResult(combined));
  writeFileSync(
    path.join(output, "result.json"),
    JSON.stringify(combined, null, 2),
  );
  const corrupted = structuredClone(combined);
  corrupted.phases
    .find((p) => p.name === "fresh")
    .deliveriesByProfile[0].reverse();
  assert.throws(() => verifyReplayResult(corrupted));
  for (const record of records) {
    if (["exercise", "resume", "early-stop"].includes(record.label))
      assert(record.samples.length > 0);
    for (const sample of record.samples) {
      assert.equal(sample.memoryLimit, 536870912);
      assert.equal(sample.swapLimit, 0);
      assert.equal(sample.cpuLimit, "100000 100000");
      for (const proc of sample.processes)
        assert.match(
          proc.command,
          /^(\/usr\/local\/bin\/(replay|curl-impersonate)|runc init|$)/,
        );
    }
  }
  assert(
    exercise.record.samples.some((s) =>
      s.processes.some((p) => p.command.includes("curl-impersonate")),
    ),
  );
  // Export the immutable image filesystem to verify its runtime closure externally.
  const audit = `${runId}-audit`;
  await docker("create", "--name", audit, image);
  containers.add(audit);
  await docker("export", "-o", path.join(output, "image.tar"), audit);
  const files = (
    await execute("tar", ["-tf", path.join(output, "image.tar")], {
      maxBuffer: 16 * 1024 * 1024,
    })
  ).stdout.split("\n");
  for (const forbidden of [
    "node",
    "npm",
    "sh",
    "bash",
    "dash",
    "apt",
    "apt-get",
    "dpkg",
    "cargo",
  ])
    assert(!files.some((f) => f.split("/").at(-1) === forbidden), forbidden);
  assert(files.includes("usr/local/bin/curl-impersonate"));
  assert(files.includes("etc/ssl/certs/ca-certificates.crt"));
  const curl = await execute(
    "tar",
    ["-xOf", path.join(output, "image.tar"), "usr/local/bin/curl-impersonate"],
    { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 },
  );
  const curlSha256 = createHash("sha256").update(curl.stdout).digest("hex");
  assert.equal(
    curlSha256,
    JSON.parse(readFileSync("docs/benchmarks/runtime-comparison/curl-1.json"))
      .binarySha256,
  );
  const version = await docker(
    "run",
    "--rm",
    "--network",
    "none",
    "--entrypoint",
    "/usr/local/bin/curl-impersonate",
    image,
    "--version",
  );
  assert.match(version, /libcurl\/8\.21\.0-IMPERSONATE/);
  const manifest = {
    status: "passed",
    boundary: "offline-native-service",
    platform: process.arch,
    nodeExternal: process.version,
    image: JSON.parse(await docker("image", "inspect", image))[0].Id,
    curlSha256,
    curlVersion: version,
    sourceHashes: hashes("experiments/rust-replay"),
    fixtureHashes: hashes(path.join(output, "fixtures")),
    requests: requests(),
    maximumActive: Math.max(...requests().map((r) => r.active)),
    records,
    transport,
    decisionRows: combined.resources.decisionRows,
  };
  writeFileSync(
    path.join(output, "acceptance.json"),
    JSON.stringify(manifest, null, 2),
  );
  console.log(
    JSON.stringify({
      status: "passed",
      decisionRows: manifest.decisionRows,
      curlSha256,
      output,
    }),
  );
} finally {
  for (const timer of timers) clearInterval(timer);
  for (const name of containers) {
    try {
      await docker("rm", "-f", name);
    } catch {
      /* Retain original failure. */
    }
  }
  await docker("network", "rm", network).catch(() => {});
  writeFileSync(
    path.join(output, "observations.json"),
    JSON.stringify({ records, requests: requests() }, null, 2),
  );
}

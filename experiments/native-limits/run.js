import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  existsSync,
  unlinkSync,
  lstatSync,
  copyFileSync,
  cpSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { evaluateCapacity } from "../node-replay/capacity.js";
import { verifyReplayResult } from "../node-replay/verify.js";
import { cgroupSample, hashes, hash } from "../service-replay/common.js";

const execute = promisify(execFile);
const command = async (cmd, args, timeout = 300000) =>
  (
    await execute(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024 })
  ).stdout.trim();
const docker = (...args) => command("docker", args);
const [destination, image, legacyExecutable] = process.argv.slice(2);
assert(
  destination && image && legacyExecutable,
  "Usage: node experiments/native-limits/run.js NEW_DISK_DIRECTORY IMAGE LEGACY_BINARY",
);
const output = path.resolve(destination);
mkdirSync(output);
const save = (file, value) =>
  writeFileSync(path.join(output, file), JSON.stringify(value, null, 2) + "\n");
const containers = new Set();
const timers = new Set();
const containerTimers = new Map();
const records = [];
const runs = [];
const network = `native-limits-${process.pid}`;
const manifest = {
  status: "running",
  startedAt: new Date().toISOString(),
  nodeExternal: process.version,
  host: { arch: os.arch(), platform: os.platform(), release: os.release() },
  limitsBytes: [75000000, 50000000],
  repeats: 3,
  users: 500,
  records,
  runs,
  boundary:
    "native service cgroup, one CPU, no swap; peer and coordinator excluded",
  cachePolicy:
    "disk-backed state and per-repeat private runtime inodes; byte-identical replay/curl/library/NSS/certificate files bind-mounted read-only from frozen image export; sync + POSIX_FADV_DONTNEED with zero-resident-page mincore verification before each cgroup; fresh native-generated state per repeat",
  sourceHashes: hashes("experiments/rust-replay"),
  harnessHashes: hashes("experiments/native-limits"),
  legacySha256: hash(legacyExecutable),
  cacheBoundaryCaveat:
    "Docker-generated /etc/hosts, /etc/hostname and /etc/resolv.conf may be daemon-charged; Docker/host infrastructure is outside the service budget. Runtime executables, native libraries, NSS/account/certificate files and all workload inputs/state use private evicted file inodes.",
};
const flush = () => save("manifest.json", manifest);

function regularRuntimeFile(root, absolute) {
  assert(
    absolute.startsWith("/") && path.posix.normalize(absolute) === absolute,
    `unsafe runtime path: ${absolute}`,
  );
  const parts = absolute.slice(1).split("/");
  let file = root;
  for (const [index, part] of parts.entries()) {
    file = path.join(file, part);
    const stat = lstatSync(file);
    assert(!stat.isSymbolicLink(), `runtime symlink: ${file}`);
    assert(
      index === parts.length - 1 ? stat.isFile() : stat.isDirectory(),
      `invalid runtime file: ${file}`,
    );
  }
  return file;
}
async function exportRuntime() {
  const name = `${network}-runtime-export`;
  await docker("create", "--name", name, manifest.image.Id);
  containers.add(name);
  const archive = path.join(output, "runtime-image.tar");
  const directory = path.join(output, "runtime-source");
  mkdirSync(directory);
  try {
    await docker("export", "-o", archive, name);
    manifest.runtimeExportSha256 = hash(archive);
    await command("tar", ["-xf", archive, "--no-same-owner", "-C", directory]);
  } finally {
    await docker("rm", "-f", name);
    containers.delete(name);
  }
  const metadata = "/usr/local/share/native-image/";
  const components = JSON.parse(
    readFileSync(regularRuntimeFile(directory, `${metadata}components.json`)),
  );
  const libraries = readFileSync(
    regularRuntimeFile(directory, `${metadata}libraries.txt`),
    "utf8",
  )
    .trim()
    .split("\n");
  assert(libraries.length > 0);
  const files = [
    ...new Set([
      "/usr/local/bin/replay",
      "/usr/local/bin/curl-impersonate",
      ...libraries,
      "/etc/nsswitch.conf",
      "/etc/passwd",
      "/etc/group",
      "/etc/ssl/certs/ca-certificates.crt",
      "/etc/os-release",
      "/etc/debian_version",
    ]),
  ];
  manifest.runtimeFiles = files.map((file) => {
    const source = regularRuntimeFile(directory, file);
    return { path: file, sha256: hash(source), bytes: statSync(source).size };
  });
  assert.equal(
    manifest.runtimeFiles.find((file) => file.path === "/usr/local/bin/replay")
      .sha256,
    components.replay.sha256,
  );
  assert.equal(
    manifest.runtimeFiles.find(
      (file) => file.path === "/usr/local/bin/curl-impersonate",
    ).sha256,
    components.curl.sha256,
  );
  manifest.runtimeSourceImageId = manifest.image.Id;
  manifest.runtimeCopiesDiskCategory =
    "otherBytes; each repeat includes independent byte-identical runtime files";
  unlinkSync(archive);
}
function copyRuntime(directory) {
  const root = path.join(directory, "runtime");
  mkdirSync(root);
  for (const file of manifest.runtimeFiles) {
    const source = regularRuntimeFile(
      path.join(output, "runtime-source"),
      file.path,
    );
    const destination = path.join(root, file.path.slice(1));
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    assert.equal(hash(destination), file.sha256);
    const from = statSync(source),
      to = statSync(destination);
    assert(
      from.dev !== to.dev || from.ino !== to.ino,
      "runtime copy must have a private inode",
    );
  }
}
function runtimeMounts(directory, legacy) {
  return manifest.runtimeFiles
    .filter((file) => !legacy || file.path !== "/usr/local/bin/replay")
    .flatMap((file) => {
      const source = regularRuntimeFile(
        path.join(directory, "runtime"),
        file.path,
      );
      assert.equal(
        hash(source),
        file.sha256,
        `runtime bytes changed: ${file.path}`,
      );
      return ["-v", `${source}:${file.path}:ro`];
    });
}

function disk(directory) {
  const seen = new Set();
  const result = {
    databaseBytes: 0,
    walBytes: 0,
    temporaryBytes: 0,
    otherBytes: 0,
  };
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(file);
        continue;
      }
      try {
        const st = statSync(file);
        const id = `${st.dev}:${st.ino}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const category = entry.name.endsWith("-wal")
          ? "walBytes"
          : entry.name.startsWith("incomplete") ||
              entry.name.endsWith("-journal") ||
              dir.endsWith("/tmp")
            ? "temporaryBytes"
            : entry.name.endsWith(".sqlite3")
              ? "databaseBytes"
              : "otherBytes";
        result[category] += st.size;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  visit(directory);
  return {
    ...result,
    totalBytes: Object.values(result).reduce((a, b) => a + b, 0),
  };
}
function cgPath(pid) {
  return path.join(
    "/sys/fs/cgroup",
    readFileSync(`/proc/${pid}/cgroup`, "utf8").trim().split("::")[1],
  );
}
function sample(cgroup) {
  const s = cgroupSample(cgroup);
  for (const file of [
    "memory.pressure",
    "cpu.pressure",
    "io.pressure",
    "io.stat",
  ])
    s[file] = readFileSync(path.join(cgroup, file), "utf8").trim();
  s.at = Date.now();
  s.processes = readFileSync(path.join(cgroup, "cgroup.procs"), "utf8")
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
  return s;
}
async function evict(directory) {
  return JSON.parse(
    await command("python3", ["experiments/native-limits/evict.py", directory]),
  );
}
async function launch(label, directory, limit, args, options = {}) {
  mkdirSync(path.join(directory, "tmp"), { recursive: true });
  const name = `${network}-${label}`;
  const mounts = runtimeMounts(directory, options.legacy);
  const record = {
    label,
    limitBytes: limit,
    measured: !options.preparation,
    runtimeIdentity: "private byte-identical files from frozen image",
    runtimeSourceImageId: manifest.runtimeSourceImageId,
    startedAt: Date.now(),
    samples: [],
    health: [],
    cacheEviction: await evict(directory),
  };
  records.push(record);
  const cpuBefore = process.cpuUsage();
  const start = Date.now();
  const argv = [
    "run",
    "-d",
    "--name",
    name,
    "--network",
    options.service ? network : "none",
    "--cpus",
    "1",
    "--memory",
    String(limit),
    "--memory-swap",
    String(limit),
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    `${process.getuid()}:${process.getgid()}`,
    "--env",
    "SQLITE_TMPDIR=/state/tmp",
    "-v",
    `${directory}:/state`,
    "-v",
    `${path.join(directory, "input-fixtures")}:/fixtures:ro`,
    ...mounts,
    ...(options.legacy
      ? ["-v", `${path.resolve(legacyExecutable)}:/usr/local/bin/replay:ro`]
      : []),
    manifest.image.Id,
    ...args,
  ];
  record.command = ["docker", ...argv];
  await docker(...argv);
  containers.add(name);
  let info = JSON.parse(await docker("inspect", name))[0];
  record.config = info.HostConfig;
  assert.equal(info.HostConfig.Memory, limit);
  assert.equal(info.HostConfig.MemorySwap, limit);
  let cgroup;
  if (info.State.Running) cgroup = cgPath(info.State.Pid);
  const take = () => {
    try {
      const s = sample(cgroup);
      assert(
        s.memoryLimit ===
          Math.floor(limit / manifest.pageBytes) * manifest.pageBytes,
        "kernel page-rounded hard limit",
      );
      assert.equal(s.swapLimit, 0);
      assert.equal(s.cpuLimit, "100000 100000");
      s.disk = disk(directory);
      record.samples.push(s);
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes(error.code))
        record.samplingError = String(error);
    }
  };
  if (cgroup) take();
  const timer = setInterval(take, 100);
  containerTimers.set(name, timer);
  timers.add(timer);
  async function finish(expected = 0) {
    try {
      record.exitCode = Number(await command("docker", ["wait", name], 240000));
    } catch (error) {
      record.waitError = String(error);
      await docker("kill", name).catch(() => {});
    }
    clearInterval(timer);
    timers.delete(timer);
    containerTimers.delete(name);
    info = JSON.parse(await docker("inspect", name))[0];
    record.finalState = info.State;
    record.logs = await docker("logs", name);
    record.wallMs = Date.now() - start;
    record.coordinatorCpuMicros = process.cpuUsage(cpuBefore);
    record.coordinatorPeakRssBytes = process.resourceUsage().maxRSS * 1024;
    record.finalDisk = disk(directory);
    record.passed =
      record.exitCode === expected &&
      !info.State.OOMKilled &&
      record.samples.every(
        (s) => !/^oom(?:_kill|_group_kill)? [1-9]/m.test(s.memoryEvents),
      ) &&
      !record.samplingError &&
      record.samples.length > 0;
    await docker("rm", name);
    containers.delete(name);
    flush();
    return record;
  }
  return {
    name,
    record,
    finish,
    async running() {
      return JSON.parse(await docker("inspect", name))[0].State.Running;
    },
  };
}
async function cleanupLive() {
  for (const name of [...containers]) {
    if (name.endsWith("-peer")) continue;
    const timer = containerTimers.get(name);
    clearInterval(timer);
    timers.delete(timer);
    containerTimers.delete(name);
    await docker("kill", name).catch(() => {});
    const record = records.find((r) => r.command?.includes(name));
    if (record) {
      record.finalState = JSON.parse(await docker("inspect", name))[0].State;
      record.logs = await docker("logs", name).catch(() => "");
      record.passed = false;
      record.cleanupAfterError = true;
    }
    await docker("rm", "-f", name);
    containers.delete(name);
  }
}
async function readiness(service, target) {
  const begin = Date.now();
  while (Date.now() - begin < 180000) {
    let text = "";
    try {
      text = await docker(
        "exec",
        service.name,
        "/usr/local/bin/replay",
        "health",
        "--socket",
        `/state/${service.record.label.endsWith("-exercise") ? "exercise" : "resume"}.sock`,
      );
    } catch {
      /* Startup and failed processes are unready. */
    }
    service.record.health.push({ at: Date.now(), text });
    if (text === `ok ${target}`) return true;
    if (!(await service.running())) return false;
    await delay(300);
  }
  service.record.timeout = target;
  await docker("kill", service.name);
  return false;
}
const replayArgs = (database, stage) => [
  "--fixtures",
  "/fixtures",
  "--database",
  database,
  "--users",
  "500",
  "--mode",
  "virtual",
  "--stage",
  stage,
];
const serviceArgs = (stage) => [
  "serve",
  "--socket",
  `/state/${stage}.sock`,
  "--directory",
  "/state/work",
  "--url",
  "http://fixture:8080",
  "--stage",
  stage,
  "--mode",
  "wall",
  "--users",
  "500",
];
function oracle(first, second, file) {
  const result = { ...second, phases: [...first.phases, ...second.phases] };
  verifyReplayResult(result);
  const wrong = structuredClone(result);
  wrong.phases.find((p) => p.name === "fresh").deliveriesByProfile[0].reverse();
  assert.throws(() => verifyReplayResult(wrong));
  save(file, result);
  return result;
}
async function operation(label, directory, limit, args, options, expected = 0) {
  const worker = await launch(label, directory, limit, args, options);
  const record = await worker.finish(expected);
  let result;
  try {
    result = JSON.parse(record.logs);
  } catch {
    /* OOM may leave no report. */
  }
  if (result) save(`${label}.json`, result);
  return { record, result };
}
try {
  manifest.pageBytes = Number(await command("getconf", ["PAGESIZE"]));
  manifest.filesystem = await command("findmnt", [
    "-T",
    output,
    "-n",
    "-o",
    "FSTYPE,SOURCE,TARGET",
  ]);
  assert(
    !/^(tmpfs|ramfs)\s/.test(manifest.filesystem),
    "Measured state must be disk-backed",
  );
  manifest.image = JSON.parse(await docker("image", "inspect", image))[0];
  await exportRuntime();
  manifest.gitHead = await command("git", ["rev-parse", "HEAD"]);
  manifest.gitDiff = await command("git", ["diff", "--stat"]);
  await command(process.execPath, [
    "experiments/node-replay/export.js",
    path.join(output, "fixtures"),
  ]);
  manifest.fixtureHashes = hashes(path.join(output, "fixtures"));
  writeFileSync(path.join(output, "behavior.txt"), "normal");
  writeFileSync(path.join(output, "requests.jsonl"), "");
  await docker("network", "create", "--internal", network);
  const peer = `${network}-peer`;
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
  const peerInfo = JSON.parse(await docker("inspect", peer))[0];
  manifest.peer = { image: peerInfo.Image, samples: [] };
  const peerCg = cgPath(peerInfo.State.Pid);
  const peerTimer = setInterval(() => {
    try {
      manifest.peer.samples.push(sample(peerCg));
    } catch {
      /* Preserve candidate measurements if peer exits. */
    }
  }, 1000);
  timers.add(peerTimer);
  await delay(500);
  for (const limit of manifest.limitsBytes) {
    for (let repeat = 1; repeat <= 3; repeat++) {
      const label = `mb${limit / 1000000}-r${repeat}`;
      const directory = path.join(output, label);
      mkdirSync(directory);
      copyRuntime(directory);
      cpSync(
        path.join(output, "fixtures"),
        path.join(directory, "input-fixtures"),
        { recursive: true },
      );
      assert.deepEqual(
        hashes(path.join(directory, "input-fixtures")),
        manifest.fixtureHashes,
      );
      const run = {
        label,
        limitBytes: limit,
        repeat,
        startedAt: Date.now(),
        servicePassed: false,
        maintenancePassed: false,
        migrationPassed: false,
      };
      runs.push(run);
      flush();
      console.log(`Starting ${label}`);
      try {
        const exercise = await launch(
          `${label}-exercise`,
          directory,
          limit,
          serviceArgs("exercise"),
          { service: true },
        );
        const pending = await readiness(exercise, "pending-restart");
        if (pending) {
          await delay(1000);
          exercise.record.forcedStop = {
            signal: "SIGKILL",
            boundary: "durable pending-restart",
            at: Date.now(),
          };
          await docker("kill", "--signal", "SIGKILL", exercise.name);
        }
        const exerciseRecord = await exercise.finish(pending ? 137 : 0);
        const firstFile = path.join(directory, "work/exercise.json");
        let first;
        if (existsSync(firstFile)) first = JSON.parse(readFileSync(firstFile));
        if (pending && exerciseRecord.passed && first) {
          assert.equal(first.resources.pendingRows, 3000);
          const resume = await launch(
            `${label}-resume`,
            directory,
            limit,
            serviceArgs("resume"),
            { service: true },
          );
          const drained = await readiness(resume, "drained");
          if (drained) {
            await delay(1000);
            await docker(
              "exec",
              resume.name,
              "/usr/local/bin/replay",
              "shutdown",
              "--socket",
              "/state/resume.sock",
            );
          }
          const resumeRecord = await resume.finish();
          if (drained && resumeRecord.passed) {
            const second = JSON.parse(
              readFileSync(path.join(directory, "work/resume.json")),
            );
            const combined = oracle(
              first,
              second,
              `${label}-service-result.json`,
            );
            run.capacity = evaluateCapacity({
              users: 500,
              mode: "wall",
              phases: combined.phases,
              primaryRamBytes: Math.max(
                ...exerciseRecord.samples.map((s) => s.peakBytes),
                ...resumeRecord.samples.map((s) => s.peakBytes),
              ),
            });
            run.capacity.withinRequestedMemoryLimit = [
              ...exerciseRecord.samples,
              ...resumeRecord.samples,
            ].every((s) => s.memoryLimit <= limit);
            assert(
              Object.values(run.capacity).every(
                (v) => typeof v !== "boolean" || v,
              ),
              "capacity gate failed",
            );
            run.servicePassed =
              exerciseRecord.samples.some((s) =>
                s.processes.some((p) => p.command.includes("curl-impersonate")),
              ) && exerciseRecord.health.some((h) => h.text === "ok active");
          }
        }
      } catch (error) {
        run.serviceError = error.stack;
      } finally {
        await cleanupLive();
      }
      // Independent native fixture preparation lets maintenance still run after service OOM.
      try {
        const prep = await operation(
          `${label}-maintenance-seed`,
          directory,
          536870912,
          replayArgs("/state/maintenance.sqlite3", "exercise"),
          { preparation: true },
          23,
        );
        assert(prep.record.passed && prep.result, "maintenance seed failed");
        const backup = await operation(`${label}-backup`, directory, limit, [
          "backup",
          "--database",
          "/state/maintenance.sqlite3",
          "--output",
          "/state/backup",
        ]);
        if (backup.record.passed) {
          const restore = await operation(
            `${label}-restore`,
            directory,
            limit,
            [
              "restore",
              "--database",
              "/state/backup/state.sqlite3",
              "--output",
              "/state/restored",
            ],
          );
          if (restore.record.passed) {
            const resumed = await operation(
              `${label}-restored-resume`,
              directory,
              limit,
              replayArgs("/state/restored/state.sqlite3", "resume"),
            );
            if (resumed.record.passed) {
              oracle(
                prep.result,
                resumed.result,
                `${label}-maintenance-result.json`,
              );
              run.maintenancePassed = true;
            }
          }
        }
      } catch (error) {
        run.maintenanceError = error.stack;
      } finally {
        await cleanupLive();
      }
      try {
        const prep = await operation(
          `${label}-legacy-seed`,
          directory,
          536870912,
          replayArgs("/state/legacy.sqlite3", "exercise"),
          { preparation: true, legacy: true },
          23,
        );
        assert(prep.record.passed && prep.result, "legacy seed failed");
        const db = path.join(directory, "legacy.sqlite3");
        const before = [hash(db), hash(`${db}-wal`)];
        const migration = await operation(
          `${label}-migration`,
          directory,
          limit,
          [
            "migrate",
            "--database",
            "/state/legacy.sqlite3",
            "--output",
            "/state/migrated",
          ],
        );
        assert.deepEqual([hash(db), hash(`${db}-wal`)], before);
        run.legacySourceHashes = before;
        if (migration.record.passed) {
          assert.equal(migration.result.state.pendingRows, 3000);
          const resumed = await operation(
            `${label}-migrated-resume`,
            directory,
            limit,
            replayArgs("/state/migrated/state.sqlite3", "resume"),
          );
          if (resumed.record.passed) {
            oracle(
              prep.result,
              resumed.result,
              `${label}-migration-result.json`,
            );
            run.migrationPassed = true;
          }
        }
      } catch (error) {
        run.migrationError = error.stack;
      } finally {
        await cleanupLive();
      }
      run.passed =
        run.servicePassed && run.maintenancePassed && run.migrationPassed;
      run.finishedAt = Date.now();
      {
        const state = [];
        function collectState(dir) {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const file = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              collectState(file);
              continue;
            }
            if (entry.name.includes(".sqlite3")) {
              state.push({
                file: path.relative(output, file),
                bytes: statSync(file).size,
                sha256: hash(file),
              });
            }
          }
        }
        collectState(directory);
        if (!run.passed && state.length) {
          // Preserve failed state compactly so six failed runs cannot fill the host disk.
          const archive = `${label}-failed-state.tar.gz`;
          await command("tar", [
            "-czf",
            path.join(output, archive),
            "-C",
            output,
            ...state.map((entry) => entry.file),
          ]);
          await command("gzip", ["-t", path.join(output, archive)]);
          const members = (
            await command("tar", ["-tzf", path.join(output, archive)])
          ).split("\n");
          assert.deepEqual(
            members.sort(),
            state.map((entry) => entry.file).sort(),
          );
          run.retainedFailureState = {
            archive,
            sha256: hash(path.join(output, archive)),
            files: state,
          };
        } else {
          run.removedSuccessfulState = state;
        }
        for (const entry of state) unlinkSync(path.join(output, entry.file));
      }
      flush();
      console.log(JSON.stringify(run));
    }
  }
  manifest.status =
    runs.length === 6 && runs.every((r) => r.passed) ? "passed" : "failed";
} catch (error) {
  manifest.status = "failed";
  manifest.error = error.stack;
} finally {
  for (const timer of timers) clearInterval(timer);
  for (const name of containers) {
    const record = records.find((r) => r.command.includes(name));
    if (record) {
      record.finalState = JSON.parse(
        await docker("inspect", name).catch(() => "[{}]"),
      )[0].State;
      record.logs = await docker("logs", name).catch(() => "");
    }
    await docker("rm", "-f", name).catch(() => {});
  }
  await docker("network", "rm", network).catch(() => {});
  manifest.finishedAt = new Date().toISOString();
  manifest.coordinatorResourceUsage = process.resourceUsage();
  flush();
}
console.log(JSON.stringify({ status: manifest.status, output }));
process.exitCode = manifest.status === "passed" ? 0 : 1;

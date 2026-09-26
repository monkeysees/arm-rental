import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boundary } from "./common.js";
import { verifyReplayResult } from "../node-replay/verify.js";
import { evaluateCapacity } from "../node-replay/capacity.js";

export function verifyServiceReplay(result) {
  verifyReplayResult(result);
  const { accounting, resources, provenance, workers } = result;
  assert.equal(accounting.boundary, boundary, "wrong accounting boundary");
  assert(["go", "rust"].includes(accounting.runtime));
  assert.equal(result.scope, `${accounting.runtime}-full-contract`);
  assert(
    Number.isSafeInteger(accounting.memoryBytes) && accounting.memoryBytes > 0,
  );
  const { service, harness } = accounting;
  for (const [parent, child] of [
    [service.cgroupPath, harness.cgroupPath],
    [harness.cgroupPath, service.cgroupPath],
  ]) {
    assert(
      path.posix.relative(parent, child).startsWith("../"),
      "service and harness cgroups overlap",
    );
  }
  assert.notEqual(
    service.cgroupPath,
    harness.cgroupPath,
    "harness shares service cgroup",
  );
  assert.notEqual(
    service.container.slice(0, 12),
    harness.container.slice(0, 12),
  );
  assert.equal(service.inspect.Id, service.container);
  assert.equal(service.inspect.Image, provenance.imageId);
  assert.equal(service.inspect.HostConfig.NetworkMode, "none");
  assert.equal(service.inspect.HostConfig.Memory, accounting.memoryBytes);
  assert.equal(service.inspect.HostConfig.MemorySwap, accounting.memoryBytes);
  assert.equal(service.inspect.HostConfig.NanoCpus, 1e9);
  assert.equal(service.inspect.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(service.inspect.Config.Entrypoint, ["/holder"]);
  const mounts = service.inspect.Mounts;
  for (const destination of ["/holder", "/input"])
    assert.equal(
      mounts.find((mount) => mount.Destination === destination)?.RW,
      false,
    );
  assert.equal(mounts.find((mount) => mount.Destination === "/data")?.RW, true);
  assert(
    service.inspect.HostConfig.Tmpfs["/fixtures"],
    "fixtures must be charged to service tmpfs",
  );
  assert(service.samples.length >= 3);
  let peak = 0;
  for (const sample of service.samples) {
    assert.equal(
      sample.memoryLimit,
      accounting.memoryBytes,
      "observed memory limit differs",
    );
    assert.equal(sample.swapLimit, 0, "swap must be disabled");
    assert.equal(sample.cpuLimit, "100000 100000");
    assert(sample.currentBytes > 0 && sample.peakBytes >= sample.currentBytes);
    assert(sample.peakBytes >= peak, "lifetime peak reset across recovery");
    peak = sample.peakBytes;
    for (const field of ["anon", "file", "kernel"])
      assert(new RegExp(`^${field} \\d+$`, "m").test(sample.memoryStat));
    assert(/^usage_usec \d+$/m.test(sample.cpuStat));
    assert(/^oom_kill 0$/m.test(sample.memoryEvents), "service OOM");
    for (const process of sample.processes)
      assert(
        ["/holder", "/usr/local/bin/replay"].includes(process.command[0]) ||
          (process.command[0] === "runc" && process.command[1] === "init"),
        `unexpected process inside service: ${JSON.stringify(process.command)}`,
      );
  }
  for (const stage of ["exercise", "resume"])
    assert(
      service.samples.some(
        (sample) =>
          sample.stage === stage &&
          sample.processes.some(
            (process) =>
              process.command[0] === "/usr/local/bin/replay" &&
              process.command.at(-1) === stage,
          ),
      ),
      `no native ${stage} worker observed`,
    );
  assert.deepEqual(service.final, service.samples.at(-1));
  assert.equal(resources.primaryRamBytes, service.final.peakBytes);
  assert(resources.primaryRamBytes <= accounting.memoryBytes);
  assert.equal(workers.length, 2);
  assert(["wall", "virtual"].includes(result.mode), "invalid replay mode");
  assert.deepEqual(
    result.phases,
    workers.flatMap((worker) => worker.phases),
  );
  for (const worker of workers) {
    assert.equal(worker.mode, result.mode, "worker mode differs from report");
    assert.equal(worker.workload.users, result.workload.users);
    assert.equal(worker.resources.memoryLimit, accounting.memoryBytes);
    assert.equal(worker.resources.swapLimit, 0);
    assert.equal(worker.resources.cpuLimit, "100000 100000");
    assert(worker.resources.primaryRamBytes <= resources.primaryRamBytes);
  }
  const unchanged = resources.memorySnapshots.filter(
    (sample) => sample.phase === "unchanged",
  );
  assert.equal(unchanged.length, 4);
  assert.deepEqual(service.idle, unchanged[0]);
  assert.deepEqual(service.steady, unchanged.slice(1));
  for (const snapshot of resources.memorySnapshots) {
    assert(snapshot.processRssBytes > 0 && snapshot.cgroupCurrentBytes > 0);
    assert(snapshot.cgroupStat.includes("anon "));
  }
  assert(harness.final.peakBytes > 0 && harness.process.maxRSS > 0);
  assert(
    /^usage_usec \d+$/m.test(harness.final.cpuStat),
    "missing harness CPU accounting",
  );
  assert(
    /^anon \d+$/m.test(harness.final.memoryStat),
    "missing harness memory attribution",
  );
  assert.equal(harness.final.memoryLimit, 536870912);
  assert.equal(harness.final.swapLimit, 0);
  assert.equal(harness.final.cpuLimit, "100000 100000");
  for (const digest of [
    provenance.binarySha256,
    provenance.holderSha256,
    ...Object.values(provenance.fixtureHashes),
    ...Object.values(provenance.sourceHashes),
  ])
    assert.match(digest, /^[0-9a-f]{64}$/);
  assert(Object.keys(provenance.fixtureHashes).length > 1);
  assert(Object.keys(provenance.sourceHashes).length > 1);
  assert.equal(
    provenance.binarySha256,
    provenance.nativeBaseline.binarySha256,
    "binary differs from native baseline",
  );
  assert(Object.keys(provenance.nativeBaseline.sourceHashes).length > 0);
  for (const [file, digest] of Object.entries(
    provenance.nativeBaseline.sourceHashes,
  ))
    assert.equal(
      provenance.sourceHashes[file],
      digest,
      "native source differs from binary baseline",
    );
  return evaluateCapacity({
    users: result.workload.users,
    mode: result.mode,
    primaryRamBytes: resources.primaryRamBytes,
    phases: result.phases.map((phase) => ({
      ...phase,
      recipientsWithProgress: phase.sent > 0 ? phase.recipientsAsserted : 0,
      firstRecipientProgressMs: {
        max: phase.classificationWallMs + phase.firstProgressMaxMs,
      },
    })),
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  assert(
    process.argv.length > 2,
    "Usage: report.js RESULT.json [RESULT.json ...]",
  );
  const reports = process.argv.slice(2).map((file) => {
    const result = JSON.parse(readFileSync(file, "utf8"));
    const capacity = verifyServiceReplay(result);
    return {
      file,
      runtime: result.accounting.runtime,
      users: result.workload.users,
      mode: result.mode,
      boundary,
      capacity,
      servicePeakBytes: result.resources.primaryRamBytes,
      idleBytes: result.accounting.service.idle.cgroupCurrentBytes,
      steadyBytes: result.accounting.service.steady.map(
        (sample) => sample.cgroupCurrentBytes,
      ),
      processPeakRssBytes: result.resources.processPeakRssBytes,
      serviceCpuStat: result.accounting.service.final.cpuStat,
      harnessPeakBytes: result.accounting.harness.final.peakBytes,
      harnessCpuStat: result.accounting.harness.final.cpuStat,
      phases: result.phases
        .filter((phase) => ["fresh", "catchup", "resumed"].includes(phase.name))
        .map((phase) => ({
          name: phase.name,
          wallMs: phase.wallMs,
          drainMs: phase.drainMs,
          queueAgeP95Ms: phase.queueAgeP95Ms,
          queueAgeMaxMs: phase.queueAgeMaxMs,
          firstProgressMaxMs: phase.firstProgressMaxMs,
        })),
    };
  });
  console.log(JSON.stringify(reports, null, 2));
}

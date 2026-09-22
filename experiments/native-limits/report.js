import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return {
    min: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    max: sorted.at(-1),
  };
}

function counters(text = "") {
  return Object.fromEntries(
    text
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [key, value] = line.split(/\s+/);
        return [key, Number(value)];
      }),
  );
}

function peakFields(samples) {
  const result = {};
  for (const sample of samples)
    for (const [key, value] of Object.entries(sample ?? {}))
      result[key] = Math.max(result[key] ?? 0, value);
  return result;
}

export function summarize(manifest) {
  assert.equal(manifest.users, 500);
  assert.deepEqual(manifest.limitsBytes, [75000000, 50000000]);
  const operations = manifest.records.map((record) => {
    const samples = record.samples;
    const last = samples.at(-1);
    const active = record.health.find(
      (health) => health.text === "ok active",
    )?.at;
    const idle = record.health.find((health) =>
      ["ok pending-restart", "ok drained"].includes(health.text),
    )?.at;
    return {
      label: record.label,
      measured: record.measured,
      requestedBytes: record.limitBytes,
      effectiveBytes: last?.memoryLimit ?? null,
      passed: record.passed,
      exitCode: record.exitCode,
      oomKilled: record.finalState?.OOMKilled ?? null,
      wallMs: record.wallMs,
      sampledKernelPeakBytes: Math.max(0, ...samples.map((s) => s.peakBytes)),
      startupCurrentBytes: distribution(
        samples
          .filter((s) => active && s.at < active)
          .map((s) => s.currentBytes),
      ),
      activeCurrentBytes: distribution(
        samples
          .filter((s) => active && s.at >= active && (!idle || s.at < idle))
          .map((s) => s.currentBytes),
      ),
      postWorkIdleCurrentBytes: distribution(
        samples.filter((s) => idle && s.at >= idle).map((s) => s.currentBytes),
      ),
      observedMemoryEvents: peakFields(
        samples.map((s) => counters(s.memoryEvents)),
      ),
      lastObservedMemoryStat: counters(last?.memoryStat),
      lastObservedCpuStat: counters(last?.cpuStat),
      lastObservedPressure: Object.fromEntries(
        ["memory", "cpu", "io"].map((kind) => [
          kind,
          last?.[`${kind}.pressure`] ?? null,
        ]),
      ),
      lastObservedIoStat: last?.["io.stat"] ?? null,
      diskCategoryPeaks: peakFields([
        ...samples.map((s) => s.disk),
        record.finalDisk,
      ]),
      samples: samples.length,
    };
  });
  const limits = manifest.limitsBytes.map((bytes) => {
    const repeats = manifest.runs.filter((run) => run.limitBytes === bytes);
    const selected = operations.filter(
      (record) => record.measured && record.requestedBytes === bytes,
    );
    const labels = [
      ...new Set(
        selected.map((record) => record.label.replace(/^mb\d+-r\d+-/, "")),
      ),
    ];
    return {
      requestedBytes: bytes,
      MB: bytes / 1e6,
      MiB: bytes / 2 ** 20,
      decision:
        repeats.length === 3 && repeats.every((run) => run.passed)
          ? "pass"
          : "fail",
      repeats: repeats.map((run) => ({
        label: run.label,
        servicePassed: run.servicePassed,
        maintenancePassed: run.maintenancePassed,
        migrationPassed: run.migrationPassed,
        capacity: run.capacity,
        passed: run.passed,
        serviceError: run.serviceError,
        maintenanceError: run.maintenanceError,
        migrationError: run.migrationError,
      })),
      variation: Object.fromEntries(
        labels.map((label) => {
          const records = selected.filter((r) => r.label.endsWith(`-${label}`));
          return [
            label,
            {
              kernelPeakBytes: distribution(
                records.map((r) => r.sampledKernelPeakBytes),
              ),
              wallMs: distribution(records.map((r) => r.wallMs)),
              oomCount: records.filter((r) => r.oomKilled).length,
            },
          ];
        }),
      ),
    };
  });
  return {
    status: manifest.status,
    imageId: manifest.image.Id,
    sourceHashes: manifest.sourceHashes,
    host: manifest.host,
    boundary: manifest.boundary,
    cachePolicy: manifest.cachePolicy,
    limits,
    operations,
    external: {
      coordinatorResourceUsage: manifest.coordinatorResourceUsage,
      peerSampledKernelPeakBytes: Math.max(
        0,
        ...manifest.peer.samples.map((s) => s.peakBytes),
      ),
      peerLastCpuStat: counters(manifest.peer.samples.at(-1)?.cpuStat),
    },
    caveats: [
      "MB is decimal; MiB is binary. The requested Docker limit is exact; the kernel rounds down to whole pages.",
      "Kernel peaks/events/I/O/pressure are last observed before cgroup teardown; short terminal activity may escape the 100 ms sampler. Docker OOMKilled is also retained.",
      "Active memory includes seeded history and delivery; post-work idle is the live service after pending-restart/drained readiness, not an empty process.",
      "Disk category maxima need not occur together and must not be added; totalBytes is the largest observed total. Unlinked files and sub-sample peaks may escape logical file sampling.",
      "Separate maintenance operations are mutually exclusive; never sum their memory peaks. External fixture, coordinator, Docker and host costs are excluded from service limits.",
    ],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assert(process.argv[2], "Usage: report.js ACCEPTANCE_DIRECTORY");
  const directory = path.resolve(process.argv[2]);
  const summary = summarize(
    JSON.parse(readFileSync(path.join(directory, "manifest.json"))),
  );
  summary.delivery = {};
  for (const limit of summary.limits)
    for (const repeat of limit.repeats) {
      const file = path.join(directory, `${repeat.label}-service-result.json`);
      if (!existsSync(file)) continue;
      const result = JSON.parse(readFileSync(file));
      summary.delivery[repeat.label] = result.phases.map((phase) => ({
        phase: phase.name,
        sent: phase.sent,
        wallMs: phase.wallMs,
        classificationWallMs: phase.classificationWallMs,
        drainMs: phase.drainMs,
        queueAgeMs: phase.queueAgeMs,
        throughputPerSecond: phase.throughputPerSecond,
        firstRecipientProgressMs: phase.firstRecipientProgressMs,
      }));
    }
  writeFileSync(
    path.join(directory, "summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
  );
  console.log(JSON.stringify(summary.limits));
}

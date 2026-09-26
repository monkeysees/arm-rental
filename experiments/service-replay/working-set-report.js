import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { hash } from "./common.js";
import { verifyServiceReplay } from "./report.js";

const [before, after] = process.argv.slice(2);
assert(
  before && after,
  "Usage: working-set-report.js BEFORE_DIRECTORY AFTER_DIRECTORY",
);
const mib = (bytes) => bytes / 1024 ** 2;
const counter = (text, key) => {
  const match = text.match(new RegExp(`^${key} (\\d+)$`, "m"));
  assert(match, `missing counter ${key}`);
  return Number(match[1]);
};
const io = (text, key) =>
  [...text.matchAll(new RegExp(`\\b${key}=(\\d+)`, "g"))].reduce(
    (sum, match) => sum + Number(match[1]),
    0,
  );
const summary = {};
for (const [variant, directory] of [
  ["before", before],
  ["after", after],
]) {
  const runs = [];
  for (const name of [
    "500-virtual-1",
    "500-wall-1",
    "500-wall-2",
    "500-wall-3",
  ]) {
    const file = path.join(directory, name, "result.json");
    const result = JSON.parse(readFileSync(file, "utf8"));
    const capacity = verifyServiceReplay(result);
    assert.equal(result.workload.users, 500);
    assert.equal(result.mode, name.includes("virtual") ? "virtual" : "wall");
    const service = result.accounting.service;
    const catchup = result.phases.find((p) => p.name === "catchup");
    const resumed = result.phases.find((p) => p.name === "resumed");
    const metrics = {
      servicePeakMiB: mib(result.resources.primaryRamBytes),
      processPeakMiB: mib(result.resources.processPeakRssBytes),
      idleMiB: mib(service.idle.cgroupCurrentBytes),
      idleAnonymousMiB: mib(counter(service.idle.cgroupStat, "anon")),
      idleFileMiB: mib(counter(service.idle.cgroupStat, "file")),
      idleKernelMiB: mib(counter(service.idle.cgroupStat, "kernel")),
      serviceCpuMs: counter(service.final.cpuStat, "usage_usec") / 1000,
      ioReadMiB: mib(io(service.final.ioStat, "rbytes")),
      ioWriteMiB: mib(io(service.final.ioStat, "wbytes")),
      databaseMiB: mib(result.workers.at(-1).resources.databaseBytes),
      sampledWalPeakMiB: mib(
        Math.max(...service.samples.map((s) => s.walBytes)),
      ),
      sampledDatabaseWalPeakMiB: mib(
        Math.max(...service.samples.map((s) => s.databaseBytes + s.walBytes)),
      ),
      catchupClassificationMs: catchup.classificationWallMs,
      catchupWallMs: catchup.wallMs,
      catchupDrainMs: catchup.drainMs,
      catchupQueueP95Ms: catchup.queueAgeP95Ms,
      resumedDrainMs: resumed.drainMs,
      seedMs: result.phases.find((p) => p.name === "seed-decisions").wallMs,
    };
    runs.push({
      name,
      sha256: hash(file),
      capacity,
      decisionRows: result.workers.at(-1).resources.decisionRows,
      pendingRows: result.workers.at(-1).resources.pendingRows,
      metrics,
    });
  }
  const wall = runs.filter((r) => r.name.includes("wall"));
  summary[variant] = {
    runs,
    median: Object.fromEntries(
      Object.keys(wall[0].metrics).map((key) => [
        key,
        wall.map((r) => r.metrics[key]).sort((a, b) => a - b)[1],
      ]),
    ),
    peakRangeMiB: [
      Math.min(...wall.map((r) => r.metrics.servicePeakMiB)),
      Math.max(...wall.map((r) => r.metrics.servicePeakMiB)),
    ],
  };
}
console.log(JSON.stringify(summary, null, 2));

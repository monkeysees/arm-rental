import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { contract } from "../node-replay/fixture.js";
import { verifyReplayResult } from "../node-replay/verify.js";
import { evaluateCapacity } from "../node-replay/capacity.js";

const { values } = parseArgs({
  options: Object.fromEntries(
    ["node", "go", "rust"].map((name) => [name, { type: "string" }]),
  ),
});
const json = (filename) => JSON.parse(readFileSync(filename, "utf8"));
const stats = (values) => {
  assert(values.every(Number.isFinite), "Missing or invalid measurement");
  const sorted = values.toSorted((a, b) => a - b);
  return {
    min: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    max: sorted.at(-1),
  };
};
const median = (values) => stats(values).median;
function observations(result) {
  const native = Boolean(result.resources);
  const phases = result.phases;
  const steady = phases
    .filter((p) => p.name === "unchanged" && !p.bootstrap)
    .slice(-3);
  const catchup = phases.find((p) => p.name === "catchup");
  const resumed = phases.find((p) => p.name === "resumed");
  const routine = phases.filter((p) => ["updated", "fresh"].includes(p.name));
  const snapshots = result.resources?.memorySnapshots;
  // All runtimes have seeded and reconciled history at this common idle point.
  const idle = native
    ? snapshots.find((s) => s.phase === "unchanged")
    : phases.find((p) => p.name === "unchanged").memoryAfter;
  const steadyMemory = native
    ? snapshots.filter((s) => s.phase === "unchanged").slice(-3)
    : steady.map((p) => p.memoryAfter);
  const last = phases.at(-1);
  return {
    servicePeakBytes: native
      ? result.resources.primaryRamBytes
      : result.primaryRamBytes,
    processPeakBytes: native
      ? result.resources.processPeakRssBytes
      : Math.max(
          ...result.workers.flatMap((w) => [
            w.idleMemory.peakRssBytes,
            ...w.results.map((p) => p.memoryAfter.peakRssBytes),
          ]),
        ),
    idleProcessBytes: idle.processRssBytes ?? idle.rss,
    idleServiceBytes: idle.cgroupCurrentBytes ?? idle.serviceCurrentBytes,
    steadyProcessBytes: median(
      steadyMemory.map((m) => m.processRssBytes ?? m.rss),
    ),
    steadyServiceBytes: median(
      steadyMemory.map((m) => m.cgroupCurrentBytes ?? m.serviceCurrentBytes),
    ),
    unchangedCpuMs: median(steady.map((p) => p.cpuMs)),
    routineCpuMs: routine.reduce((n, p) => n + p.cpuMs, 0),
    routineWallMs: routine.reduce((n, p) => n + p.wallMs, 0),
    routineClassificationMs: routine.reduce(
      (n, p) => n + p.classificationWallMs,
      0,
    ),
    catchupClassificationMs: catchup.classificationWallMs,
    catchupCpuMs: catchup.cpuMs,
    catchupWallMs: catchup.wallMs,
    catchupMessagesPerSecond: catchup.sent / (catchup.wallMs / 1000),
    catchupQueueP95Ms: catchup.queueAgeMs?.p95 ?? catchup.queueAgeP95Ms,
    firstProgressMaxMs: catchup.firstRecipientProgressMs.max,
    resumedWallMs: resumed.wallMs,
    resumedQueueP95Ms: resumed.queueAgeMs?.p95 ?? resumed.queueAgeP95Ms,
    databaseBytes: native ? result.resources.databaseBytes : last.databaseBytes,
    walBytes: native ? result.resources["database-walBytes"] : last.walBytes,
  };
}
const inputs = {};
for (const runtime of ["node", "go", "rust"]) {
  assert(values[runtime], `--${runtime} RESULTS_DIRECTORY is required`);
  const manifest = json(path.join(values[runtime], "manifest.json"));
  assert(manifest.finishedAt, "Incomplete measurement manifest");
  assert.match(manifest.imageId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(manifest.runs.length, contract.populations.length * 4);
  const results = {};
  let sourceHashes, binary;
  for (const users of contract.populations) {
    results[users] = [];
    for (const mode of ["virtual", "wall"]) {
      for (let repeat = 1; repeat <= (mode === "virtual" ? 1 : 3); repeat++) {
        const name = `${users}-${mode}-${repeat}`;
        const run = manifest.runs.find((run) => run.name === name);
        assert(
          run && run.exitCode === 0 && run.behavior === "passed",
          `Failed gate: ${runtime}/${name}`,
        );
        for (const [flag, value] of [
          ["--cpus", "1"],
          ["--memory", "512m"],
          ["--memory-swap", "512m"],
          ["--network", "none"],
        ]) {
          assert.equal(run.args[run.args.indexOf(flag) + 1], value);
        }
        const result = json(path.join(values[runtime], `${name}.json`));
        if (runtime === "node") assert.equal(result.node, "v24.18.0");
        else assert.equal(result.scope, `${runtime}-full-contract`);
        assert.equal(result.status, "passed");
        assert.equal(result.workload.users, users);
        assert.equal(result.mode, mode);
        assert.equal(
          Number(result.resources?.memoryLimit ?? result.limits?.memory),
          contract.measurement.memoryBytes,
          "Observed memory limit differs",
        );
        assert.equal(
          Number(result.resources?.swapLimit ?? result.limits?.swap),
          0,
          "Observed swap limit differs",
        );
        assert.equal(
          result.resources?.cpuLimit ?? result.limits?.cpu,
          "100000 100000",
          "Observed CPU quota differs",
        );
        verifyReplayResult(result);
        sourceHashes ??= result.sourceHashes;
        assert.deepEqual(
          result.sourceHashes,
          sourceHashes,
          "Sources changed during measurement",
        );
        if (runtime !== "node") {
          binary ??= result.binarySha256;
          assert.equal(result.binarySha256, binary);
          assert.match(binary, /^[a-f0-9]{64}$/);
        }
        if (mode === "wall") {
          const observed = observations(result);
          assert(observed.servicePeakBytes > 0, "Missing cgroup peak");
          const phases =
            runtime === "node"
              ? result.phases
              : result.phases.map((phase) => ({
                  ...phase,
                  recipientsWithProgress:
                    phase.sent > 0 ? phase.recipientsAsserted : 0,
                  firstRecipientProgressMs: {
                    max: phase.classificationWallMs + phase.firstProgressMaxMs,
                  },
                }));
          const capacity = evaluateCapacity({
            users,
            mode,
            phases,
            primaryRamBytes: observed.servicePeakBytes,
          });
          results[users].push({ observed, capacity });
        }
      }
    }
  }
  inputs[runtime] = { manifest, results, sourceHashes, binary };
}
for (const runtime of ["go", "rust"]) {
  assert.equal(
    inputs[runtime].manifest.imageId,
    inputs.node.manifest.imageId,
    "Different coordinator images",
  );
  for (const name of ["contract.json", "fixture.js", "export.js"]) {
    const key = `experiments/node-replay/${name}`;
    assert(inputs.node.sourceHashes[key]);
    assert.equal(
      inputs[runtime].sourceHashes[key],
      inputs.node.sourceHashes[key],
      `Different shared contract: ${name}`,
    );
  }
}
const populations = {};
for (const users of contract.populations) {
  populations[users] = {};
  const nodePeak = median(
    inputs.node.results[users].map((r) => r.observed.servicePeakBytes),
  );
  for (const runtime of ["node", "go", "rust"]) {
    const runs = inputs[runtime].results[users];
    const metrics = Object.fromEntries(
      Object.keys(runs[0].observed).map((key) => [
        key,
        stats(runs.map((r) => r.observed[key])),
      ]),
    );
    const failures = runs.flatMap(({ capacity }, index) =>
      Object.entries(capacity)
        .filter(([, value]) => value === false || value === null)
        .map(([key]) => ({ run: index + 1, criterion: key })),
    );
    const reduction = 1 - metrics.servicePeakBytes.median / nodePeak;
    populations[users][runtime] = {
      metrics,
      ramReduction: reduction,
      ramReductionAtLeast25Percent: reduction >= 0.25,
      worstServicePeakExceedsNode:
        metrics.servicePeakBytes.max >
        Math.max(
          ...inputs.node.results[users].map((r) => r.observed.servicePeakBytes),
        ),
      worstProcessPeakExceedsNode:
        metrics.processPeakBytes.max >
        Math.max(
          ...inputs.node.results[users].map((r) => r.observed.processPeakBytes),
        ),
      allCapacityRunsPassed: failures.length === 0,
      capacityFailures: failures,
      qualifies:
        runtime !== "node" && reduction >= 0.25 && failures.length === 0,
    };
  }
}
console.log(
  JSON.stringify(
    {
      boundary: contract.measurement,
      idleBoundary:
        "All runtimes: first unchanged phase after seed/bootstrap, before the three steady samples. Process-open samples remain in raw results but are not comparable startup points.",
      sources: Object.fromEntries(
        Object.entries(inputs).map(([name, input]) => [
          name,
          {
            directory: values[name],
            imageId: input.manifest.imageId,
            binarySha256: input.binary,
            sourceHashes: input.sourceHashes,
          },
        ]),
      ),
      populations,
      qualifiesAtRequiredPopulation: Object.fromEntries(
        ["go", "rust"].map((runtime) => [
          runtime,
          contract.populations.every(
            (users) => populations[users][runtime].qualifies,
          ),
        ]),
      ),
    },
    null,
    2,
  ),
);

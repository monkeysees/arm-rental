import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("service replay requires explicit candidate provenance before starting containers", () => {
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          "experiments/service-replay/run.js",
          "/tmp/unused-service-replay-output",
          "--runtime",
          "rust",
          "--holder",
          "/tmp/unused-service-replay-holder",
        ],
        { stdio: "pipe" },
      ),
    /--native-baseline must identify/,
  );
});

test("service replay CLI verifies native recovery and rejects overlapping accounting boundaries", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "service-replay-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let source = "test/fixtures/replay-reports/service.json";
  if (process.env.SERVICE_REPLAY_HOLDER) {
    const output = path.join(directory, "live");
    execFileSync(
      process.execPath,
      [
        "experiments/service-replay/run.js",
        output,
        "--runtime",
        "go",
        "--holder",
        process.env.SERVICE_REPLAY_HOLDER,
        "--native-baseline",
        process.env.SERVICE_REPLAY_BASELINE ?? "",
        "--users",
        "4",
        "--mode",
        "virtual",
        "--memory-bytes",
        "268435456",
      ],
      { stdio: "pipe" },
    );
    source = path.join(output, "4-virtual-1/result.json");
  }
  const original = JSON.parse(readFileSync(source, "utf8"));
  const filename = path.join(directory, "result.json");
  const run = (result) => {
    writeFileSync(filename, JSON.stringify(result));
    return execFileSync(
      process.execPath,
      ["experiments/service-replay/report.js", filename],
      { encoding: "utf8", stdio: "pipe" },
    );
  };
  assert.equal(JSON.parse(run(original))[0].boundary, "native-service-only-v1");
  for (const corrupt of [
    (result) =>
      result.phases
        .find((phase) => phase.name === "fresh")
        .deliveriesByProfile[0].reverse(),
    (result) => {
      result.accounting.boundary = "whole-replay";
    },
    (result) => {
      result.accounting.service.samples[0].memoryLimit = 1073741824;
    },
    (result) => {
      result.accounting.service.samples[0].processes.push({
        pid: 123,
        command: ["node", "coordinator.js"],
      });
    },
  ]) {
    const invalid = structuredClone(original);
    corrupt(invalid);
    assert.throws(() => run(invalid), /Command failed/);
  }
  const wrongMode = structuredClone(original);
  wrongMode.mode = "wall";
  assert.throws(
    () => run(wrongMode),
    /mode/,
    "virtual output must never become wall performance evidence",
  );
  const wrongBinary = structuredClone(original);
  wrongBinary.provenance.binarySha256 = "0".repeat(64);
  assert.throws(
    () => run(wrongBinary),
    /binary/,
    "binary provenance must match the original native baseline",
  );
  const unaccounted = structuredClone(original);
  delete unaccounted.accounting.harness.final.cpuStat;
  assert.throws(
    () => run(unaccounted),
    /harness/,
    "external harness CPU must be accounted separately",
  );
  const changed = structuredClone(original);
  changed.accounting.harness.cgroupPath = "/system.slice";
  assert.throws(
    () => run(changed),
    /overlap/,
    "an ancestor harness cgroup would double-count the service",
  );
});

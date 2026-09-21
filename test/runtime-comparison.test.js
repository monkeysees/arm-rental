import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("comparison report gates RAM claims on complete behavior and capacity evidence", (t) => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "runtime-comparison-test-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  cpSync("docs/benchmarks/go-replay/recovery", directory, { recursive: true });
  const args = [
    "experiments/runtime-comparison/report.js",
    "--node",
    "docs/benchmarks/node-replay/final",
    "--go",
    directory,
    "--rust",
    "docs/benchmarks/rust-replay/recovery",
  ];
  const run = () =>
    execFileSync(process.execPath, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const report = JSON.parse(run());
  assert.deepEqual(Object.keys(report.populations), ["500"]);
  assert.deepEqual(report.qualifiesAtRequiredPopulation, {
    go: false,
    rust: false,
  });
  assert.equal(report.populations["500"].go.qualifies, false);
  assert.equal(report.populations["500"].go.ramReductionAtLeast25Percent, true);
  assert.equal(report.populations["500"].go.allCapacityRunsPassed, false);
  const filename = path.join(directory, "500-wall-1.json");
  const result = JSON.parse(readFileSync(filename, "utf8"));
  result.phases
    .find((phase) => phase.name === "fresh")
    .deliveriesByProfile[0].reverse();
  writeFileSync(filename, JSON.stringify(result));
  assert.throws(run, /Command failed/);
  result.phases
    .find((phase) => phase.name === "fresh")
    .deliveriesByProfile[0].reverse();
  result.resources.memoryLimit = 1073741824;
  writeFileSync(filename, JSON.stringify(result));
  assert.throws(
    run,
    /Command failed/,
    "declared flags cannot substitute for observed cgroup limits",
  );
  result.resources.memoryLimit = 536870912;
  result.scope = "rust-full-contract";
  writeFileSync(filename, JSON.stringify(result));
  assert.throws(
    run,
    /Command failed/,
    "runtime directories must identify the claimed implementation",
  );
});

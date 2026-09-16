import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
test("retained-history CLI verifies same-process crawls, delivery bursts and restart recovery", async () => {
  const { stdout } = await run(process.execPath, [
    "scripts/retained-history-baseline.js",
    "--listings",
    "12",
    "--users",
    "4",
    "--decisions",
    "61",
    "--repeats",
    "3",
  ]);
  const report = JSON.parse(stdout);
  assert.equal(report.status, "passed");
  assert.equal(report.workload.decisions, 61);
  assert.deepEqual(report.results[0].decisionDistribution, [
    { status: "filtered", count: 46 },
    { status: "notified", count: 14 },
    { status: "skipped", count: 1 },
  ]);
  assert.equal(
    report.results.filter((phase) => phase.phase.startsWith("unchanged-"))
      .length,
    3,
  );
  assert.equal(
    report.results.find((phase) => phase.phase === "resumed").messages,
    5,
  );
  assert.equal(
    report.results.find((phase) => phase.phase === "posting-date-order")
      .messages,
    4,
  );
  assert.equal(report.duplicateDeliveries, 0);
  assert.equal(report.pendingDeliveries, 0);
  for (const phase of report.results) {
    assert(phase.wallMs >= 0);
    assert(phase.databaseBytes > 0);
    assert(phase.walBytes >= 0);
    assert(phase.rssBytes > 0);
  }
});

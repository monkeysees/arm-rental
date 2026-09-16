import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { verifyReplayResult } from "../experiments/node-replay/verify.js";

const exec = promisify(execFile);
test(
  "offline replay preserves explicit delivery and durable restart contracts",
  { timeout: 120000 },
  async () => {
    const { stdout } = await exec(process.execPath, [
      "experiments/node-replay/run.js",
      "--users",
      "4",
      "--mode",
      "virtual",
    ]);
    const result = JSON.parse(stdout);
    assert.equal(result.status, "passed");
    assert.equal(result.workload.decisionsPerRecipient, 6563);
    assert.equal(
      result.phases.find((phase) => phase.name === "catchup").sent,
      32,
    );
    assert.equal(
      result.phases.find((phase) => phase.name === "interrupted").sent,
      8,
    );
    assert.equal(
      result.phases.find((phase) => phase.name === "resumed").sent,
      24,
    );
    assert.equal(
      result.phases.find((phase) => phase.name === "drained").sent,
      0,
    );
    assert.equal(result.restart.uncleanExitCode, 23);
    assert.equal(result.capacity, null);
    assert(verifyReplayResult(result));
    const reordered = structuredClone(result);
    reordered.phases
      .find((phase) => phase.name === "fresh")
      .deliveriesByProfile[0].reverse();
    assert.throws(() => verifyReplayResult(reordered), /AssertionError/);
    const lostDecision = structuredClone(result);
    lostDecision.phases.find(
      (phase) => phase.name === "catchup",
    ).classificationsByProfile[0]["300000"] = "notified";
    assert.throws(() => verifyReplayResult(lostDecision), /AssertionError/);
  },
);

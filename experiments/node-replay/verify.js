import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { contract, phases, groupOf } from "./fixture.js";

// This oracle uses the documented decisions and hand-authored delivery lists,
// never Node's parser, filtering, selection, or repository implementation.
export function expectedClassifications(phase, group) {
  return Object.fromEntries(
    phase.ids.map((id) => {
      let status = groupOf(id) === group ? "notified" : "filtered";
      if (
        status === "notified" &&
        phase.name === "catchup" &&
        contract.expected.skippedCatchup[group].includes(id)
      )
        status = "skipped";
      if (
        status === "notified" &&
        phase.name === "interrupted" &&
        !contract.expected.interrupted[group].includes(id)
      )
        status = "pending";
      return [id, status];
    }),
  );
}
export function verifyReplayResult(result) {
  assert.equal(result.version, 1);
  assert.equal(result.status, "passed");
  const users = result.workload.users;
  assert([4, ...contract.populations].includes(users));
  assert.equal(result.workload.decisionsPerRecipient, 6563);
  const expectedNames = [
    "seed",
    "seed-decisions",
    ...Array(4).fill("unchanged"),
    "updated",
    "fresh",
    "catchup-store",
    "catchup",
    "interrupted",
    "resumed",
    "drained",
    "returning",
  ];
  assert.deepEqual(
    result.phases.map((phase) => phase.name),
    expectedNames,
  );
  for (const observed of result.phases) {
    const expected = contract.expected[observed.name];
    if (!expected) continue;
    const fixture = phases.find((phase) => phase.name === observed.name);
    assert.equal(observed.recipientsAsserted, users);
    assert.equal(observed.classifiedRecipients, users);
    assert.deepEqual(observed.deliveriesByProfile, expected);
    assert.equal(
      observed.sent,
      (expected.reduce((sum, ids) => sum + ids.length, 0) * users) / 4,
    );
    assert.deepEqual(
      observed.classificationsByProfile,
      [0, 1, 2, 3].map((group) => expectedClassifications(fixture, group)),
    );
  }
  const catchup = result.phases.find((phase) => phase.name === "catchup");
  assert.equal(catchup.announcements, users);
  assert.equal(catchup.retries, Math.ceil(users / 10));
  assert.equal(result.restart.uncleanExitCode, 23);
  assert.equal(result.restart.acknowledgedPrefixPreserved, true);
  assert.equal(result.restart.unsentSuffixDelivered, true);
  return true;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assert(
    process.argv[2],
    "Usage: node experiments/node-replay/verify.js RESULT.json",
  );
  verifyReplayResult(JSON.parse(readFileSync(process.argv[2], "utf8")));
  console.log("Replay result satisfies contract v1");
}

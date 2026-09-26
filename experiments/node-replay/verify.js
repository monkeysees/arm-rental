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
  if (["go-500-slice", "rust-500-slice"].includes(result.scope))
    return verifyNativeSlice(result);
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
  if (["go-full-contract", "rust-full-contract"].includes(result.scope)) {
    for (const observed of result.phases) {
      if (!contract.expected[observed.name]) continue;
      verifyNativePayloads(observed, contract.expected[observed.name]);
    }
    assert.equal(catchup.attempts, users * 9 + Math.ceil(users / 10));
    assert(catchup.drainMs >= 12000);
    assert.equal(result.resources.decisionRows, users * (6563 + 80));
    assert.equal(result.resources.pendingRows, 0);
  }
  return true;
}

function verifyNativePayloads(observed, expected) {
  assert(observed.maxInFlight <= 8);
  assert.equal(observed.rateLimitsVerified, true);
  for (let group = 0; group < 4; group++) {
    assert.deepEqual(
      observed.payloadsByProfile[group],
      expected[group].map((id) => ({
        id,
        kind: contract.profiles[group].kind,
        title: `Replay rental ${id}${observed.name === "updated" ? " updated" : ""}`,
        url: `https://www.list.am/ru/item/${id}`,
        price: contract.profiles[group].price,
        originalAmount: contract.profiles[group].originalAmount,
        currency: contract.profiles[group].currency,
        location: "Арабкир",
        rooms: 2,
        areaSqM: 60,
        floor: "3/9",
        postedAt: Date.parse(
          Number(id) < 200000
            ? "2026-09-15T23:59:59.999Z"
            : "2026-09-16T23:59:59.999Z",
        ),
      })),
    );
  }
}
export function verifyNativeSlice(result) {
  assert.equal(result.version, 1);
  assert.equal(result.status, "passed");
  const users = result.workload.users;
  assert([4, 500].includes(users));
  assert.equal(result.workload.decisionsPerRecipient, 6563);
  assert.deepEqual(
    result.phases.map((p) => p.name),
    [
      "seed",
      "seed-decisions",
      ...Array(4).fill("unchanged"),
      "updated",
      "fresh",
      "catchup-store",
      "catchup",
      "reopen-unchanged",
    ],
  );
  for (const observed of result.phases) {
    const reopen = observed.name === "reopen-unchanged";
    const expected = reopen
      ? contract.expected.unchanged
      : contract.expected[observed.name];
    if (!expected) continue;
    assert.equal(observed.recipientsAsserted, users);
    assert.equal(observed.classifiedRecipients, users);
    assert.deepEqual(observed.deliveriesByProfile, expected);
    assert.equal(observed.sent, (expected.flat().length * users) / 4);
    const fixture = phases.find(
      (p) => p.name === (reopen ? "catchup" : observed.name),
    );
    assert.deepEqual(
      observed.classificationsByProfile,
      [0, 1, 2, 3].map((group) => expectedClassifications(fixture, group)),
    );
    verifyNativePayloads(observed, expected);
  }
  const catchup = result.phases.find((p) => p.name === "catchup");
  assert.equal(catchup.announcements, users);
  assert.equal(catchup.retries, Math.ceil(users / 10));
  assert.equal(catchup.attempts, users * 9 + Math.ceil(users / 10));
  assert(catchup.drainMs >= 12000);
  assert.deepEqual(result.restart, {
    cleanReopen: true,
    acknowledgementsPreserved: true,
    unchangedSendsNothing: true,
  });
  assert.equal(result.resources.decisionRows, users * (6563 + 48));
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

import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateNativeCapacity } from "./capacity.js";

test("native capacity preserves progress without relaxing contract-v1 deadlines", () => {
  const catchup = {
    name: "catchup",
    attempts: 4550,
    sent: 4000,
    recipientsAsserted: 500,
    classificationWallMs: 100,
    firstProgressMaxMs: 500,
    wallMs: 25026,
  };
  const input = {
    users: 500,
    mode: "wall",
    primaryRamBytes: 50000000,
    phases: [
      {
        name: "updated",
        classifiedRecipients: 500,
        classificationWallMs: 10,
        wallMs: 100,
      },
      {
        name: "fresh",
        classifiedRecipients: 500,
        classificationWallMs: 10,
        wallMs: 100,
      },
      catchup,
    ],
  };
  const result = evaluateNativeCapacity(input);
  assert.equal(result.allRecipientsProgressed, true);
  assert.equal(result.fairProgress, true);
  assert.equal(result.catchupWithinPermittedRateTarget, false);
  assert.equal(result.fairProgressDeadlineMs, 6105);
  assert.equal(catchup.recipientsWithProgress, undefined);
  const changedCatchup = (changes) =>
    evaluateNativeCapacity({
      ...input,
      phases: [...input.phases.slice(0, 2), { ...catchup, ...changes }],
    });
  assert.equal(
    changedCatchup({ wallMs: 25025 }).catchupWithinPermittedRateTarget,
    true,
  );
  assert.equal(changedCatchup({ sent: 0 }).allRecipientsProgressed, false);
  // 6,670 ms alone passes; adding 100 ms classification exceeds 6,715.5 ms.
  assert.equal(
    changedCatchup({ firstProgressMaxMs: 6670 }).fairProgress,
    false,
  );
});

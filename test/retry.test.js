import assert from "node:assert/strict";
import test from "node:test";

import {
  ExponentialBackoff,
  isExpectedExternalFailure,
  MAX_RETRY_DELAY_MS,
  retryOperation,
} from "../src/retry.js";

test("bounded backoff grows exponentially with jitter and resets after success", async () => {
  const backoff = new ExponentialBackoff({
    baseDelayMs: 1_000,
    maxDelayMs: 5_000,
    jitterRatio: 0.2,
    random: () => 0.5,
  });

  assert.deepEqual(
    [backoff.nextDelay(), backoff.nextDelay(), backoff.nextDelay()],
    [900, 1_800, 3_600],
  );
  assert.equal(backoff.nextDelay(), 4_500);

  const delays = [];
  let calls = 0;
  await retryOperation(
    async () => {
      calls += 1;
      if (calls < 3) {
        throw Object.assign(new TypeError("network unavailable"), {
          code: "ECONNRESET",
        });
      }
      return "ok";
    },
    {
      backoff,
      sleep: async (delayMs) => delays.push(delayMs),
    },
  );
  assert.equal(calls, 3);
  assert.deepEqual(delays, [4_500, 4_500]);
  assert.equal(backoff.nextDelay(), 900, "success resets the failure counter");
});

test("retry policy accepts network and 5xx failures but rejects terminal state", () => {
  assert.equal(
    isExpectedExternalFailure(
      Object.assign(new Error("upstream"), { httpStatus: 503 }),
    ),
    true,
  );
  assert.equal(
    isExpectedExternalFailure(
      Object.assign(new Error("credentials"), {
        httpStatus: 503,
        terminal: true,
      }),
    ),
    false,
  );
  assert.throws(
    () =>
      new ExponentialBackoff({
        maxDelayMs: MAX_RETRY_DELAY_MS + 1,
      }),
    /five minutes/u,
  );
});

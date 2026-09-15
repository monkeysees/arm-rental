import assert from "node:assert/strict";
import test from "node:test";

import {
  ExponentialBackoff,
  isExpectedExternalFailure,
  MAX_RETRY_DELAY_MS,
  retryOperation,
  retryAfterMilliseconds,
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
    isExpectedExternalFailure({ code: "ERR_LIST_AM_CHALLENGE" }),
    true,
  );
  assert.equal(
    isExpectedExternalFailure({
      code: "ERR_LIST_AM_CHALLENGE",
      terminal: true,
    }),
    false,
  );
  assert.equal(
    isExpectedExternalFailure(
      Object.assign(new Error("source drift"), {
        code: "ERR_LIST_AM_SOURCE_INTEGRITY",
      }),
    ),
    true,
  );
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

test("HTTP Retry-After accepts seconds and future dates without shortening them", () => {
  const now = Date.parse("2026-09-15T12:00:00Z");
  assert.equal(retryAfterMilliseconds("180"), 180_000);
  assert.equal(
    retryAfterMilliseconds("Tue, 15 Sep 2026 12:03:00 GMT", now),
    180_000,
  );
  for (const value of [undefined, "", "garbage", "-1", "9007199254740992"]) {
    assert.equal(retryAfterMilliseconds(value, now), undefined);
  }
  assert.equal(isExpectedExternalFailure({ httpStatus: 429 }), true);
  assert.equal(
    isExpectedExternalFailure({ code: "ERR_LIST_AM_TRANSPORT" }),
    true,
  );
});

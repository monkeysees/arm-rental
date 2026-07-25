import assert from "node:assert/strict";
import test from "node:test";

import {
  PRIVATE_LIMITER_IDLE_MS,
  PRIVATE_RESPONSE_WINDOW_MS,
  ResponseWindowGate,
  TokenBucketStore,
  createPrivateRateLimits,
} from "../src/rate-limit.js";

function fakeClock() {
  let current = 0;
  return {
    now: () => current,
    advance: (milliseconds) => {
      current += milliseconds;
    },
  };
}

test("token buckets share bursts with continuous fractional refill and a cap", () => {
  const clock = fakeClock();
  const buckets = new TokenBucketStore({
    capacity: 5,
    refillPerMinute: 5,
    monotonicNow: clock.now,
  });

  assert.deepEqual(
    Array.from({ length: 6 }, () => buckets.tryConsume("sender")),
    [true, true, true, true, true, false],
  );
  clock.advance(6_000);
  assert.equal(buckets.tryConsume("sender"), false);
  clock.advance(6_000);
  assert.equal(buckets.tryConsume("sender"), true);

  clock.advance(2 * 60_000);
  assert.deepEqual(
    Array.from({ length: 6 }, () => buckets.tryConsume("sender")),
    [true, true, true, true, true, false],
  );
});

test("token buckets expire after inactivity, retain active denials, and reset", () => {
  const clock = fakeClock();
  const buckets = new TokenBucketStore({
    capacity: 1,
    refillPerMinute: 0.001,
    monotonicNow: clock.now,
  });

  assert.equal(buckets.tryConsume("active"), true);
  assert.equal(buckets.tryConsume("inactive"), true);
  clock.advance(PRIVATE_LIMITER_IDLE_MS - 60_000);
  assert.equal(buckets.tryConsume("active"), false);
  clock.advance(60_000);
  assert.equal(buckets.pruneInactive(), 1);
  assert.equal(buckets.size, 1);

  assert.equal(buckets.delete("active"), true);
  assert.equal(buckets.tryConsume("active"), true);
  assert.equal(buckets.size, 1);
});

test("response gates allow one attempt per window and reset with the process", () => {
  const clock = fakeClock();
  const gate = new ResponseWindowGate({ monotonicNow: clock.now });

  assert.equal(gate.tryAcquire("sender"), true);
  assert.equal(gate.tryAcquire("sender"), false);
  clock.advance(PRIVATE_RESPONSE_WINDOW_MS - 1);
  assert.equal(gate.tryAcquire("sender"), false);
  clock.advance(1);
  assert.equal(gate.tryAcquire("sender"), true);
  assert.equal(gate.delete("sender"), true);
  assert.equal(gate.tryAcquire("sender"), true);

  const restarted = new ResponseWindowGate({ monotonicNow: clock.now });
  assert.equal(restarted.tryAcquire("sender"), true);
});

test("private rate-limit state clears one sender without imposing capacity", () => {
  const clock = fakeClock();
  const limits = createPrivateRateLimits(5, { monotonicNow: clock.now });

  for (let sender = 1; sender <= 1_000; sender += 1) {
    assert.equal(limits.inboundUpdates.tryConsume(sender), true);
  }
  assert.equal(limits.inboundUpdates.size, 1_000);
  assert.equal(limits.accessDeniedResponses.tryAcquire(500), true);
  assert.equal(limits.rateLimitedResponses.tryAcquire(500), true);

  limits.clearSender(500);
  assert.equal(limits.inboundUpdates.size, 999);
  assert.equal(limits.accessDeniedResponses.size, 0);
  assert.equal(limits.rateLimitedResponses.size, 0);

  const restarted = createPrivateRateLimits(5, {
    monotonicNow: clock.now,
  });
  assert.deepEqual(
    Array.from({ length: 5 }, () => restarted.inboundUpdates.tryConsume(500)),
    [true, true, true, true, true],
  );
});

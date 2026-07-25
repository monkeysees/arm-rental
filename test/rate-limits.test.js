import assert from "node:assert/strict";
import test from "node:test";

import {
  PRIVATE_DELIVERY_BURST,
  PRIVATE_LIMITER_IDLE_MS,
  PRIVATE_RESPONSE_WINDOW_MS,
  PrivateDeliveryRateLimiter,
  ResponseWindowGate,
  TokenBucketStore,
  createPrivateRateLimits,
} from "../src/rate-limit.js";
import { TelegramApi } from "../src/telegram.js";

function fakeClock() {
  let current = 0;
  return {
    now: () => current,
    advance: (milliseconds) => {
      current += milliseconds;
    },
  };
}

function advancingSleep(clock) {
  const waits = [];
  return {
    waits,
    sleep: async (milliseconds, _value, { signal } = {}) => {
      signal?.throwIfAborted();
      waits.push(milliseconds);
      clock.advance(milliseconds);
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

test("token buckets accept exact refill boundaries without granting early tokens", () => {
  for (const refillPerMinute of [7, 13]) {
    let now = 0;
    const bucket = new TokenBucketStore({
      capacity: 1,
      refillPerMinute,
      monotonicNow: () => now,
    });
    assert.equal(bucket.tryConsume("sender"), true);

    const exactBoundary = 60_000 / refillPerMinute;
    now = exactBoundary - 0.000_001;
    assert.equal(bucket.tryConsume("sender"), false);
    now = exactBoundary;
    assert.equal(bucket.tryConsume("sender"), true);
  }
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

test("inbound update retries reuse accepted and rejected decisions", () => {
  const clock = fakeClock();
  const limits = createPrivateRateLimits(5, { monotonicNow: clock.now });

  assert.equal(limits.tryConsumeUpdate(42, 1), true);
  assert.equal(limits.tryConsumeUpdate(42, 1), true);
  for (let updateId = 2; updateId <= 5; updateId += 1) {
    assert.equal(limits.tryConsumeUpdate(42, updateId), true);
  }
  assert.equal(limits.tryConsumeUpdate(42, 6), false);
  assert.equal(limits.tryConsumeUpdate(42, 6), false);

  clock.advance(12_000);
  assert.equal(
    limits.tryConsumeUpdate(42, 6),
    false,
    "a rejected replay keeps its original decision",
  );
  assert.equal(
    limits.tryConsumeUpdate(42, 7),
    true,
    "the rejected replay did not spend the refilled token",
  );
});

test("private delivery buckets preserve burst, fractional refill, and restart reset", async () => {
  const clock = fakeClock();
  const timer = advancingSleep(clock);
  const limiter = new PrivateDeliveryRateLimiter({
    deliveriesPerMinute: 20,
    monotonicNow: clock.now,
    sleep: timer.sleep,
  });
  const deliveredAt = [];
  const deliver = () => deliveredAt.push(clock.now());

  for (let index = 0; index < PRIVATE_DELIVERY_BURST + 1; index += 1) {
    await limiter.run("recipient", deliver);
  }
  clock.advance(1_500);
  await limiter.run("recipient", deliver);

  assert.deepEqual(deliveredAt, [0, 0, 0, 0, 0, 3_000, 6_000]);
  assert.deepEqual(timer.waits, [3_000, 1_500]);

  clock.advance(60_000);
  const afterIdle = [];
  for (let index = 0; index < PRIVATE_DELIVERY_BURST; index += 1) {
    await limiter.run("recipient", () => afterIdle.push(clock.now()));
  }
  assert.equal(new Set(afterIdle).size, 1, "refill remains capped at five");

  const restarted = new PrivateDeliveryRateLimiter({
    deliveriesPerMinute: 20,
    monotonicNow: clock.now,
    sleep: timer.sleep,
  });
  for (let index = 0; index < PRIVATE_DELIVERY_BURST; index += 1) {
    await restarted.run("recipient", () => {});
  }
  assert.equal(restarted.size, 1);
});

test("private delivery waits abort and active operations resist idle eviction", async () => {
  const clock = fakeClock();
  let waitStarted;
  const waiting = new Promise((resolve) => {
    waitStarted = resolve;
  });
  const limiter = new PrivateDeliveryRateLimiter({
    deliveriesPerMinute: 1,
    monotonicNow: clock.now,
    sleep: async (_milliseconds, _value, { signal }) => {
      waitStarted();
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
  });

  for (let index = 0; index < PRIVATE_DELIVERY_BURST; index += 1) {
    await limiter.run("recipient", async () => {});
  }
  const controller = new AbortController();
  let invoked = false;
  const aborted = limiter.run(
    "recipient",
    async () => {
      invoked = true;
    },
    { signal: controller.signal },
  );
  await waiting;
  clock.advance(PRIVATE_LIMITER_IDLE_MS);
  assert.equal(limiter.pruneInactive(), 0);
  controller.abort();
  await assert.rejects(aborted, { name: "AbortError" });
  assert.equal(invoked, false);

  clock.advance(PRIVATE_LIMITER_IDLE_MS);
  assert.equal(limiter.pruneInactive(), 1);
  assert.equal(limiter.size, 0);
});

test("Telegram retry_after remains authoritative after a product-rate wait", async () => {
  const clock = fakeClock();
  const timer = advancingSleep(clock);
  let requests = 0;
  const api = new TelegramApi("secret", {
    fetchImpl: async () => {
      requests += 1;
      if (requests === PRIVATE_DELIVERY_BURST + 1) {
        return Response.json(
          {
            ok: false,
            description: "Too Many Requests",
            parameters: { retry_after: 7 },
          },
          { status: 429 },
        );
      }
      return Response.json({ ok: true, result: { message_id: requests } });
    },
    sleep: timer.sleep,
  });
  const limiter = new PrivateDeliveryRateLimiter({
    deliveriesPerMinute: 20,
    monotonicNow: clock.now,
    sleep: timer.sleep,
  });

  for (let index = 0; index < PRIVATE_DELIVERY_BURST + 1; index += 1) {
    await limiter.run("recipient", () =>
      api.sendMessage(42, `Apartment ${index}`),
    );
  }

  assert.equal(requests, PRIVATE_DELIVERY_BURST + 2);
  assert.deepEqual(timer.waits, [3_000, 7_000]);
  assert.equal(clock.now(), 10_000);
});

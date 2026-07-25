import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

const MINUTE_MS = 60_000;
export const PRIVATE_LIMITER_IDLE_MS = 15 * MINUTE_MS;
export const PRIVATE_RESPONSE_WINDOW_MS = 5 * MINUTE_MS;
export const PRIVATE_DELIVERY_BURST = 5;

function positiveFinite(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
  return value;
}

/**
 * Process-local token buckets keyed by an operational identifier. Keys never
 * leave this object, keeping rate-limit diagnostics free of user identifiers.
 */
export class TokenBucketStore {
  constructor({
    capacity,
    refillPerMinute,
    idleMs = PRIVATE_LIMITER_IDLE_MS,
    monotonicNow = () => performance.now(),
  }) {
    this.capacity = positiveFinite(capacity, "capacity");
    this.refillPerMs =
      positiveFinite(refillPerMinute, "refillPerMinute") / MINUTE_MS;
    this.idleMs = positiveFinite(idleMs, "idleMs");
    this.monotonicNow = monotonicNow;
    this.buckets = new Map();
  }

  tryConsume(key) {
    const now = this.monotonicNow();
    this.pruneInactive(now);
    const previous = this.buckets.get(key);
    const elapsedMs = previous ? Math.max(0, now - previous.refilledAt) : 0;
    const tokens = previous
      ? Math.min(this.capacity, previous.tokens + elapsedMs * this.refillPerMs)
      : this.capacity;
    const exactBoundaryReached =
      previous?.nextTokenAt !== undefined && now >= previous.nextTokenAt;
    const accepted = previous?.nextTokenAt ? exactBoundaryReached : tokens >= 1;
    const availableTokens = exactBoundaryReached ? Math.max(1, tokens) : tokens;
    const remainingTokens = accepted ? availableTokens - 1 : availableTokens;

    this.buckets.set(key, {
      tokens: remainingTokens,
      refilledAt: now,
      lastActivityAt: now,
      ...(remainingTokens < 1
        ? {
            nextTokenAt:
              accepted || previous?.nextTokenAt === undefined
                ? now + (1 - remainingTokens) / this.refillPerMs
                : previous.nextTokenAt,
          }
        : {}),
    });
    return accepted;
  }

  pruneInactive(now = this.monotonicNow()) {
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastActivityAt < this.idleMs) continue;
      this.buckets.delete(key);
      removed += 1;
    }
    return removed;
  }

  delete(key) {
    return this.buckets.delete(key);
  }

  get size() {
    return this.buckets.size;
  }
}

/**
 * Process-local apartment delivery buckets. A recipient's wait and Telegram
 * operation stay active together so idle eviction cannot reset a slow batch.
 */
export class PrivateDeliveryRateLimiter {
  constructor({
    deliveriesPerMinute,
    idleMs = PRIVATE_LIMITER_IDLE_MS,
    monotonicNow = () => performance.now(),
    sleep = delay,
  }) {
    this.capacity = PRIVATE_DELIVERY_BURST;
    this.refillPerMs =
      positiveFinite(deliveriesPerMinute, "deliveriesPerMinute") / MINUTE_MS;
    this.idleMs = positiveFinite(idleMs, "idleMs");
    this.monotonicNow = monotonicNow;
    this.sleep = sleep;
    this.buckets = new Map();
  }

  #nowAfter(previous) {
    return Math.max(previous, this.monotonicNow());
  }

  #refill(bucket) {
    const now = this.#nowAfter(bucket.refilledAt);
    bucket.tokens = Math.min(
      this.capacity,
      bucket.tokens + (now - bucket.refilledAt) * this.refillPerMs,
    );
    bucket.refilledAt = now;
    return now;
  }

  #bucket(key) {
    const existing = this.buckets.get(key);
    if (existing) return existing;

    const now = this.monotonicNow();
    const bucket = {
      tokens: this.capacity,
      refilledAt: now,
      lastActivityAt: now,
      activeOperations: 0,
    };
    this.buckets.set(key, bucket);
    return bucket;
  }

  async #acquire(bucket, signal) {
    for (;;) {
      signal?.throwIfAborted();
      const now = this.#refill(bucket);
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        bucket.lastActivityAt = now;
        return;
      }

      const waitMs = Math.ceil((1 - bucket.tokens) / this.refillPerMs);
      await this.sleep(waitMs, undefined, { signal });
    }
  }

  async run(key, operation, { signal } = {}) {
    if (typeof operation !== "function") {
      throw new TypeError("operation must be a function");
    }

    this.pruneInactive();
    const bucket = this.#bucket(String(key));
    bucket.activeOperations += 1;
    bucket.lastActivityAt = this.#nowAfter(bucket.lastActivityAt);

    try {
      await this.#acquire(bucket, signal);
      return await operation();
    } finally {
      bucket.activeOperations -= 1;
      bucket.lastActivityAt = this.#nowAfter(bucket.lastActivityAt);
      this.pruneInactive();
    }
  }

  pruneInactive(now = this.monotonicNow()) {
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      if (
        bucket.activeOperations > 0 ||
        now - bucket.lastActivityAt < this.idleMs
      ) {
        continue;
      }
      this.buckets.delete(key);
      removed += 1;
    }
    return removed;
  }

  clearRecipient(recipientId) {
    return this.buckets.delete(String(recipientId));
  }

  get size() {
    return this.buckets.size;
  }
}

/** A process-local, first-event-wins gate for bounded user-facing responses. */
export class ResponseWindowGate {
  constructor({
    windowMs = PRIVATE_RESPONSE_WINDOW_MS,
    monotonicNow = () => performance.now(),
  } = {}) {
    this.windowMs = positiveFinite(windowMs, "windowMs");
    this.monotonicNow = monotonicNow;
    this.lastResponses = new Map();
  }

  tryAcquire(key) {
    const now = this.monotonicNow();
    this.pruneExpired(now);
    if (this.lastResponses.has(key)) return false;
    this.lastResponses.set(key, now);
    return true;
  }

  pruneExpired(now = this.monotonicNow()) {
    let removed = 0;
    for (const [key, lastResponseAt] of this.lastResponses) {
      if (now - lastResponseAt < this.windowMs) continue;
      this.lastResponses.delete(key);
      removed += 1;
    }
    return removed;
  }

  delete(key) {
    return this.lastResponses.delete(key);
  }

  get size() {
    return this.lastResponses.size;
  }
}

export function createPrivateRateLimits(
  updatesPerMinute,
  { monotonicNow = () => performance.now() } = {},
) {
  const inboundUpdates = new TokenBucketStore({
    capacity: updatesPerMinute,
    refillPerMinute: updatesPerMinute,
    monotonicNow,
  });
  const accessDeniedResponses = new ResponseWindowGate({ monotonicNow });
  const rateLimitedResponses = new ResponseWindowGate({ monotonicNow });
  const rateLimitedEvents = new ResponseWindowGate({ monotonicNow });
  const inboundUpdateDecisions = new Map();

  const pruneUpdateDecisions = (now = monotonicNow()) => {
    for (const [senderId, entry] of inboundUpdateDecisions) {
      if (now - entry.lastActivityAt < PRIVATE_LIMITER_IDLE_MS) continue;
      inboundUpdateDecisions.delete(senderId);
    }
  };

  return {
    inboundUpdates,
    accessDeniedResponses,
    rateLimitedResponses,
    rateLimitedEvents,
    tryConsumeUpdate(senderId, updateId) {
      if (!Number.isSafeInteger(updateId)) {
        return inboundUpdates.tryConsume(senderId);
      }
      const now = monotonicNow();
      pruneUpdateDecisions(now);
      let entry = inboundUpdateDecisions.get(senderId);
      if (!entry) {
        entry = { decisions: new Map(), lastActivityAt: now };
        inboundUpdateDecisions.set(senderId, entry);
      }
      entry.lastActivityAt = now;
      if (entry.decisions.has(updateId)) return entry.decisions.get(updateId);

      const accepted = inboundUpdates.tryConsume(senderId);
      entry.decisions.set(updateId, accepted);
      return accepted;
    },
    pruneInactive() {
      inboundUpdates.pruneInactive();
      accessDeniedResponses.pruneExpired();
      rateLimitedResponses.pruneExpired();
      rateLimitedEvents.pruneExpired();
      pruneUpdateDecisions();
    },
    clearSender(senderId) {
      inboundUpdates.delete(senderId);
      accessDeniedResponses.delete(senderId);
      rateLimitedResponses.delete(senderId);
      inboundUpdateDecisions.delete(senderId);
    },
  };
}

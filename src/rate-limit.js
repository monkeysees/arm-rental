import { performance } from "node:perf_hooks";

const MINUTE_MS = 60_000;
export const PRIVATE_LIMITER_IDLE_MS = 15 * MINUTE_MS;
export const PRIVATE_RESPONSE_WINDOW_MS = 5 * MINUTE_MS;

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
    const accepted = tokens >= 1;

    this.buckets.set(key, {
      tokens: accepted ? tokens - 1 : tokens,
      refilledAt: now,
      lastActivityAt: now,
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

  return {
    inboundUpdates,
    accessDeniedResponses,
    rateLimitedResponses,
    rateLimitedEvents,
    pruneInactive() {
      inboundUpdates.pruneInactive();
      accessDeniedResponses.pruneExpired();
      rateLimitedResponses.pruneExpired();
      rateLimitedEvents.pruneExpired();
    },
    clearSender(senderId) {
      inboundUpdates.delete(senderId);
      accessDeniedResponses.delete(senderId);
      rateLimitedResponses.delete(senderId);
    },
  };
}

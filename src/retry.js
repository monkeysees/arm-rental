import { setTimeout as delay } from "node:timers/promises";

export const MAX_RETRY_DELAY_MS = 5 * 60 * 1_000;

const NETWORK_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function positiveDelay(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function isExpectedExternalFailure(error) {
  if (error?.terminal) return false;
  if (error?.code === "ERR_LIST_AM_SOURCE_INTEGRITY") return true;
  if (
    Number.isSafeInteger(error?.httpStatus) &&
    error.httpStatus >= 500 &&
    error.httpStatus <= 599
  ) {
    return true;
  }
  return (
    NETWORK_ERROR_CODES.has(error?.code) ||
    error?.name === "TimeoutError" ||
    error?.name === "TypeError"
  );
}

export class ExponentialBackoff {
  constructor({
    baseDelayMs = 1_000,
    maxDelayMs = 60_000,
    jitterRatio = 0.2,
    random = Math.random,
  } = {}) {
    this.baseDelayMs = positiveDelay(baseDelayMs, "baseDelayMs");
    this.maxDelayMs = positiveDelay(maxDelayMs, "maxDelayMs");
    if (this.maxDelayMs > MAX_RETRY_DELAY_MS) {
      throw new Error("maxDelayMs must not exceed five minutes");
    }
    if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
      throw new Error("jitterRatio must be between 0 and 1");
    }
    this.jitterRatio = jitterRatio;
    this.random = random;
    this.failures = 0;
  }

  nextDelay() {
    const exponential = Math.min(
      this.maxDelayMs,
      this.baseDelayMs * 2 ** this.failures,
    );
    this.failures += 1;
    const floor = exponential * (1 - this.jitterRatio);
    return Math.round(
      Math.min(
        this.maxDelayMs,
        floor + exponential * this.jitterRatio * this.random(),
      ),
    );
  }

  reset() {
    this.failures = 0;
  }
}

export async function retryOperation(
  operation,
  {
    maxAttempts = 4,
    backoff = new ExponentialBackoff(),
    shouldRetry = isExpectedExternalFailure,
    retryDelay,
    sleep = delay,
    signal,
    onRetry = () => {},
  } = {},
) {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
    throw new Error("maxAttempts must be a positive integer");
  }

  for (let attempt = 1; ; attempt += 1) {
    try {
      const result = await operation(attempt);
      backoff.reset();
      return result;
    } catch (error) {
      if (signal?.aborted || attempt >= maxAttempts || !shouldRetry(error)) {
        throw error;
      }
      const override = retryDelay?.(error);
      const delayMs =
        Number.isSafeInteger(override) && override >= 0
          ? override
          : backoff.nextDelay();
      await onRetry({ attempt, delayMs, error });
      await sleep(delayMs, undefined, { signal });
    }
  }
}

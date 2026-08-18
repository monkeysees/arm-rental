export function canonicalIsoTimestamp(value, label = "timestamp") {
  if (typeof value !== "string")
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
  return value;
}

export function nonEmptyIdentifier(value, label) {
  const normalized = String(value);
  if (normalized.length === 0)
    throw new TypeError(`${label} must be non-empty`);
  return normalized;
}

export function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

export function nonnegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

export function serializeJson(value, label) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError(`${label} must be JSON serializable`);
  }
  if (serialized === undefined)
    throw new TypeError(`${label} must be JSON serializable`);
  return serialized;
}

export function parseStoredJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    const error = new Error(`Stored ${label} is not valid JSON`);
    error.code = "ERR_STATE_DATABASE_INVALID_JSON";
    throw error;
  }
}

export function entriesFromDecisions(decisions, label) {
  if (decisions === undefined) return [];
  if (!decisions || typeof decisions !== "object" || Array.isArray(decisions)) {
    throw new TypeError(`${label} decisions must be an object`);
  }
  return Object.entries(decisions).map(([itemId, timestamp]) => [
    nonEmptyIdentifier(itemId, "Delivery item ID"),
    canonicalIsoTimestamp(timestamp, "Delivery decision timestamp"),
  ]);
}

export function runRepositoryTransaction(
  database,
  operation,
  enabled,
  callback,
) {
  return enabled ? database.transaction(operation, callback) : callback();
}

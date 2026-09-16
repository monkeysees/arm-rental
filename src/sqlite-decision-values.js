import { canonicalIsoTimestamp } from "./sqlite-repository-values.js";

export const PRIVATE_DECISION_STATUSES = ["notified", "skipped", "filtered"];

export function decisionMilliseconds(timestamp) {
  return Date.parse(
    canonicalIsoTimestamp(timestamp, "Delivery decision timestamp"),
  );
}

export function decisionTimestamp(milliseconds) {
  if (
    !Number.isSafeInteger(milliseconds) ||
    Math.abs(milliseconds) > 8_640_000_000_000_000
  ) {
    throw new TypeError(
      "Stored delivery decision must represent a canonical ISO timestamp",
    );
  }
  return new Date(milliseconds).toISOString();
}

export function decisionStatusCode(status) {
  const code = PRIVATE_DECISION_STATUSES.indexOf(status);
  if (code < 0) throw new TypeError("Invalid private delivery status");
  return code;
}

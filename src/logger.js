import packageMetadata from "../package.json" with { type: "json" };
import { getEnvironmentName } from "./environment-config.js";

const REDACTED = "[REDACTED]";
const DEFAULT_FAILURE_WINDOW_MS = 5 * 60 * 1_000;
const SENSITIVE_KEY =
  /(?:authorization|credential|password|secret|token|api[-_]?key|cookie)/iu;

function redactString(value) {
  return value
    .replace(
      /(https?:\/\/api\.telegram\.org\/(?:file\/)?bot)[^/\s?#]+/giu,
      `$1${REDACTED}`,
    )
    .replace(/\b\d{6,12}:[a-z0-9_-]{20,}\b/giu, REDACTED)
    .replace(/\b(Bearer|Basic)\s+[a-z0-9._~+/=-]+/giu, `$1 ${REDACTED}`)
    .replace(
      /\b(authorization|proxy-authorization)(\s*[:=]\s*)[^\s,;}\]]+/giu,
      `$1$2${REDACTED}`,
    )
    .replace(
      /\b(client_secret|access_token|refresh_token|api_key)(\s*[:=]\s*)[^&\s,;}\]]+/giu,
      `$1$2${REDACTED}`,
    );
}

function redact(value, seen = new WeakSet()) {
  if (typeof value === "string") return redactString(value);
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry, seen));
  }

  const sanitized = {};
  for (const [key, entry] of Object.entries(value)) {
    sanitized[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(entry, seen);
  }
  return sanitized;
}

function serializeError(error) {
  return {
    name: error?.name,
    code: error?.code,
    ...(Number.isInteger(error?.sqliteResultCode)
      ? { sqliteResultCode: error.sqliteResultCode }
      : {}),
    message: error?.message || String(error),
    stack: error?.stack,
  };
}

function eventFromMessage(message) {
  const normalized = String(message)
    .normalize("NFKD")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, ".")
    .replace(/^\.+|\.+$/gu, "");
  return normalized || "application.event";
}

function failureSignature(record) {
  return JSON.stringify({
    severity: record.severity,
    event: record.event,
    component: record.component,
    code: record.code || record.error?.code,
    errorName: record.error?.name,
    errorMessage: record.error?.message,
  });
}

/**
 * Creates the process JSON logger. Warning/error duplicates are suppressed for
 * a bounded window; the next emitted occurrence reports how many were omitted.
 */
export function createLogger(
  output = console,
  {
    environment = getEnvironmentName(),
    applicationVersion = packageMetadata.version,
    now = () => new Date(),
    failureWindowMs = DEFAULT_FAILURE_WINDOW_MS,
  } = {},
) {
  const failures = new Map();

  const write = (severity, message, context = {}) => {
    const {
      event: suppliedEvent,
      eventName,
      ...details
    } = context && typeof context === "object" ? context : {};
    const event =
      (typeof suppliedEvent === "string" && suppliedEvent) ||
      eventName ||
      eventFromMessage(redactString(String(message)));
    const timestamp = now();
    const timestampMs =
      timestamp instanceof Date ? timestamp.getTime() : Date.parse(timestamp);
    const record = redact({
      timestamp:
        timestamp instanceof Date ? timestamp.toISOString() : String(timestamp),
      severity,
      environment,
      applicationVersion,
      event,
      message,
      ...details,
    });

    // Alert producers emit state transitions; suppressing an edge loses it forever.
    if (
      (severity === "warn" || severity === "error") &&
      event !== "alert.firing" &&
      event !== "alert.resolved"
    ) {
      const signature = failureSignature(record);
      const previous = failures.get(signature);
      if (previous && timestampMs - previous.lastEmittedAt < failureWindowMs) {
        previous.suppressedCount += 1;
        return;
      }
      if (previous?.suppressedCount) {
        record.suppressedCount = previous.suppressedCount;
      }
      failures.set(signature, {
        lastEmittedAt: timestampMs,
        suppressedCount: 0,
      });
      if (failures.size > 1_000) {
        failures.delete(failures.keys().next().value);
      }
    }

    output[severity === "error" ? "error" : "log"](JSON.stringify(record));
  };

  return {
    info: (message, context) => write("info", message, context),
    warn: (message, context) => write("warn", message, context),
    error: (message, error, context = {}) =>
      write("error", message, { ...context, error: serializeError(error) }),
  };
}

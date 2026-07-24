const REDACTED = "[REDACTED]";
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
    message: error?.message || String(error),
    stack: error?.stack,
  };
}

export function createLogger(output = console) {
  const write = (level, message, context = {}) => {
    output[level === "error" ? "error" : "log"](
      JSON.stringify(
        redact({
          timestamp: new Date().toISOString(),
          level,
          message,
          ...context,
        }),
      ),
    );
  };

  return {
    info: (message, context) => write("info", message, context),
    warn: (message, context) => write("warn", message, context),
    error: (message, error, context = {}) =>
      write("error", message, { ...context, error: serializeError(error) }),
  };
}

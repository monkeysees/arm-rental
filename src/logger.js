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
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        message,
        ...context,
      }),
    );
  };

  return {
    info: (message, context) => write("info", message, context),
    warn: (message, context) => write("warn", message, context),
    error: (message, error, context = {}) =>
      write("error", message, { ...context, error: serializeError(error) }),
  };
}

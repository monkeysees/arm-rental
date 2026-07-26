import { readConfigurationEnvironment } from "./config-catalog.js";

const RUNTIME_MODES = new Set(["development", "test", "production"]);

export function getEnvironmentName(env = process.env) {
  const value = readConfigurationEnvironment(env, "NODE_ENV").trim();
  if (!RUNTIME_MODES.has(value)) {
    throw new Error(
      `NODE_ENV must be one of: ${[...RUNTIME_MODES].join(", ")}`,
    );
  }
  return value;
}

export function getHealthEndpointConfig(env = process.env) {
  const host = readConfigurationEnvironment(env, "HEALTH_HOST").trim();
  if (!["127.0.0.1", "::1"].includes(host)) {
    throw new Error(
      "HEALTH_HOST must be a loopback address (127.0.0.1 or ::1)",
    );
  }

  const rawPort = readConfigurationEnvironment(env, "HEALTH_PORT");
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("HEALTH_PORT must be an integer from 1 through 65535");
  }
  return { host, port };
}

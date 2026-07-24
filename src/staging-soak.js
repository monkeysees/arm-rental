import path from "node:path";

import { getConfig, validateStartupConfig } from "./config.js";
import { validateStagingGuard } from "./staging-guard.js";

export const MINIMUM_SOAK_DURATION_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_SOAK_SAMPLE_INTERVAL_MS = 5 * 60 * 1_000;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 45_000;
const READINESS_TIMEOUT_MS = 5 * 60 * 1_000;

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function soakSettings(env, config) {
  const durationMs = positiveInteger(
    env.STAGING_SOAK_DURATION_MS,
    MINIMUM_SOAK_DURATION_MS,
    "STAGING_SOAK_DURATION_MS",
  );
  if (durationMs < MINIMUM_SOAK_DURATION_MS) {
    throw new Error("STAGING_SOAK_DURATION_MS must be at least 86400000 (24h)");
  }
  const sampleIntervalMs = positiveInteger(
    env.STAGING_SOAK_SAMPLE_INTERVAL_MS,
    DEFAULT_SOAK_SAMPLE_INTERVAL_MS,
    "STAGING_SOAK_SAMPLE_INTERVAL_MS",
  );
  if (sampleIntervalMs > durationMs) {
    throw new Error(
      "STAGING_SOAK_SAMPLE_INTERVAL_MS must not exceed the soak duration",
    );
  }

  const workDirectory = path.join(config.dataDirectory, ".staging-soak");
  return {
    durationMs,
    sampleIntervalMs,
    readinessTimeoutMs: READINESS_TIMEOUT_MS,
    gracefulShutdownTimeoutMs: GRACEFUL_SHUTDOWN_TIMEOUT_MS,
    profileDirectory: config.browserProfileDir,
    logFilename: path.join(workDirectory, "service.log"),
    resultFilename: path.join(workDirectory, "result.json"),
    healthUrl: `http://${config.healthHost}:${config.healthPort}/ready`,
    thresholds: {
      memoryGrowthBytes: positiveInteger(
        env.STAGING_SOAK_MAX_MEMORY_GROWTH_BYTES,
        256 * 1024 * 1024,
        "STAGING_SOAK_MAX_MEMORY_GROWTH_BYTES",
      ),
      chromeProcessCount: positiveInteger(
        env.STAGING_SOAK_MAX_CHROME_PROCESSES,
        16,
        "STAGING_SOAK_MAX_CHROME_PROCESSES",
      ),
      profileGrowthBytes: positiveInteger(
        env.STAGING_SOAK_MAX_PROFILE_GROWTH_BYTES,
        512 * 1024 * 1024,
        "STAGING_SOAK_MAX_PROFILE_GROWTH_BYTES",
      ),
      cacheGrowthBytes: positiveInteger(
        env.STAGING_SOAK_MAX_CACHE_GROWTH_BYTES,
        config.browserCacheMaxBytes + 16 * 1024 * 1024,
        "STAGING_SOAK_MAX_CACHE_GROWTH_BYTES",
      ),
      logGrowthBytes: positiveInteger(
        env.STAGING_SOAK_MAX_LOG_GROWTH_BYTES,
        1024 * 1024 * 1024,
        "STAGING_SOAK_MAX_LOG_GROWTH_BYTES",
      ),
    },
  };
}

function growth(samples, field) {
  if (samples.length === 0) return null;
  return Math.max(
    ...samples.map((sample) => sample[field] - samples[0][field]),
  );
}

function evaluate(samples, thresholds) {
  if (samples.length === 0) return ["no_resource_samples"];
  const violations = [];
  const metrics = [
    ["rssBytes", "memory_growth", thresholds.memoryGrowthBytes],
    ["profileBytes", "profile_growth", thresholds.profileGrowthBytes],
    ["cacheBytes", "cache_growth", thresholds.cacheGrowthBytes],
    ["logBytes", "log_growth", thresholds.logGrowthBytes],
  ];
  for (const [field, name, threshold] of metrics) {
    if (growth(samples, field) > threshold) violations.push(name);
  }
  if (
    Math.max(...samples.map(({ chromeProcessCount }) => chromeProcessCount)) >
    thresholds.chromeProcessCount
  ) {
    violations.push("chrome_process_count");
  }
  return violations;
}

/**
 * Monitors a staging service for the requested duration and always asks it to
 * stop with SIGTERM. Tests inject the lifecycle and sampler; the CLI validates
 * the hard 24-hour minimum before this function is reached.
 */
export async function runSoakMonitor(
  settings,
  { launch, ready, sample, sleep, now = () => new Date() },
) {
  const startedAt = now();
  const samples = [];
  const violations = [];
  let service;
  let operationalError;
  let shutdown;

  try {
    service = await launch();
    await ready(service, settings);
    const endTime = startedAt.getTime() + settings.durationMs;
    while (true) {
      const sampledAt = now();
      samples.push({
        sampledAt: sampledAt.toISOString(),
        elapsedMs: Math.max(0, sampledAt.getTime() - startedAt.getTime()),
        ...(await sample(service.pid, settings)),
      });
      if (sampledAt.getTime() >= endTime) break;
      if (!service.isRunning()) {
        violations.push("service_exited");
        break;
      }
      await sleep(
        Math.min(settings.sampleIntervalMs, endTime - sampledAt.getTime()),
      );
    }
  } catch (error) {
    operationalError = error;
    violations.push("monitor_error");
  } finally {
    if (service) {
      try {
        shutdown = await service.terminate(settings.gracefulShutdownTimeoutMs);
      } catch (error) {
        operationalError ??= error;
        violations.push("shutdown_error");
      }
    }
  }

  violations.push(...evaluate(samples, settings.thresholds));
  if (
    !shutdown ||
    shutdown.forced ||
    shutdown.code !== 0 ||
    shutdown.signal !== null
  ) {
    violations.push("graceful_shutdown");
  }
  const uniqueViolations = [...new Set(violations)];
  return {
    type: "rental-apartments-staging-soak-result",
    version: 1,
    status: uniqueViolations.length === 0 ? "passed" : "failed",
    startedAt: startedAt.toISOString(),
    completedAt: now().toISOString(),
    durationMs: settings.durationMs,
    sampleIntervalMs: settings.sampleIntervalMs,
    thresholds: settings.thresholds,
    summary: {
      sampleCount: samples.length,
      maximumMemoryGrowthBytes: growth(samples, "rssBytes"),
      maximumChromeProcessCount:
        samples.length === 0
          ? null
          : Math.max(
              ...samples.map(({ chromeProcessCount }) => chromeProcessCount),
            ),
      maximumProfileGrowthBytes: growth(samples, "profileBytes"),
      maximumCacheGrowthBytes: growth(samples, "cacheBytes"),
      maximumLogGrowthBytes: growth(samples, "logBytes"),
      gracefulShutdown:
        shutdown?.forced === false &&
        shutdown.code === 0 &&
        shutdown.signal === null,
    },
    violations: uniqueViolations,
    ...(operationalError
      ? {
          error: {
            code: operationalError.code || "ERR_STAGING_SOAK",
            message: operationalError.message,
          },
        }
      : {}),
    samples,
  };
}

export async function runStagingSoak(
  env = process.env,
  {
    guard = validateStagingGuard,
    configFactory = getConfig,
    validateConfig = validateStartupConfig,
    launch,
    ready,
    sample,
    sleep,
    now = () => new Date(),
  } = {},
) {
  const identity = await guard(env);
  const config = configFactory(env);
  if (path.resolve(config.dataDirectory) !== identity.dataDirectory) {
    throw new Error("Staging guard and runtime resolved different data paths");
  }
  await validateConfig(config);
  const settings = soakSettings(env, config);
  return {
    report: await runSoakMonitor(settings, {
      launch: () => launch(config, env, settings),
      ready,
      sample,
      sleep,
      now,
    }),
    resultFilename: settings.resultFilename,
  };
}

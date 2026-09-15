import { runApplication } from "./application.js";
import { runTelegramBot } from "./bot.js";
import { ListAmHttpFetcher } from "./list-am-http.js";
import { getConfig } from "./config.js";
import { ExchangeRateService } from "./exchange-rates.js";
import { HealthMonitor, startHealthServer } from "./health.js";
import { createLogger } from "./logger.js";
import packageMetadata from "../package.json" with { type: "json" };

const logger = createLogger();
const healthMonitor = new HealthMonitor({
  version: packageMetadata.version,
  onAlert: (alert) =>
    alert.status === "firing"
      ? logger.warn("Production alert firing", {
          event: "alert.firing",
          alertName: alert.name,
          ...alert,
        })
      : logger.info("Production alert resolved", {
          event: "alert.resolved",
          alertName: alert.name,
          ...alert,
        }),
});
let healthServer;

try {
  logger.info("Application process started", {
    event: "application.started",
    processId: process.pid,
  });
  const config = getConfig();
  healthMonitor.setConfigurationValid();
  healthServer = await startHealthServer(healthMonitor, {
    host: config.healthHost,
    port: config.healthPort,
  });
  logger.info("Private health endpoint started", {
    host: config.healthHost,
    port: config.healthPort,
  });
  await runApplication({
    config,
    logger,
    healthMonitor,
    sourceFetcherFactory: (config, options) =>
      new ListAmHttpFetcher(config, options),
    exchangeRateServiceFactory: (config, options) =>
      new ExchangeRateService(config, options),
    runBot: runTelegramBot,
  });
} catch (error) {
  if (!healthServer) {
    healthMonitor.setConfigurationFailure(error.code);
  }
  logger.error("Application failed", error);
  process.exitCode = 1;
} finally {
  await healthServer?.close();
}

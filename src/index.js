import { runApplication } from "./application.js";
import { runTelegramBot } from "./bot.js";
import { BrowserPageFetcher } from "./browser-fetch.js";
import { getConfig } from "./config.js";
import { ExchangeRateService } from "./exchange-rates.js";
import { createLogger } from "./logger.js";

const logger = createLogger();

try {
  await runApplication({
    config: getConfig(),
    logger,
    browserFetcherFactory: (config, options) =>
      new BrowserPageFetcher(config, options),
    exchangeRateServiceFactory: (config, options) =>
      new ExchangeRateService(config, options),
    runBot: runTelegramBot,
  });
} catch (error) {
  logger.error("Application failed", error);
  process.exitCode = 1;
}

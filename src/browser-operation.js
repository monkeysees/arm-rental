import { acquireSingletonLock } from "./singleton-lock.js";
import { BrowserPageFetcher } from "./browser-fetch.js";
import { validateStartupConfig } from "./config.js";
import { extractRegularApartments } from "./list-am.js";
import { pageUrl } from "./target.js";

export async function runBrowserOperation(
  config,
  {
    interactive = false,
    requireProduction = false,
    logger,
    signal,
    acquireLock = acquireSingletonLock,
    validateConfig = validateStartupConfig,
    browserFetcherFactory = (browserConfig, options) =>
      new BrowserPageFetcher(browserConfig, options),
  } = {},
) {
  await validateConfig(config);
  if (
    requireProduction &&
    (config.environmentName !== "production" || !config.browserHeadless)
  ) {
    throw new Error(
      "The production browser smoke test requires NODE_ENV=production and BROWSER_HEADLESS=true.",
    );
  }

  const singletonLock = await acquireLock(config.dataDirectory);
  let browserFetcher;
  try {
    const browserConfig = {
      ...config,
      ...(interactive
        ? { browserHeadless: false, browserStartMinimized: false }
        : {}),
    };
    browserFetcher = browserFetcherFactory(browserConfig, {
      signal,
      onStatus: (message) => logger?.info(message),
      onEvent: (event) =>
        logger?.warn("Browser challenge detected", {
          eventName: event.name,
          component: event.component,
          code: event.code,
          remediationCommand: event.remediationCommand,
        }),
    });
    const targetUrl = pageUrl(1, config.listUrlTemplate);
    const response = await browserFetcher.fetch(targetUrl);
    if (!response?.ok) {
      throw new Error(`List.am returned HTTP ${response?.status || "unknown"}`);
    }
    const apartments = extractRegularApartments(await response.text());
    return {
      targetUrl,
      regularAdsCount: apartments.length,
      profileDirectory: config.browserProfileDir,
    };
  } finally {
    try {
      await browserFetcher?.close();
    } finally {
      await singletonLock.release();
    }
  }
}

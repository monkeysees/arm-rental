import { acquireSingletonLock } from "./singleton-lock.js";
import {
  BROWSER_CHALLENGE_EVENT,
  BrowserPageFetcher,
} from "./browser-fetch.js";
import { validateStartupConfig } from "./config.js";
import { APARTMENT } from "./property-kind.js";
import { pageUrl } from "./target.js";
import { recordBrowserVerification } from "./browser-verification-state.js";
import { parseAndEvaluateRegularApartments } from "./source-integrity.js";

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
    recordVerification = recordBrowserVerification,
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
      // The interactive verifier exists so a person can see and complete a
      // List.am challenge, which the crawl's suppressed image loading would
      // leave blank. Only this operation needs the pixels.
      ...(interactive
        ? {
            browserHeadless: false,
            browserLoadImages: true,
            browserStartMinimized: false,
          }
        : {}),
    };
    browserFetcher = browserFetcherFactory(browserConfig, {
      signal,
      onStatus: (message) => logger?.info(message),
      // The fetcher reports more than challenges now, so the message has to
      // follow the event rather than assume it.
      onEvent: (event) =>
        event.name === BROWSER_CHALLENGE_EVENT
          ? logger?.warn("Browser challenge detected", {
              eventName: event.name,
              component: event.component,
              code: event.code,
              remediationCommand: event.remediationCommand,
              ...(event.url === undefined ? {} : { url: event.url }),
              ...(event.httpStatus === undefined
                ? {}
                : { httpStatus: event.httpStatus }),
              ...(event.challengeSource === undefined
                ? {}
                : { challengeSource: event.challengeSource }),
            })
          : logger?.warn("Chrome did not exit on request", {
              eventName: event.name,
              component: event.component,
              code: event.code,
              gracefulTimeoutMs: event.gracefulTimeoutMs,
            }),
    });
    const targetUrl = pageUrl(1, config.listUrlTemplate);
    const fetchCount = requireProduction ? config.initialPageCount : 1;
    let regularAdsCount;
    for (let attempt = 0; attempt < fetchCount; attempt += 1) {
      const response = await browserFetcher.fetch(
        pageUrl(attempt + 1, config.listUrlTemplate),
      );
      if (!response?.ok) {
        throw new Error(
          `List.am returned HTTP ${response?.status || "unknown"}`,
        );
      }
      const diagnostics = parseAndEvaluateRegularApartments(
        await response.text(),
        { page: attempt + 1, kind: APARTMENT },
      );
      regularAdsCount ??= diagnostics.parsedCount;
    }
    await recordVerification(config, regularAdsCount);
    return {
      targetUrl,
      regularAdsCount,
      sequentialFetchCount: fetchCount,
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

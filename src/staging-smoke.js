import path from "node:path";

import {
  browserVerificationStateFile,
  compatibleBrowserVerification,
  recordBrowserVerification,
} from "./browser-verification-state.js";
import { BrowserPageFetcher } from "./browser-fetch.js";
import { getConfig, validateStartupConfig } from "./config.js";
import {
  compatibleExchangeRateSnapshot,
  ExchangeRateService,
} from "./exchange-rates.js";
import { extractRegularApartments } from "./list-am.js";
import { acquireSingletonLock } from "./singleton-lock.js";
import { readState, writeState } from "./state.js";
import { validateStagingGuard } from "./staging-guard.js";
import { pageUrl } from "./target.js";
import { TelegramApi } from "./telegram.js";

export const STAGING_SMOKE_STATE_FILENAME = ".staging-smoke.json";
const STAGING_SMOKE_STATE_TYPE = "rental-apartments-staging-smoke";

function assertPrivateChannel(channel, expectedChannelId) {
  if (
    channel?.type !== "channel" ||
    channel.id !== expectedChannelId ||
    typeof channel.username === "string"
  ) {
    throw new Error(
      "The staging Telegram target must be the expected private channel with no public username",
    );
  }
}

function assertChannelPermissions(membership) {
  const ownsChannel = membership?.status === "creator";
  const canPublish =
    membership?.status === "administrator" &&
    membership.can_post_messages === true &&
    membership.can_edit_messages === true;
  if (!ownsChannel && !canPublish) {
    throw new Error(
      "The staging bot needs Post Messages and Edit Messages permissions in the private channel",
    );
  }
}

async function closePass(browser, lease) {
  let closeError;
  try {
    await browser?.close();
  } catch (error) {
    closeError = error;
  }
  try {
    await lease?.release();
  } catch (error) {
    closeError ??= error;
  }
  if (closeError) throw closeError;
}

async function runPass(
  config,
  identity,
  phase,
  {
    acquireLock,
    apiFactory,
    browserFactory,
    exchangeRateServiceFactory,
    loadState,
    saveState,
    recordVerification,
    now,
  },
) {
  let lease;
  let browser;
  let result;
  let operationError;
  try {
    lease = await acquireLock(config.dataDirectory);
    const api = apiFactory(config);
    const bot = await api.getMe();
    if (bot?.id !== identity.botId || bot.is_bot !== true) {
      throw new Error(
        "Telegram authentication did not return the dedicated staging bot",
      );
    }

    const channel = await api.getChat(identity.channelId);
    assertPrivateChannel(channel, identity.channelId);
    assertChannelPermissions(
      await api.getChatMember(identity.channelId, identity.botId),
    );

    browser = browserFactory(config);
    const response = await browser.fetch(pageUrl(1, config.listUrlTemplate));
    if (!response?.ok) {
      throw new Error(
        `List.am staging smoke returned HTTP ${response?.status || "unknown"}`,
      );
    }
    const apartments = extractRegularApartments(await response.text());
    if (apartments.length === 0) {
      throw new Error("List.am staging smoke parsed no Regular Ads");
    }
    await recordVerification(config, apartments.length);

    const exchangeRates = exchangeRateServiceFactory(config, {
      forceRefresh: phase === "initial",
    });
    const snapshot = await exchangeRates.getSnapshot();
    if (!compatibleExchangeRateSnapshot(snapshot)) {
      throw new Error("CBA staging smoke did not produce compatible AMD rates");
    }

    const stateFilename = path.join(
      config.dataDirectory,
      STAGING_SMOKE_STATE_FILENAME,
    );
    if (phase === "initial") {
      await saveState(stateFilename, {
        type: STAGING_SMOKE_STATE_TYPE,
        version: 1,
        completedAt: now().toISOString(),
        botId: identity.botId,
        channelId: identity.channelId,
        regularAdsCount: apartments.length,
        ratesFetchedAt: snapshot.fetchedAt,
      });
    } else {
      const persisted = await loadState(stateFilename);
      const verification = await loadState(
        browserVerificationStateFile(config),
      );
      if (
        persisted?.type !== STAGING_SMOKE_STATE_TYPE ||
        persisted.version !== 1 ||
        persisted.botId !== identity.botId ||
        persisted.channelId !== identity.channelId ||
        !Number.isSafeInteger(persisted.regularAdsCount) ||
        persisted.regularAdsCount <= 0 ||
        persisted.ratesFetchedAt !== snapshot.fetchedAt ||
        !compatibleBrowserVerification(verification, config.listUrlTemplate)
      ) {
        throw new Error(
          "Staging smoke state did not survive the resource restart",
        );
      }
    }

    result = {
      phase,
      telegramAuthentication: "passed",
      privateChannelPermissions: "passed",
      cbaRetrieval: phase === "initial" ? "retrieved" : "loaded_after_restart",
      listAmRegularAds: apartments.length,
      persistence: phase === "initial" ? "written" : "verified_after_restart",
    };
  } catch (error) {
    operationError = error;
  }

  try {
    await closePass(browser, lease);
  } catch (error) {
    operationError ??= error;
  }
  if (operationError) throw operationError;
  return { ...result, gracefulShutdown: "passed" };
}

/**
 * Runs two complete, separately leased staging passes. The second pass
 * reconstructs every client and proves that smoke, rate, and browser evidence
 * written by the first pass survived the restart boundary.
 */
export async function runStagingSmoke(
  env = process.env,
  {
    guard = validateStagingGuard,
    configFactory = getConfig,
    validateConfig = validateStartupConfig,
    acquireLock = acquireSingletonLock,
    apiFactory = (config) =>
      new TelegramApi(config.telegramBotToken, {
        timeoutMs: config.timeoutMs,
        retryBaseMs: config.externalRetryBaseMs,
        retryMaxMs: config.externalRetryMaxMs,
      }),
    browserFactory = (config) => new BrowserPageFetcher(config),
    exchangeRateServiceFactory = (config, { forceRefresh }) =>
      new ExchangeRateService(config, {
        ...(forceRefresh ? { loadState: async () => undefined } : {}),
      }),
    loadState = readState,
    saveState = writeState,
    recordVerification = recordBrowserVerification,
    now = () => new Date(),
  } = {},
) {
  const identity = await guard(env);
  const config = configFactory(env);
  if (path.resolve(config.dataDirectory) !== identity.dataDirectory) {
    throw new Error("Staging guard and runtime resolved different data paths");
  }
  await validateConfig(config);

  const dependencies = {
    acquireLock,
    apiFactory,
    browserFactory,
    exchangeRateServiceFactory,
    loadState,
    saveState,
    recordVerification,
    now,
  };
  const startedAt = now().toISOString();
  const initial = await runPass(config, identity, "initial", dependencies);
  const restarted = await runPass(config, identity, "restarted", dependencies);

  return {
    type: "rental-apartments-staging-smoke-result",
    version: 1,
    status: "passed",
    startedAt,
    completedAt: now().toISOString(),
    checks: {
      dedicatedEnvironment: "passed",
      telegramAuthentication: "passed",
      privateChannelPermissions: "passed",
      cbaRetrieval: "passed",
      realListAmParse: "passed",
      persistenceAcrossRestart: "passed",
      gracefulShutdown: "passed",
    },
    passes: [initial, restarted],
  };
}

import path from "node:path";

import { compatibleApartmentState } from "./apartment-state.js";
import {
  BROWSER_VERIFICATION_COMMAND,
  BrowserVerificationRequiredError,
} from "./browser-fetch.js";
import { compatibleBotState } from "./bot.js";
import { compatibleChannelState } from "./channel.js";
import { compatibleDeliveryState } from "./crawler.js";
import { compatibleExchangeRateSnapshot } from "./exchange-rates.js";
import { pageUrl } from "./target.js";
import { TelegramApi, TelegramApiError } from "./telegram.js";
import { recordBrowserVerification } from "./browser-verification-state.js";
import {
  LIST_AM_SOURCE_INTEGRITY_ERROR,
  parseAndEvaluateRegularApartments,
  sourceIntegrityPageSummary,
} from "./source-integrity.js";

const CHECK_NAMES = [
  "storage",
  "state",
  "singleton",
  "telegram",
  "channel",
  "browser",
  "list_am",
  "exchange_rates",
];

export class PreflightError extends Error {
  constructor(
    component,
    message,
    {
      cause,
      code = "ERR_PREFLIGHT",
      terminal = false,
      status = "failed",
      details,
      remediationCommand,
    } = {},
  ) {
    super(message, { cause });
    this.name = "PreflightError";
    this.code = code;
    this.component = component;
    this.terminal = terminal;
    this.status = status;
    this.details = details;
    this.remediationCommand = remediationCommand;
  }
}

export class StateCompatibilityError extends PreflightError {
  constructor(domain, reason, cause) {
    super(
      "state",
      `Stored ${domain} state cannot be used by this release: ${reason}. Stored state was left unchanged.`,
      {
        cause,
        code: "ERR_STATE_INCOMPATIBLE",
        terminal: true,
        details: { domain, reason },
      },
    );
    this.name = "StateCompatibilityError";
    this.domain = domain;
  }
}

/**
 * What preflight must be able to read before the process serves anything. The
 * repositories decode and validate rows on load, so reading each domain once
 * is what proves the stored rows are usable; the predicates then re-assert the
 * domain invariants the running code relies on against what was rebuilt.
 */
function stateDomains(config, stateAccess) {
  return [
    {
      domain: "apartments",
      store: stateAccess.apartments,
      compatible: (state) =>
        compatibleApartmentState(state, config.listUrlTemplate),
    },
    {
      domain: "private delivery",
      store: stateAccess.privateDeliveries,
      compatible: (state) =>
        compatibleDeliveryState(state, config.listUrlTemplate),
    },
    // Channel storage exists only while a channel is configured, so a missing
    // store is a configuration mismatch rather than an empty domain.
    ...(config.telegramChannelId
      ? [
          {
            domain: "channel delivery",
            store: stateAccess.channelDeliveries,
            compatible: (state) => compatibleChannelState(state, config),
          },
        ]
      : []),
    {
      domain: "exchange rate",
      store: stateAccess.exchangeRates,
      compatible: compatibleExchangeRateSnapshot,
    },
    {
      domain: "Telegram bot",
      store: stateAccess.telegram,
      compatible: compatibleBotState,
    },
  ];
}

/**
 * Refuses to start on stored state the running code cannot safely use. Reading
 * every domain up front moves that decision ahead of the first delivery, which
 * is where a lazily decoded bad row would otherwise surface. The apartment
 * state is returned so the List.am check can reuse the source-integrity
 * baseline it carries instead of reading those rows twice.
 */
async function validateExistingState(config, stateAccess) {
  if (!stateAccess) {
    throw new PreflightError(
      "state",
      "Startup preflight requires the opened state backend.",
      { code: "ERR_PREFLIGHT_STATE", terminal: true },
    );
  }
  let apartmentState;
  for (const { domain, store, compatible } of stateDomains(
    config,
    stateAccess,
  )) {
    if (!store) {
      throw new StateCompatibilityError(domain, "storage is not configured");
    }
    let state;
    try {
      state = await store.load();
    } catch (error) {
      throw new StateCompatibilityError(
        domain,
        "stored rows could not be read",
        error,
      );
    }
    // An untouched domain has no rows yet; only stored content can be wrong.
    if (state === undefined) continue;
    if (!compatible(state)) {
      throw new StateCompatibilityError(domain, "rebuilt state is malformed");
    }
    if (domain === "apartments") apartmentState = state;
  }
  return apartmentState;
}

function telegramClientError(error) {
  const status = error?.telegramErrorCode || error?.httpStatus;
  return (
    error instanceof TelegramApiError &&
    Number.isSafeInteger(status) &&
    status >= 400 &&
    status < 500
  );
}

class ChannelConfigurationError extends Error {}

async function validateTelegram(config, api, signal) {
  let bot;
  try {
    bot = await api.getMe(signal);
  } catch (error) {
    const terminal = telegramClientError(error);
    throw new PreflightError(
      "telegram",
      terminal
        ? "Telegram rejected the configured bot credentials."
        : "Telegram credential validation could not be completed.",
      {
        cause: error,
        code: terminal
          ? "ERR_TELEGRAM_CREDENTIALS"
          : "ERR_TELEGRAM_UNAVAILABLE",
        terminal,
      },
    );
  }
  if (!Number.isSafeInteger(bot?.id) || bot.id <= 0 || bot.is_bot !== true) {
    throw new PreflightError(
      "telegram",
      "Telegram getMe returned an invalid bot identity.",
      {
        code: "ERR_TELEGRAM_CREDENTIALS",
        terminal: true,
      },
    );
  }
  return bot;
}

async function validateChannel(config, api, bot, signal) {
  if (!config.telegramChannelId) return "skipped";

  try {
    const channel = await api.getChat(config.telegramChannelId, signal);
    if (
      channel?.type !== "channel" ||
      channel.username?.toLocaleLowerCase("en-US") !==
        config.telegramChannelId.slice(1).toLocaleLowerCase("en-US")
    ) {
      throw new ChannelConfigurationError(
        "The configured target is not the expected public channel",
      );
    }

    const membership = await api.getChatMember(
      config.telegramChannelId,
      bot.id,
      signal,
    );
    const ownsChannel = membership?.status === "creator";
    const hasPermissions =
      membership?.status === "administrator" &&
      membership.can_post_messages === true &&
      membership.can_edit_messages === true;
    if (!ownsChannel && !hasPermissions) {
      throw new ChannelConfigurationError(
        "The bot must be a channel administrator with Post Messages and Edit Messages permissions",
      );
    }
  } catch (error) {
    const terminal =
      error instanceof ChannelConfigurationError || telegramClientError(error);
    throw new PreflightError(
      "channel",
      "The configured Telegram channel is unreachable or lacks required posting and editing permissions.",
      {
        cause: error,
        code: "ERR_TELEGRAM_CHANNEL_PERMISSIONS",
        terminal,
      },
    );
  }
  return "passed";
}

function emptyResult() {
  return {
    status: "running",
    ready: false,
    terminal: false,
    checks: Object.fromEntries(CHECK_NAMES.map((name) => [name, "not_run"])),
  };
}

function failureResult(result, error) {
  const status =
    error.status === "browser_verification_required" ? error.status : "failed";
  return {
    ...result,
    status,
    ready: false,
    terminal: Boolean(error.terminal),
    checks: {
      ...result.checks,
      [error.component || "storage"]: status,
    },
    failure: {
      component: error.component || "storage",
      code: error.code || "ERR_PREFLIGHT",
      ...(error.details || {}),
    },
    ...(error.remediationCommand
      ? { remediationCommand: error.remediationCommand }
      : {}),
  };
}

export function startupFailureResult(component, error) {
  const normalized =
    error instanceof PreflightError
      ? error
      : new PreflightError(component, `Startup ${component} check failed.`, {
          cause: error,
          code:
            component === "singleton" && error?.code
              ? error.code
              : `ERR_PREFLIGHT_${component.toUpperCase()}`,
          terminal: component === "storage" || component === "singleton",
        });
  return failureResult(emptyResult(), normalized);
}

export async function runStartupPreflight(
  config,
  {
    storageValidated = false,
    singletonLock,
    browserFetcher,
    exchangeRateService,
    api,
    stateAccess,
    recordVerification = recordBrowserVerification,
    onSourceIntegrityChecked = () => {},
    onRetry = () => {},
    signal,
  } = {},
) {
  const result = emptyResult();
  api ??= new TelegramApi(config.telegramBotToken, {
    timeoutMs: config.timeoutMs,
    retryBaseMs: config.externalRetryBaseMs,
    retryMaxMs: config.externalRetryMaxMs,
    onRetry,
  });

  try {
    if (!storageValidated) {
      throw new PreflightError(
        "storage",
        "Persistent storage was not validated before preflight.",
        { code: "ERR_PREFLIGHT_STORAGE", terminal: true },
      );
    }
    result.checks.storage = "passed";

    const apartmentState = await validateExistingState(config, stateAccess);
    result.checks.state = "passed";

    if (
      !singletonLock?.owner?.id ||
      typeof singletonLock.release !== "function" ||
      path.resolve(singletonLock.dataDirectory) !==
        path.resolve(config.dataDirectory)
    ) {
      throw new PreflightError(
        "singleton",
        "The singleton lease is not held for the configured data directory.",
        { code: "ERR_PREFLIGHT_SINGLETON", terminal: true },
      );
    }
    result.checks.singleton = "passed";

    const bot = await validateTelegram(config, api, signal);
    result.checks.telegram = "passed";
    result.checks.channel = await validateChannel(config, api, bot, signal);

    try {
      await browserFetcher.start();
    } catch (error) {
      throw new PreflightError(
        "browser",
        "Chrome could not start with the persistent profile.",
        { cause: error, code: "ERR_PREFLIGHT_BROWSER" },
      );
    }
    result.checks.browser = "passed";

    try {
      const response = await browserFetcher.fetch(
        pageUrl(1, config.listUrlTemplate),
      );
      if (!response?.ok) {
        throw new Error(
          `List.am returned HTTP ${response?.status || "unknown"}`,
        );
      }
      const diagnostics = parseAndEvaluateRegularApartments(
        await response.text(),
        {
          page: 1,
          priorFirstPageCounts:
            apartmentState?.sourceIntegrity.recentFirstPageCounts,
        },
      );
      await onSourceIntegrityChecked({
        pages: [sourceIntegrityPageSummary(diagnostics, 1)],
      });
      await recordVerification(config, diagnostics.parsedCount);
    } catch (error) {
      if (
        error instanceof BrowserVerificationRequiredError ||
        error?.code === "ERR_BROWSER_VERIFICATION_REQUIRED"
      ) {
        throw new PreflightError(
          "list_am",
          "List.am browser verification is required.",
          {
            cause: error,
            code: "ERR_BROWSER_VERIFICATION_REQUIRED",
            status: "browser_verification_required",
            remediationCommand:
              error.remediationCommand || BROWSER_VERIFICATION_COMMAND,
          },
        );
      }
      if (error?.code === LIST_AM_SOURCE_INTEGRITY_ERROR) {
        throw new PreflightError(
          "list_am",
          "The configured List.am target failed source-integrity checks.",
          {
            cause: error,
            code: error.code,
            details: error.details,
          },
        );
      }
      throw new PreflightError(
        "list_am",
        "The configured List.am target could not be loaded and parsed.",
        { cause: error, code: "ERR_PREFLIGHT_LIST_AM" },
      );
    }
    result.checks.list_am = "passed";

    let snapshot;
    try {
      snapshot = await exchangeRateService.getSnapshot(signal);
    } catch (error) {
      throw new PreflightError(
        "exchange_rates",
        "No usable persisted exchange rates exist and CBA retrieval failed.",
        { cause: error, code: "ERR_PREFLIGHT_EXCHANGE_RATES" },
      );
    }
    if (!compatibleExchangeRateSnapshot(snapshot)) {
      throw new PreflightError(
        "exchange_rates",
        "Exchange-rate preflight did not produce a usable snapshot.",
        { code: "ERR_PREFLIGHT_EXCHANGE_RATES" },
      );
    }
    result.checks.exchange_rates = "passed";

    return {
      ...result,
      status: "ready",
      ready: true,
    };
  } catch (error) {
    const normalized =
      error instanceof PreflightError
        ? error
        : new PreflightError(
            "storage",
            "Startup preflight failed unexpectedly.",
            { cause: error },
          );
    normalized.preflightResult = failureResult(result, normalized);
    throw normalized;
  }
}

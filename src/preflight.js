import path from "node:path";

import {
  BROWSER_VERIFICATION_COMMAND,
  BrowserVerificationRequiredError,
} from "./browser-fetch.js";
import { compatibleBotState } from "./bot.js";
import { compatibleChannelState } from "./channel.js";
import {
  compatibleApartmentState,
  compatibleDeliveryState,
} from "./crawler.js";
import { compatibleExchangeRateSnapshot } from "./exchange-rates.js";
import { extractRegularApartments } from "./list-am.js";
import { readState } from "./state.js";
import { pageUrl } from "./target.js";
import { TelegramApi, TelegramApiError } from "./telegram.js";
import { recordBrowserVerification } from "./browser-verification-state.js";

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
  constructor(filename, observedSchema, reason, cause) {
    const schema = `${observedSchema.type}@${observedSchema.version}`;
    super(
      "state",
      `State file ${filename} has incompatible schema ${schema}: ${reason}. The file was left unchanged.`,
      {
        cause,
        code: "ERR_STATE_INCOMPATIBLE",
        terminal: true,
        details: {
          filename,
          observedSchema,
          reason,
        },
      },
    );
    this.name = "StateCompatibilityError";
    this.filename = filename;
    this.observedSchema = observedSchema;
  }
}

function observedSchema(state, invalidJson = false) {
  if (invalidJson) return { type: "invalid-json", version: "unknown" };
  return {
    type:
      typeof state?.type === "string" && state.type ? state.type : "unknown",
    version: Number.isSafeInteger(state?.version) ? state.version : "unknown",
  };
}

function stateSpecifications(config) {
  return [
    {
      filename: config.apartmentsStateFile,
      types: new Set(["list-am-apartments"]),
      versions: new Set([1, 2]),
      targetMatches: (state) => state.urlTemplate === config.listUrlTemplate,
      targetName: "List.am URL template",
      compatible: (state) =>
        compatibleApartmentState(state, config.listUrlTemplate),
    },
    {
      filename: config.deliveryStateFile,
      types: new Set(["telegram-deliveries"]),
      versions: new Set([1, 2]),
      targetMatches: (state) => state.urlTemplate === config.listUrlTemplate,
      targetName: "List.am URL template",
      compatible: (state) =>
        compatibleDeliveryState(state, config.listUrlTemplate),
    },
    {
      filename: config.channelDeliveryStateFile,
      types: new Set(["telegram-channel-deliveries"]),
      versions: new Set([1]),
      targetMatches: (state) =>
        state.urlTemplate === config.listUrlTemplate &&
        state.channelId === config.telegramChannelId,
      targetName: "configured List.am target or Telegram channel",
      compatible: (state) => compatibleChannelState(state, config),
    },
    {
      filename: config.exchangeRatesStateFile,
      types: new Set(["cba-exchange-rates"]),
      versions: new Set([1]),
      targetMatches: (state) => state.baseCurrency === "AMD",
      targetName: "AMD base currency",
      compatible: compatibleExchangeRateSnapshot,
    },
    {
      filename: config.telegramStateFile,
      types: new Set(["telegram-bot"]),
      versions: new Set([1, 2]),
      targetMatches: () => true,
      targetName: "Telegram bot update stream",
      compatible: compatibleBotState,
    },
  ];
}

async function validateExistingState(config, loadState) {
  for (const specification of stateSpecifications(config)) {
    let state;
    try {
      state = await loadState(specification.filename);
    } catch (error) {
      throw new StateCompatibilityError(
        specification.filename,
        observedSchema(undefined, true),
        "invalid JSON",
        error,
      );
    }
    if (state === undefined) continue;

    const schema = observedSchema(state);
    if (
      !specification.types.has(state?.type) ||
      !specification.versions.has(state?.version)
    ) {
      throw new StateCompatibilityError(
        specification.filename,
        schema,
        "unsupported type or version",
      );
    }
    if (!specification.targetMatches(state)) {
      throw new StateCompatibilityError(
        specification.filename,
        schema,
        `target mismatch (${specification.targetName})`,
      );
    }
    if (!specification.compatible(state)) {
      throw new StateCompatibilityError(
        specification.filename,
        schema,
        "schema contents are malformed",
      );
    }
  }
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
    loadState = readState,
    recordVerification = recordBrowserVerification,
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

    await validateExistingState(config, loadState);
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
      const apartments = extractRegularApartments(await response.text());
      await recordVerification(config, apartments.length);
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

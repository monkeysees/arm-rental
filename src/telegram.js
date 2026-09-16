import { setTimeout as delay } from "node:timers/promises";

import { originalPrice } from "./prices.js";
import { propertyKindOf, propertyKindTitle } from "./property-kind.js";
import {
  ExponentialBackoff,
  isExpectedExternalFailure,
  retryOperation,
} from "./retry.js";

const TELEGRAM_API_URL = "https://api.telegram.org";

export class TelegramApiError extends Error {
  constructor(
    method,
    description,
    { httpStatus, telegramErrorCode, retryAfterMs } = {},
  ) {
    super(`Telegram ${method} failed: ${description}`);
    this.name = "TelegramApiError";
    this.code = "ERR_TELEGRAM_API";
    this.method = method;
    this.httpStatus = httpStatus;
    this.telegramErrorCode = telegramErrorCode;
    this.retryAfterMs = retryAfterMs;
    this.terminal =
      [400, 401, 403].includes(telegramErrorCode || httpStatus) &&
      /(?:unauthorized|forbidden|chat not found|not enough rights|bot was blocked|need administrator rights)/iu.test(
        description,
      );
  }
}

function requestSignal(signal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

export class TelegramApi {
  constructor(
    token,
    {
      fetchImpl = globalThis.fetch,
      timeoutMs = 30_000,
      retryBaseMs = 1_000,
      retryMaxMs = 60_000,
      sleep = delay,
      onRetry = () => {},
    } = {},
  ) {
    this.baseUrl = `${TELEGRAM_API_URL}/bot${token}`;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.sleep = sleep;
    this.retryBaseMs = retryBaseMs;
    this.retryMaxMs = retryMaxMs;
    this.onRetry = onRetry;
  }

  async call(
    method,
    payload,
    { signal, timeoutMs = this.timeoutMs, maxAttempts = 4 } = {},
  ) {
    return retryOperation(
      async () => {
        const response = await this.fetchImpl(`${this.baseUrl}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: requestSignal(signal, timeoutMs),
        });
        const body = await response.json().catch(() => undefined);

        if (!response.ok || !body?.ok) {
          const description =
            body?.description || `${response.status} ${response.statusText}`;
          throw new TelegramApiError(method, description, {
            httpStatus: response.status,
            telegramErrorCode: body?.error_code,
            retryAfterMs:
              response.status === 429
                ? Math.max(1, body?.parameters?.retry_after || 1) * 1_000
                : undefined,
          });
        }

        return body.result;
      },
      {
        maxAttempts,
        backoff: new ExponentialBackoff({
          baseDelayMs: this.retryBaseMs,
          maxDelayMs: this.retryMaxMs,
        }),
        shouldRetry: (error) =>
          error?.httpStatus === 429 || isExpectedExternalFailure(error),
        // Telegram's server-provided flood-control interval intentionally
        // overrides the generic retry cap and jitter.
        retryDelay: (error) => error?.retryAfterMs,
        sleep: this.sleep,
        signal,
        onRetry: ({ attempt, delayMs, error }) =>
          this.onRetry({
            component: "telegram",
            method,
            attempt,
            delayMs,
            reason:
              error.httpStatus === 429
                ? "telegram_retry_after"
                : "expected_external_failure",
          }),
      },
    );
  }

  getUpdates(offset, timeoutSeconds, signal) {
    return this.call(
      "getUpdates",
      {
        offset,
        timeout: timeoutSeconds,
        allowed_updates: ["message", "callback_query"],
      },
      {
        signal,
        timeoutMs: (timeoutSeconds + 10) * 1_000,
      },
    );
  }

  getMe(signal) {
    return this.call("getMe", {}, { signal });
  }

  getChat(chatId, signal) {
    return this.call("getChat", { chat_id: chatId }, { signal });
  }

  getChatMember(chatId, userId, signal) {
    return this.call(
      "getChatMember",
      { chat_id: chatId, user_id: userId },
      { signal },
    );
  }

  setMyCommands(commands, scope, signal) {
    return this.call("setMyCommands", { commands, scope }, { signal });
  }

  setMyDescription(description, signal) {
    return this.call("setMyDescription", { description }, { signal });
  }

  setMyShortDescription(shortDescription, signal) {
    return this.call(
      "setMyShortDescription",
      { short_description: shortDescription },
      { signal },
    );
  }

  sendMessage(chatId, text, signal, replyMarkup, { maxAttempts = 4 } = {}) {
    return this.call(
      "sendMessage",
      {
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      },
      { signal, maxAttempts },
    );
  }

  editMessageText(chatId, messageId, text, signal, replyMarkup) {
    return this.call(
      "editMessageText",
      {
        chat_id: chatId,
        message_id: messageId,
        text,
        disable_web_page_preview: true,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      },
      { signal },
    ).catch((error) => {
      // Replayed callbacks can request an already-rendered menu after filter
      // state was persisted but before the Telegram update offset was saved.
      if (/message is not modified/iu.test(error.message)) return undefined;
      throw error;
    });
  }

  answerCallbackQuery(callbackQueryId, signal) {
    return this.call(
      "answerCallbackQuery",
      { callback_query_id: callbackQueryId },
      { signal },
    ).catch((error) => {
      // Telegram expires a callback query after roughly a minute; a slow poll
      // cycle or a replayed update can reach the acknowledgement after that.
      // The tap has already timed out client side, so there is nothing left to
      // acknowledge and the rest of the update batch must still be processed.
      if (/query is too old|query id is invalid/iu.test(error.message)) {
        return undefined;
      }
      throw error;
    });
  }
}

export function isStartCommand(text) {
  return /^\/start(?:@[a-z0-9_]+)?(?:\s|$)/iu.test(text || "");
}

export function isMainMenuCommand(text) {
  return /^\/(?:start|menu)(?:@[a-z0-9_]+)?(?:\s|$)/iu.test(text || "");
}

export function isStopCommand(text) {
  return /^\/stop(?:@[a-z0-9_]+)?(?:\s|$)/iu.test(text || "");
}

export function formatApartmentMessage(apartment) {
  const sourcePrice = originalPrice(apartment.price);
  const amount = sourcePrice.amount?.toLocaleString("ru-RU");
  const price =
    amount && sourcePrice.currency
      ? `${amount} ${sourcePrice.currency}`
      : "не указана";

  return [
    apartment.title ||
      `${propertyKindTitle(propertyKindOf(apartment))} ${apartment.itemId}`,
    `Цена: ${price}`,
    `Местоположение: ${apartment.location || "не указано"}`,
    `Количество комнат: ${apartment.rooms ?? "не указано"}`,
    `Площадь: ${apartment.areaSqM == null ? "не указана" : `${apartment.areaSqM} м²`}`,
    `Этаж: ${apartment.floor || "не указан"}`,
    apartment.url,
  ].join("\n");
}

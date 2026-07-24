import { setTimeout as delay } from "node:timers/promises";

import { originalPrice } from "./prices.js";

const TELEGRAM_API_URL = "https://api.telegram.org";

function requestSignal(signal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

export class TelegramApi {
  constructor(
    token,
    { fetchImpl = globalThis.fetch, timeoutMs = 30_000, sleep = delay } = {},
  ) {
    this.baseUrl = `${TELEGRAM_API_URL}/bot${token}`;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.sleep = sleep;
  }

  async call(method, payload, { signal, timeoutMs = this.timeoutMs } = {}) {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const response = await this.fetchImpl(`${this.baseUrl}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: requestSignal(signal, timeoutMs),
      });
      const body = await response.json().catch(() => undefined);

      if (response.status === 429 && attempt < 4) {
        const retryAfter = Math.max(1, body?.parameters?.retry_after || 1);
        await this.sleep(retryAfter * 1_000, undefined, { signal });
        continue;
      }

      if (!response.ok || !body?.ok) {
        const description =
          body?.description || `${response.status} ${response.statusText}`;
        throw new Error(`Telegram ${method} failed: ${description}`);
      }

      return body.result;
    }

    throw new Error(`Telegram ${method} failed after retries`);
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

  sendMessage(chatId, text, signal, replyMarkup) {
    return this.call(
      "sendMessage",
      {
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      },
      { signal },
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
    );
  }
}

export function isStartCommand(text) {
  return /^\/start(?:@[a-z0-9_]+)?(?:\s|$)/iu.test(text || "");
}

export function formatApartmentMessage(apartment) {
  const sourcePrice = originalPrice(apartment.price);
  const amount = sourcePrice.amount?.toLocaleString("ru-RU");
  const price =
    amount && sourcePrice.currency
      ? `${amount} ${sourcePrice.currency}`
      : "не указана";

  return [
    apartment.title || `Квартира ${apartment.itemId}`,
    `Цена: ${price}`,
    `Местоположение: ${apartment.location || "не указано"}`,
    `Количество комнат: ${apartment.rooms ?? "не указано"}`,
    `Площадь: ${apartment.areaSqM == null ? "не указана" : `${apartment.areaSqM} м²`}`,
    `Этаж: ${apartment.floor || "не указан"}`,
    apartment.url,
  ].join("\n");
}

import { setTimeout as delay } from "node:timers/promises";

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
        allowed_updates: ["message"],
      },
      {
        signal,
        timeoutMs: (timeoutSeconds + 10) * 1_000,
      },
    );
  }

  sendMessage(chatId, text, signal) {
    return this.call(
      "sendMessage",
      {
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      },
      { signal },
    );
  }
}

export function isStartCommand(text) {
  return /^\/start(?:@[a-z0-9_]+)?(?:\s|$)/iu.test(text || "");
}

export function formatApartmentMessage(apartment) {
  const amount = apartment.price.amount?.toLocaleString("en-US");
  const price =
    amount && apartment.price.currency
      ? `${amount} ${apartment.price.currency}`
      : "Unavailable";

  return [
    apartment.title || `Apartment ${apartment.itemId}`,
    `Price: ${price}`,
    `Location: ${apartment.location || "Unavailable"}`,
    `Rooms: ${apartment.rooms ?? "Unavailable"}`,
    `Area: ${apartment.areaSqM == null ? "Unavailable" : `${apartment.areaSqM} sq m`}`,
    `Floor: ${apartment.floor || "Unavailable"}`,
    `Date: ${apartment.date || "Unavailable"}`,
    apartment.url,
  ].join("\n");
}

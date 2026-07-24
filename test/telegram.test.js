import assert from "node:assert/strict";
import test from "node:test";

import { processUpdates, runTelegramBot } from "../src/bot.js";
import {
  formatApartmentMessage,
  isStartCommand,
  TelegramApi,
} from "../src/telegram.js";

const config = { telegramOwnerId: 42 };
const initialState = {
  version: 1,
  type: "telegram-bot",
  ownerId: 42,
  active: false,
  chatId: null,
  updateOffset: 0,
};

function update(updateId, fromId, text, type = "private") {
  return {
    update_id: updateId,
    message: {
      from: { id: fromId },
      chat: { id: fromId, type },
      text,
    },
  };
}

test("only a private /start from the configured owner activates the bot", async () => {
  const sent = [];
  const saved = [];
  const state = await processUpdates(
    [
      update(10, 99, "/start"),
      update(11, 42, "/start", "group"),
      update(12, 42, "/start"),
    ],
    config,
    initialState,
    {
      sendMessage: async (...args) => sent.push(args),
      saveState: async (value) => saved.push(value),
    },
  );

  assert.equal(state.active, true);
  assert.equal(state.chatId, 42);
  assert.equal(state.updateOffset, 13);
  assert.deepEqual(sent, [[42, "Apartment monitoring started."]]);
  assert.equal(saved.at(-1).updateOffset, 13);
});

test("Telegram helpers format normalized apartment data", () => {
  assert.equal(isStartCommand("/start@rental_bot payload"), true);
  assert.equal(isStartCommand("/starter"), false);
  assert.equal(
    formatApartmentMessage({
      itemId: "200",
      title: "Apartment on Komitas",
      price: { amount: 220_000, currency: "֏" },
      location: "Arabkir",
      rooms: 2,
      areaSqM: 50,
      floor: "3/5",
      date: "Friday, July 24, 2026, 14:31",
      url: "https://www.list.am/ru/item/200",
    }),
    [
      "Apartment on Komitas",
      "Price: 220,000 ֏",
      "Location: Arabkir",
      "Rooms: 2",
      "Area: 50 sq m",
      "Floor: 3/5",
      "Date: Friday, July 24, 2026, 14:31",
      "https://www.list.am/ru/item/200",
    ].join("\n"),
  );
});

test("TelegramApi obeys retry_after when Telegram rate limits delivery", async () => {
  const sleeps = [];
  let calls = 0;
  const api = new TelegramApi("secret", {
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return Response.json(
          {
            ok: false,
            description: "Too Many Requests",
            parameters: { retry_after: 2 },
          },
          { status: 429 },
        );
      }
      return Response.json({ ok: true, result: { message_id: 1 } });
    },
    sleep: async (milliseconds) => sleeps.push(milliseconds),
  });

  await api.sendMessage(42, "hello");

  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [2_000]);
});

test("/start wakes the monitor and sends apartments to the owner chat", async () => {
  const controller = new AbortController();
  const sent = [];
  let updateCalls = 0;
  const api = {
    getUpdates: async (_offset, _timeout, signal) => {
      updateCalls += 1;
      if (updateCalls === 1) return [update(1, 42, "/start")];
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve([]), { once: true });
      });
    },
    sendMessage: async (chatId, text) => {
      sent.push([chatId, text]);
      if (text.startsWith("Apartment 100")) controller.abort();
    },
  };

  await runTelegramBot(
    {
      telegramBotToken: "token",
      telegramOwnerId: 42,
      telegramStateFile: "/state/bot.json",
      telegramPollTimeoutSeconds: 25,
      timeoutMs: 1_000,
      pollIntervalMs: 60_000,
    },
    {
      api,
      signal: controller.signal,
      loadState: async () => undefined,
      saveState: async () => {},
      crawl: async (_config, { deliverApartment }) => {
        await deliverApartment({
          itemId: "100",
          title: "Apartment 100",
          price: { amount: 200_000, currency: "֏" },
          location: "Arabkir",
          rooms: 2,
          areaSqM: 50,
          floor: "3/5",
          date: "Friday, July 24, 2026, 14:31",
          url: "https://www.list.am/ru/item/100",
        });
        return {
          status: "new-apartments",
          discoveredCount: 1,
          notifiedCount: 1,
        };
      },
    },
  );

  assert.deepEqual(
    sent.map(([chatId]) => chatId),
    [42, 42],
  );
  assert.equal(sent[1][1].startsWith("Apartment 100"), true);
});

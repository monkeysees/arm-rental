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

function callback(updateId, data, messageId = 100) {
  return {
    update_id: updateId,
    callback_query: {
      id: `query-${updateId}`,
      from: { id: 42 },
      data,
      message: {
        message_id: messageId,
        chat: { id: 42, type: "private" },
      },
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
      update(13, 42, "/start"),
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
  assert.equal(state.updateOffset, 14);
  assert.deepEqual(
    sent.map(([chatId, text]) => [chatId, text]),
    [
      [42, "Мониторинг объявлений запущен."],
      [42, "Мониторинг объявлений уже запущен."],
    ],
  );
  assert.equal(sent[0][2].inline_keyboard[0][0].callback_data, "f:menu");
  assert.equal(saved.at(-1).updateOffset, 14);
});

test("owner configures ranges and multiple locations through Telegram", async () => {
  const sent = [];
  const edited = [];
  const answered = [];
  const saved = [];

  const state = await processUpdates(
    [
      update(20, 42, "/filters"),
      callback(21, "f:locations"),
      callback(22, "f:region:0"),
      callback(23, "f:place:0:1"),
      callback(24, "f:locations"),
      callback(25, "f:region:1"),
      callback(26, "f:all:1"),
      callback(27, "f:price"),
      update(28, 42, "150000-300000"),
    ],
    config,
    initialState,
    {
      sendMessage: async (...args) => sent.push(args),
      editMessage: async (...args) => edited.push(args),
      answerCallback: async (id) => answered.push(id),
      saveState: async (value) => saved.push(structuredClone(value)),
    },
  );

  assert.deepEqual(state.filters.price, { min: 150_000, max: 300_000 });
  assert.deepEqual(state.filters.locations, ["p:0:1", "r:1"]);
  assert.equal(state.pendingFilterInput, null);
  assert.equal(state.updateOffset, 29);
  assert.equal(answered.length, 7);
  const locationsView = edited.find((entry) =>
    entry[2].startsWith("Выбор местоположения"),
  );
  assert.match(locationsView[3].inline_keyboard[0][0].text, /Ереван/);
  assert.match(sent.at(-1)[1], /Цена: 150\u00a0000–300\u00a0000/);
  assert.doesNotMatch(sent.at(-1)[1], /валюте объявления/);
  assert.equal(
    sent
      .at(-1)[2]
      .inline_keyboard.flat()
      .some(({ text }) => text === "Готово"),
    false,
  );
  assert.equal(saved.at(-1).updateOffset, 29);
});

test("filter changes are persisted before the menu is refreshed", async () => {
  const events = [];

  const state = await processUpdates(
    [callback(30, "f:all:0")],
    config,
    initialState,
    {
      sendMessage: async () => {},
      editMessage: async () => events.push("edit"),
      answerCallback: async () => events.push("answer"),
      saveState: async () => events.push("save"),
    },
  );

  assert.deepEqual(state.filters.locations, ["r:0"]);
  assert.deepEqual(events.slice(0, 3), ["answer", "save", "edit"]);
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
      "Цена: 220 000 ֏",
      "Местоположение: Arabkir",
      "Количество комнат: 2",
      "Площадь: 50 м²",
      "Этаж: 3/5",
      "https://www.list.am/ru/item/200",
    ].join("\n"),
  );
});

test("Telegram helpers use Russian fallbacks for missing apartment data", () => {
  assert.equal(
    formatApartmentMessage({
      itemId: "201",
      title: "",
      price: { amount: null, currency: null },
      location: "",
      rooms: null,
      areaSqM: null,
      floor: null,
      date: null,
      url: "https://www.list.am/ru/item/201",
    }),
    [
      "Квартира 201",
      "Цена: не указана",
      "Местоположение: не указано",
      "Количество комнат: не указано",
      "Площадь: не указана",
      "Этаж: не указан",
      "https://www.list.am/ru/item/201",
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

test("TelegramApi serializes interactive filter controls", async () => {
  const requests = [];
  const api = new TelegramApi("secret", {
    fetchImpl: async (url, options) => {
      requests.push({
        method: new URL(url).pathname.split("/").at(-1),
        body: JSON.parse(options.body),
      });
      return Response.json({ ok: true, result: true });
    },
  });
  const replyMarkup = {
    inline_keyboard: [[{ text: "Фильтры", callback_data: "f:menu" }]],
  };

  await api.getUpdates(5, 25);
  await api.sendMessage(42, "Настройки", undefined, replyMarkup);
  await api.editMessageText(42, 10, "Фильтры", undefined, replyMarkup);
  await api.answerCallbackQuery("query-1");

  assert.deepEqual(requests, [
    {
      method: "getUpdates",
      body: {
        offset: 5,
        timeout: 25,
        allowed_updates: ["message", "callback_query"],
      },
    },
    {
      method: "sendMessage",
      body: {
        chat_id: 42,
        text: "Настройки",
        disable_web_page_preview: true,
        reply_markup: replyMarkup,
      },
    },
    {
      method: "editMessageText",
      body: {
        chat_id: 42,
        message_id: 10,
        text: "Фильтры",
        disable_web_page_preview: true,
        reply_markup: replyMarkup,
      },
    },
    {
      method: "answerCallbackQuery",
      body: { callback_query_id: "query-1" },
    },
  ]);
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

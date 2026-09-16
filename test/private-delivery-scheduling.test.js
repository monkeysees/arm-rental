import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runTelegramBot } from "../src/bot.js";
import { TelegramApi } from "../src/telegram.js";
import { createMemoryStateAccess } from "../test-support/memory-state.js";

const config = {
  telegramBotToken: "test",
  telegramOwnerId: 1,
  telegramAccessMode: "public",
  telegramPollTimeoutSeconds: 25,
  telegramPrivateDeliveriesPerMinute: 20,
  pollIntervalMs: 60000,
  initialPageCount: 1,
  initialDeliveryLimit: 100,
  listUrlTemplate: "https://www.list.am/ru/category/56/{page}",
};
const stamp = "2026-07-24T12:00:00Z";
function page(ids = ["3", "2", "1"]) {
  return `<div id="contentr">${ids.map((id) => `<a class="fav-item-info-container" href="/ru/item/${id}"><div class="dltitle"><div class="pt">Apartment ${id}</div></div><div class="p">100000 ֏ monthly</div><div class="at">Arabkir, 2 rm., 50 sq.m., 3/5 floor</div><div class="d">Сегодня, 00:00</div></a>`).join("")}</div>`;
}
function state(users = 16) {
  return createMemoryStateAccess({
    listUrlTemplate: config.listUrlTemplate,
    telegram: {
      version: 3,
      type: "telegram-bot",
      updateOffset: 0,
      users: Object.fromEntries(
        Array.from({ length: users }, (_, index) => [
          index + 1,
          { chatId: index + 1, active: true },
        ]),
      ),
    },
  });
}
function apiWithPolling(api) {
  api.getUpdates = async (_offset, _timeout, signal) => {
    await delay(60000, undefined, { signal }).catch(() => {});
    return [];
  };
  api.setMyCommands =
    api.setMyDescription =
    api.setMyShortDescription =
      async () => true;
  return api;
}

test("ready recipients progress while all eight peers await Telegram retry_after", async () => {
  const controller = new AbortController();
  const safety = setTimeout(() => controller.abort(), 10000);
  let readySent = false;
  let apiWaits = 0;
  const api = apiWithPolling(
    new TelegramApi("test", {
      fetchImpl: async (_url, { body }) => {
        const { chat_id: id } = JSON.parse(body);
        if (id <= 8)
          return new Response(
            JSON.stringify({
              ok: false,
              error_code: 429,
              parameters: { retry_after: 60 },
            }),
            { status: 429 },
          );
        readySent = true;
        controller.abort();
        return new Response(
          JSON.stringify({ ok: true, result: { message_id: 1 } }),
        );
      },
      sleep: async (...args) => {
        apiWaits += 1;
        await delay(...args);
      },
    }),
  );
  try {
    await runTelegramBot(config, {
      api,
      stateAccess: state(),
      signal: controller.signal,
      pageFetch: async () => new Response(page()),
      now: () => new Date(stamp),
    });
    assert.equal(readySent, true);
    assert.equal(
      apiWaits,
      0,
      "private retry delays belong to the scheduler, not active HTTP operations",
    );
  } finally {
    clearTimeout(safety);
    controller.abort();
  }
});

test("history announcements and retries share one recipient budget without delaying peers", async () => {
  const controller = new AbortController();
  const safety = setTimeout(() => controller.abort(), 10000);
  let clock = 0;
  const calls = [];
  let limited = false;
  const api = apiWithPolling(
    new TelegramApi("test", {
      fetchImpl: async (_url, { body }) => {
        const { chat_id: id, text } = JSON.parse(body);
        calls.push({ id, text, time: clock });
        if (id === 1 && text.startsWith("Apartment 4\n") && !limited) {
          limited = true;
          return new Response(
            JSON.stringify({
              ok: false,
              error_code: 429,
              parameters: { retry_after: 7 },
            }),
            { status: 429 },
          );
        }
        return new Response(
          JSON.stringify({ ok: true, result: { message_id: calls.length } }),
        );
      },
    }),
  );
  try {
    await runTelegramBot(config, {
      api,
      stateAccess: state(),
      signal: controller.signal,
      monotonicNow: () => clock,
      sleep: async (ms, _value, { signal } = {}) => {
        signal?.throwIfAborted();
        clock += ms;
      },
      pageFetch: async () => new Response(page(["6", "5", "4", "3", "2", "1"])),
      onResult: () => controller.abort(),
    });
    const first = calls.filter(({ id }) => id === 1);
    assert.equal(limited, true);
    assert.deepEqual(
      first.map(({ time }) => time),
      [0, 0, 0, 0, 0, 7000, 7000, 7000],
    );
    assert.match(first[0].text, /6/u);
    assert.deepEqual(
      first.slice(1).map(({ text }) => text.split("\n")[0]),
      [
        "Apartment 1",
        "Apartment 2",
        "Apartment 3",
        "Apartment 4",
        "Apartment 4",
        "Apartment 5",
        "Apartment 6",
      ],
    );
    assert.deepEqual(
      calls.filter(({ id }) => id === 2).map(({ time }) => time),
      [0, 0, 0, 0, 0, 3000, 6000],
    );
  } finally {
    clearTimeout(safety);
    controller.abort();
  }
});

test("deleting a recipient waiting on Telegram drains the crawl immediately", async () => {
  const controller = new AbortController();
  const safety = setTimeout(() => controller.abort(), 10000);
  const access = state(1);
  const waiting = Promise.withResolvers();
  let crawled = false;
  let polls = 0;
  const api = apiWithPolling({
    sendMessage: async (_id, text) => {
      if (/Подходящих объявлений/u.test(text)) {
        const error = new Error("Too Many Requests");
        error.httpStatus = 429;
        error.retryAfterMs = 60000;
        throw error;
      }
    },
    answerCallbackQuery: async () => {},
    editMessageText: async () => {},
  });
  api.getUpdates = async (_offset, _timeout, signal) => {
    if (polls++ === 0) {
      await Promise.race([
        waiting.promise,
        delay(60000, undefined, { signal }).catch(() => {}),
      ]);
      return [
        {
          update_id: 1,
          message: {
            from: { id: 1 },
            chat: { id: 1, type: "private" },
            text: "/delete_my_data",
          },
        },
        {
          update_id: 2,
          callback_query: {
            id: "delete",
            from: { id: 1 },
            data: "d:confirm",
            message: { message_id: 1, chat: { id: 1, type: "private" } },
          },
        },
      ];
    }
    await delay(60000, undefined, { signal }).catch(() => {});
    return [];
  };
  try {
    await runTelegramBot(config, {
      api,
      stateAccess: access,
      signal: controller.signal,
      pageFetch: async () => new Response(page()),
      onRetry: () => waiting.resolve(),
      onError: (error) => {
        throw error;
      },
      onResult: () => {
        crawled = true;
        controller.abort();
      },
    });
    assert.equal(
      crawled,
      true,
      "deletion must wake a scheduler sleeping on retry_after",
    );
    assert.equal((await access.telegram.load()).users[1], undefined);
    assert.equal(
      await access.privateDeliveries.loadRecipient("1", []),
      undefined,
    );
  } finally {
    clearTimeout(safety);
    controller.abort();
    waiting.resolve();
  }
});

test("exhausted Telegram retries leave durable work while healthy peers finish", async () => {
  const controller = new AbortController();
  const safety = setTimeout(() => controller.abort(), 10000);
  const access = state(16);
  let clock = 0;
  const calls = new Map();
  const failures = [];
  const api = apiWithPolling(
    new TelegramApi("test", {
      fetchImpl: async (_url, { body }) => {
        const { chat_id: id } = JSON.parse(body);
        calls.set(id, (calls.get(id) || 0) + 1);
        return new Response(
          JSON.stringify(
            id === 1
              ? { ok: false, error_code: 503 }
              : { ok: true, result: { message_id: 1 } },
          ),
          { status: id === 1 ? 503 : 200 },
        );
      },
    }),
  );
  try {
    await runTelegramBot(config, {
      api,
      stateAccess: access,
      signal: controller.signal,
      monotonicNow: () => clock,
      random: () => 1,
      sleep: async (ms, _value, { signal } = {}) => {
        signal?.throwIfAborted();
        clock += ms;
      },
      pageFetch: async () => new Response(page()),
      onError: (error) => {
        failures.push(error);
        controller.abort();
      },
    });
    assert.equal(failures.length, 1);
    assert.equal(calls.get(1), 4);
    assert.deepEqual(
      (await access.privateDeliveries.loadRecipient("1", ["1", "2", "3"]))
        .notified,
      {},
    );
    for (let id = 2; id <= 16; id += 1) {
      assert.equal(calls.get(id), 4);
      assert.deepEqual(
        Object.keys(
          (
            await access.privateDeliveries.loadRecipient(String(id), [
              "1",
              "2",
              "3",
            ])
          ).notified,
        ),
        ["1", "2", "3"],
      );
    }
  } finally {
    clearTimeout(safety);
    controller.abort();
  }
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { processUpdates, runTelegramBot } from "../src/bot.js";
import { createPrivateRateLimits } from "../src/rate-limit.js";
import { readState, writeState } from "../src/state.js";

function message(updateId, senderId, text) {
  return {
    update_id: updateId,
    message: {
      from: { id: senderId },
      chat: { id: senderId, type: "private" },
      text,
    },
  };
}

function callback(updateId, senderId, data) {
  return {
    update_id: updateId,
    callback_query: {
      id: `delete-${updateId}`,
      from: { id: senderId },
      data,
      message: {
        message_id: 100,
        chat: { id: senderId, type: "private" },
      },
    },
  };
}

function botState(users, updateOffset = 0) {
  return {
    version: 3,
    type: "telegram-bot",
    updateOffset,
    users,
  };
}

function user(chatId, overrides = {}) {
  return {
    active: true,
    chatId,
    sendInitialApartments: false,
    filters: {
      price: { min: null, max: null },
      rooms: { min: null, max: null },
      locations: [],
    },
    pendingFilterInput: null,
    ...overrides,
  };
}

test("immediate cancellation retires a confirmation despite response throttling", async () => {
  const senderId = 99;
  const limits = createPrivateRateLimits(5, { monotonicNow: () => 0 });
  for (let index = 0; index < 5; index += 1) {
    limits.tryConsumeUpdate(senderId, index);
  }
  const sent = [];
  const edited = [];
  const cancelled = [];
  const pending = [];
  const answered = [];
  const state = botState({ [senderId]: user(senderId) });

  const requested = await processUpdates(
    [message(10, senderId, "/delete_my_data")],
    { telegramOwnerId: 42, telegramAccessMode: "owner" },
    state,
    {
      sendMessage: async (...arguments_) => sent.push(arguments_),
      editMessage: async (...arguments_) => edited.push(arguments_),
      saveState: async () => {},
      rateLimits: limits,
    },
  );
  assert.equal(requested.users[senderId].active, true);
  assert.match(sent[0][1], /Удалить все ваши данные/u);
  assert.equal(sent[0][2].inline_keyboard[0][0].callback_data, "d:confirm");

  const cancelledState = await processUpdates(
    [
      callback(11, senderId, "d:cancel"),
      callback(12, senderId, "d:cancel"),
      callback(13, senderId, "d:confirm"),
    ],
    { telegramOwnerId: 42, telegramAccessMode: "owner" },
    requested,
    {
      sendMessage: async () => {},
      editMessage: async (...arguments_) => edited.push(arguments_),
      answerCallback: async (callbackId) => answered.push(callbackId),
      saveState: async () => {},
      onDeletionCancelled: async () => cancelled.push(true),
      onDeletionPending: async () => pending.push(true),
      rateLimits: limits,
    },
  );
  assert.equal(edited.length, 1);
  assert.match(edited[0][2], /отменено/u);
  assert.deepEqual(cancelled, [true]);
  assert.deepEqual(pending, []);
  assert.equal(cancelledState.users[senderId].active, true);
  assert.equal(cancelledState.users[senderId].deletionPendingAt, undefined);
  assert.deepEqual(answered, ["delete-11", "delete-12", "delete-13"]);
});

test("unknown deletion requests follow access policy without state creation", async () => {
  const limits = createPrivateRateLimits(5, { monotonicNow: () => 0 });
  const sent = [];
  const answered = [];
  const denied = [];
  const state = await processUpdates(
    [
      message(1, 77, "/delete_my_data"),
      message(2, 77, "/delete_my_data"),
      callback(3, 77, "d:confirm"),
    ],
    { telegramOwnerId: 42, telegramAccessMode: "owner" },
    botState({}),
    {
      sendMessage: async (...arguments_) => sent.push(arguments_),
      answerCallback: async (callbackId) => answered.push(callbackId),
      saveState: async () => {},
      onAccessDenied: async (event) => denied.push(event),
      rateLimits: limits,
    },
  );

  assert.deepEqual(state.users, {});
  assert.equal(state.updateOffset, 4);
  assert.deepEqual(sent, []);
  assert.deepEqual(answered, ["delete-3"]);
  assert.deepEqual(denied, [
    { accessMode: "owner", reason: "not_authorized" },
    { accessMode: "owner", reason: "not_authorized" },
    { accessMode: "owner", reason: "not_authorized" },
  ]);
  assert.equal(limits.inboundUpdates.size, 0);
  assert.equal(limits.deletionResponses.size, 0);
  assert.equal(limits.accessDeniedResponses.size, 0);

  const publicLimits = createPrivateRateLimits(5, { monotonicNow: () => 0 });
  const publicSent = [];
  const publicState = await processUpdates(
    [message(4, 88, "/delete_my_data")],
    { telegramOwnerId: 42, telegramAccessMode: "public" },
    botState({}),
    {
      sendMessage: async (...arguments_) => publicSent.push(arguments_),
      saveState: async () => {},
      rateLimits: publicLimits,
    },
  );
  assert.deepEqual(publicState.users, {});
  assert.equal(publicLimits.inboundUpdates.size, 1);
  assert.equal(publicSent.length, 1);
  assert.match(publicSent[0][1], /нет сохранённых данных/u);
});

test("confirmation persists an inactive marker before best-effort acknowledgement", async () => {
  const senderId = 42;
  const saves = [];
  const callbackErrors = [];
  const pending = [];
  const limits = createPrivateRateLimits(5, { monotonicNow: () => 0 });
  const requested = await processUpdates(
    [message(9, senderId, "/delete_my_data")],
    { telegramOwnerId: senderId, telegramAccessMode: "owner" },
    botState({ [senderId]: user(senderId) }),
    {
      sendMessage: async () => {},
      saveState: async () => {},
      rateLimits: limits,
    },
  );
  const state = await processUpdates(
    [callback(10, senderId, "d:confirm"), message(11, senderId, "/start")],
    { telegramOwnerId: senderId, telegramAccessMode: "owner" },
    requested,
    {
      sendMessage: async () => {},
      editMessage: async () => {},
      answerCallback: async () => {
        throw new Error("callback unavailable");
      },
      saveState: async (value) => saves.push(structuredClone(value)),
      onDeletionPending: async () => pending.push(true),
      onDeletionCallbackError: async (error) => callbackErrors.push(error),
      now: () => new Date("2026-07-26T12:00:00.000Z"),
      rateLimits: limits,
    },
  );

  assert.equal(state.updateOffset, 12);
  assert.equal(state.users[senderId].active, false);
  assert.equal(
    state.users[senderId].deletionPendingAt,
    "2026-07-26T12:00:00.000Z",
  );
  assert.equal(saves[0].users[senderId].active, false);
  assert.deepEqual(pending, [true]);
  assert.match(callbackErrors[0].message, /callback unavailable/u);
});

async function deletionFixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "arm-rental-delete-"));
  const config = {
    telegramBotToken: "token",
    telegramOwnerId: 42,
    telegramAccessMode: "public",
    telegramStateFile: path.join(directory, "telegram-bot.json"),
    deliveryStateFile: path.join(directory, "telegram-deliveries.json"),
    listUrlTemplate: "https://www.list.am/category/56?n=0&page={page}",
    telegramPollTimeoutSeconds: 25,
    telegramUserUpdatesPerMinute: 30,
    telegramPrivateDeliveriesPerMinute: 20,
    timeoutMs: 1_000,
    pollIntervalMs: 60_000,
  };
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return config;
}

async function writePendingFixture(config) {
  await writeState(
    config.telegramStateFile,
    botState(
      {
        42: user(42, {
          active: false,
          deletionPendingAt: "2026-07-26T12:00:00.000Z",
        }),
        99: user(99),
      },
      123,
    ),
  );
  await writeState(config.deliveryStateFile, {
    version: 2,
    type: "telegram-deliveries",
    urlTemplate: config.listUrlTemplate,
    recipients: {
      42: {
        notified: { private: "2026-07-26T11:00:00.000Z" },
        skipped: {},
        filtered: {},
        initialSelectionApplied: true,
      },
      99: {
        notified: { peer: "2026-07-26T11:00:00.000Z" },
        skipped: {},
        filtered: {},
        initialSelectionApplied: true,
      },
    },
  });
}

async function recoverAndStop(config, overrides = {}) {
  const controller = new AbortController();
  const completions = [];
  await runTelegramBot(config, {
    signal: controller.signal,
    api: {
      getUpdates: async () => [],
      sendMessage: async (...arguments_) => {
        completions.push(arguments_);
        controller.abort();
      },
    },
    loadState: readState,
    saveState: writeState,
    crawl: async () =>
      assert.fail("pending deletion must recover before crawl"),
    onPrivateUserDeletionCompleted: async (event) => completions.push(event),
    ...overrides,
  });
  return completions;
}

test("startup recovery removes only the requested user and preserves offset and peers", async (t) => {
  const config = await deletionFixture(t);
  await writePendingFixture(config);

  const events = await recoverAndStop(config);
  const bot = await readState(config.telegramStateFile);
  const deliveries = await readState(config.deliveryStateFile);
  assert.equal(bot.version, 3);
  assert.equal(bot.updateOffset, 123);
  assert.equal(bot.users[42], undefined);
  assert.equal(bot.legacyRecipientId, undefined);
  assert.equal(bot.users[99].chatId, 99);
  assert.equal(deliveries.recipients[42], undefined);
  assert.deepEqual(deliveries.recipients[99].notified, {
    peer: "2026-07-26T11:00:00.000Z",
  });
  assert.deepEqual(events[0], { recovered: true });
  assert.match(events[1][1], /данные удалены/u);

  const sent = [];
  const registered = await processUpdates(
    [message(124, 42, "/start")],
    { telegramOwnerId: 42, telegramAccessMode: "public" },
    bot,
    {
      sendMessage: async (...arguments_) => sent.push(arguments_),
      editMessage: async () => {},
      saveState: async () => {},
    },
  );
  assert.equal(registered.users[42].active, false);
  assert.equal(registered.users[42].sendInitialApartments, true);
  assert.deepEqual(registered.users[42].filters, {
    price: { min: null, max: null },
    rooms: { min: null, max: null },
    locations: [],
  });
  assert.match(sent[0][1], /Мониторинг: остановлен/u);

  const edited = [];
  await processUpdates(
    [callback(125, 42, "m:start")],
    { telegramOwnerId: 42, telegramAccessMode: "public" },
    registered,
    {
      sendMessage: async () => {},
      editMessage: async (...arguments_) => edited.push(arguments_),
      answerCallback: async () => {},
      saveState: async () => {},
    },
  );
  assert.match(edited[0][2], /Отправить уже найденные квартиры/u);
  assert.equal(deliveries.recipients[42], undefined);
});

test("every durable deletion boundary is idempotently restartable", async (t) => {
  for (const boundary of ["delivery", "bot"]) {
    await t.test(boundary, async (t) => {
      const config = await deletionFixture(t);
      await writePendingFixture(config);
      let interrupted = false;
      const saveState = async (filename, value) => {
        if (filename === config.deliveryStateFile) {
          await writeState(filename, value);
          if (boundary === "delivery" && !interrupted) {
            interrupted = true;
            throw new Error("crash after delivery boundary");
          }
          return;
        }
        if (filename === config.telegramStateFile && boundary === "bot") {
          await writeState(filename, value);
          if (!interrupted) {
            interrupted = true;
            throw new Error("crash after bot boundary");
          }
          return;
        }
        await writeState(filename, value);
      };
      await assert.rejects(
        recoverAndStop(config, { saveState }),
        /crash after/u,
      );

      const afterCrashBot = await readState(config.telegramStateFile);
      const afterCrashDelivery = await readState(config.deliveryStateFile);
      assert.equal(afterCrashDelivery.recipients[42], undefined);
      if (boundary === "delivery") {
        assert.ok(afterCrashBot.users[42].deletionPendingAt);
        await recoverAndStop(config);
      } else {
        assert.equal(afterCrashBot.users[42], undefined);
      }
      const finalBot = await readState(config.telegramStateFile);
      const finalDelivery = await readState(config.deliveryStateFile);
      assert.equal(finalBot.users[42], undefined);
      assert.equal(finalBot.updateOffset, 123);
      assert.equal(finalDelivery.recipients[42], undefined);
      assert.ok(finalBot.users[99]);
      assert.ok(finalDelivery.recipients[99]);
    });
  }
});

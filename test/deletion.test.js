import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { processUpdates, runTelegramBot } from "../src/bot.js";
import { createPrivateRateLimits } from "../src/rate-limit.js";
import { openStateDatabase } from "../src/sqlite-database.js";
import { createSqliteRepositories } from "../src/sqlite-repositories.js";
import { createSqliteStateAccess } from "../src/sqlite-state-access.js";

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
    dataDirectory: directory,
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

/**
 * A real database holding one user with a pending deletion and one untouched
 * peer, which is the state a restart has to recover from.
 */
function pendingDeletionState(t, config) {
  const database = openStateDatabase({
    dataDirectory: config.dataDirectory,
    listUrlTemplate: config.listUrlTemplate,
  });
  t.after(() => database.close());
  const repositories = createSqliteRepositories(database, {
    listUrlTemplate: config.listUrlTemplate,
  });
  repositories.telegram.importState(
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
  repositories.privateDeliveries.importState({
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
  return {
    repositories,
    stateAccess: createSqliteStateAccess(database, repositories),
  };
}

// The bot stops as soon as it announces a completed deletion. A restart with
// nothing left to recover never announces anything, so `stopOnPoll` stops it at
// the first poll instead, which is where such a restart arrives.
async function recoverAndStop(
  config,
  { stopOnPoll = false, ...overrides } = {},
) {
  const controller = new AbortController();
  const completions = [];
  await runTelegramBot(config, {
    signal: controller.signal,
    api: {
      getUpdates: async () => {
        if (stopOnPoll) controller.abort();
        return [];
      },
      setMyCommands: async () => true,
      setMyDescription: async () => true,
      setMyShortDescription: async () => true,
      sendMessage: async (...arguments_) => {
        completions.push(arguments_);
        controller.abort();
      },
    },
    crawl: async () =>
      assert.fail("pending deletion must recover before crawl"),
    onPrivateUserDeletionCompleted: async (event) => completions.push(event),
    ...overrides,
  });
  return completions;
}

test("startup recovery removes only the requested user and preserves offset and peers", async (t) => {
  const config = await deletionFixture(t);
  const { repositories, stateAccess } = pendingDeletionState(t, config);

  const events = await recoverAndStop(config, { stateAccess });
  const bot = repositories.telegram.load();
  assert.equal(bot.version, 3);
  assert.equal(bot.updateOffset, 123);
  assert.equal(bot.users[42], undefined);
  assert.equal(bot.legacyRecipientId, undefined);
  assert.equal(bot.users[99].chatId, 99);
  assert.equal(repositories.privateDeliveries.loadRecipient("42"), undefined);
  assert.deepEqual(
    repositories.privateDeliveries.loadRecipient("99").notified,
    {
      peer: "2026-07-26T11:00:00.000Z",
    },
  );
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

  // Re-registering must not resurrect the deleted delivery history.
  assert.equal(repositories.privateDeliveries.loadRecipient("42"), undefined);
});

test("a crash around the atomic deletion stays replayable and idempotent", async (t) => {
  for (const boundary of ["before", "after"]) {
    await t.test(boundary, async (t) => {
      const config = await deletionFixture(t);
      const { repositories, stateAccess } = pendingDeletionState(t, config);
      let interrupted = false;
      const crashing = {
        ...stateAccess,
        deleteUserData: async (chatId) => {
          if (boundary === "before" && !interrupted) {
            interrupted = true;
            throw new Error("crash after delivery boundary");
          }
          const result = await stateAccess.deleteUserData(chatId);
          if (!interrupted) {
            interrupted = true;
            throw new Error("crash after bot boundary");
          }
          return result;
        },
      };

      await assert.rejects(
        recoverAndStop(config, { stateAccess: crashing }),
        /crash after/u,
      );

      // The user row and the delivery history move together, so the only two
      // states a crash can leave are "both present" and "both gone".
      const afterCrash = repositories.telegram.load();
      const deletedRecipient =
        repositories.privateDeliveries.loadRecipient("42");
      if (boundary === "before") {
        assert.ok(afterCrash.users[42].deletionPendingAt);
        assert.ok(deletedRecipient);
        await recoverAndStop(config, { stateAccess: crashing });
      } else {
        assert.equal(afterCrash.users[42], undefined);
        assert.equal(deletedRecipient, undefined);
      }

      // Restarting once more must reach polling with nothing left to recover,
      // and must not announce the deletion a second time.
      const replayed = await recoverAndStop(config, {
        stateAccess: crashing,
        stopOnPoll: true,
      });
      assert.deepEqual(replayed, []);

      const final = repositories.telegram.load();
      assert.equal(final.users[42], undefined);
      assert.equal(final.updateOffset, 123);
      assert.ok(final.users[99]);
      assert.equal(
        repositories.privateDeliveries.loadRecipient("42"),
        undefined,
      );
      assert.ok(repositories.privateDeliveries.loadRecipient("99"));
    });
  }
});

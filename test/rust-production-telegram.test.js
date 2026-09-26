import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { processUpdates } from "../src/bot.js";

const binary = process.env.RENTAL_APP_BINARY;
function contract(input) {
  const result = spawnSync(binary, ["contract"], {
    input: `${JSON.stringify({ op: "bot", ...input })}\n`,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}
const initial = () => ({
  version: 3,
  type: "telegram-bot",
  updateOffset: 0,
  users: {},
});
function message(id, text, sender = 42) {
  return {
    update_id: id,
    message: {
      message_id: 200,
      from: { id: sender },
      chat: { type: "private", id: sender },
      text,
    },
  };
}
function callback(id, data, sender = 42) {
  return {
    update_id: id,
    callback_query: {
      id: `query${id}`,
      from: { id: sender },
      data,
      message: { message_id: 200, chat: { type: "private", id: sender } },
    },
  };
}
async function oracle(updates, config, state = initial()) {
  const operations = [];
  const result = await processUpdates(updates, config, state, {
    saveState: async () => {},
    sendMessage: async (chat_id, text, reply_markup) =>
      operations.push({
        method: "sendMessage",
        payload: { chat_id, text, ...(reply_markup ? { reply_markup } : {}) },
      }),
    editMessage: async (chat_id, message_id, text, reply_markup) =>
      operations.push({
        method: "editMessageText",
        payload: {
          chat_id,
          message_id,
          text,
          ...(reply_markup ? { reply_markup } : {}),
        },
      }),
    answerCallback: async (callback_query_id) =>
      operations.push({
        method: "answerCallbackQuery",
        payload: { callback_query_id },
      }),
  });
  return { state: result, operations };
}

test(
  "Rust private conversation matches Node commands, consent, ranges, kinds and locations",
  { skip: !binary },
  async () => {
    const updates = [
      message(1, "/start"),
      callback(2, "m:start"),
      callback(3, "m:start:new"),
      callback(4, "f:price"),
      message(5, "100000-250000"),
      callback(6, "f:rooms"),
      message(7, "0"),
      message(8, "/clear"),
      callback(9, "f:kinds"),
      callback(10, "f:kind:house"),
      callback(11, "f:kind:apartment"),
      callback(12, "f:kind:house"),
      callback(13, "f:locations"),
      callback(14, "f:region:0"),
      callback(15, "f:place:0:6"),
      callback(16, "f:all:0"),
      callback(17, "f:place:0:1"),
      callback(18, "f:locations"),
      callback(19, "f:menu"),
      callback(20, "m:stop"),
      message(21, "/menu@TestBot"),
      callback(22, "f:reset"),
      message(23, "/stop"),
    ];
    const config = {
      telegramAccessMode: "public",
      telegramUserUpdatesPerMinute: 100,
      initialDeliveryLimit: 25,
    };
    const expected = await oracle(updates, config);
    const actual = contract({ config, updates });
    assert.deepEqual(actual.state, expected.state);
    assert.deepEqual(actual.operations, expected.operations);
  },
);

test(
  "Rust private boundary rejects malformed context and policy denied users without registration",
  { skip: !binary },
  async () => {
    const updates = [
      message(1, "/start"),
      callback(2, "m:start:initial"),
      {
        ...message(3, "/start"),
        message: {
          ...message(3, "/start").message,
          chat: { type: "group", id: 42 },
        },
      },
      callback(4, "m:start", 99),
      message(5, "/start", 7),
    ];
    updates[3].callback_query.message.chat.id = 100;
    const config = {
      telegramAccessMode: "allowlist",
      telegramAllowedUserIds: [7],
      telegramOwnerId: 1,
    };
    const expected = await oracle(updates, config);
    const actual = contract({ config, updates });
    assert.deepEqual(actual.state, expected.state);
    assert.deepEqual(actual.operations, expected.operations);
  },
);

test(
  "Rust inbound throttling preserves offsets and answers callbacks",
  { skip: !binary },
  async () => {
    const updates = [
      message(1, "/start"),
      callback(2, "f:price"),
      callback(3, "m:start"),
      message(4, "/start"),
      callback(5, "unknown"),
    ];
    const config = { telegramUserUpdatesPerMinute: 2 };
    const expected = await oracle(updates, config);
    const actual = contract({ config, updates });
    assert.deepEqual(actual.state, expected.state);
    assert.deepEqual(actual.operations, expected.operations);
  },
);

test(
  "Rust deletion prompts and stale confirmations agree with Node for suspended users",
  { skip: !binary },
  async () => {
    const state = await oracle([message(1, "/start")], {});
    const updates = [
      callback(2, "d:confirm"),
      message(3, "/delete_my_data"),
      callback(4, "d:cancel"),
      callback(5, "d:confirm"),
      message(6, "/delete_my_data"),
      message(7, "/start"),
    ];
    const config = { telegramAccessMode: "owner", telegramOwnerId: 1 };
    const expected = await oracle(updates, config, state.state);
    const actual = contract({ config, state: state.state, updates });
    assert.deepEqual(actual.state, expected.state);
    assert.deepEqual(actual.operations, expected.operations);
  },
);

import assert from "node:assert/strict";
import test from "node:test";

import { createLogger } from "../src/logger.js";

const token = ["123456789", "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"].join(":");

function recordingLogger() {
  const records = [];
  return {
    logger: createLogger({
      log: (record) => records.push(record),
      error: (record) => records.push(record),
    }),
    records,
  };
}

test("structured logging redacts Telegram tokens, API URLs, and credentials", () => {
  const { logger, records } = recordingLogger();

  logger.info(`request https://api.telegram.org/bot${token}/getMe`, {
    telegramBotToken: token,
    headers: {
      authorization: `Bearer ${token}`,
      "proxy-authorization": `Basic dXNlcjpwYXNzd29yZA==`,
    },
    nested: [
      `token=${token}`,
      `https://api.telegram.org/file/bot${token}/document`,
    ],
  });

  assert.equal(records.length, 1);
  assert.doesNotMatch(records[0], new RegExp(token, "u"));
  assert.doesNotMatch(records[0], /dXNlcjpwYXNzd29yZA/u);
  assert.doesNotMatch(records[0], /file\\?\/bot123456789/u);
  assert.match(
    records[0],
    /https:\/\/api\.telegram\.org\/bot\[REDACTED\]\/getMe/u,
  );
  assert.equal(JSON.parse(records[0]).telegramBotToken, "[REDACTED]");
});

test("structured error logging redacts secrets in messages and stacks", () => {
  const { logger, records } = recordingLogger();
  const error = new Error(
    `Telegram request failed at https://api.telegram.org/bot${token}/sendMessage`,
  );

  logger.error("Telegram failure", error, {
    Authorization: `Bearer ${token}`,
  });

  assert.doesNotMatch(records[0], new RegExp(token, "u"));
  const record = JSON.parse(records[0]);
  assert.equal(record.Authorization, "[REDACTED]");
  assert.match(record.error.message, /\[REDACTED\]/u);
  assert.match(record.error.stack, /\[REDACTED\]/u);
});

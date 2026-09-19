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
  const record = JSON.parse(records[0]);
  assert.equal(record.severity, "info");
  assert.equal(record.environment, "development");
  assert.equal(record.applicationVersion, "1.0.0");
  assert.equal(
    record.event,
    "request.https.api.telegram.org.bot.redacted.getme",
  );
  assert.ok(record.timestamp);
});

test("structured error logging redacts secrets in messages and stacks", () => {
  const { logger, records } = recordingLogger();
  const error = new Error(
    `Telegram request failed at https://api.telegram.org/bot${token}/sendMessage`,
  );
  error.sqliteResultCode = 10;

  logger.error("Telegram failure", error, {
    Authorization: `Bearer ${token}`,
  });

  assert.doesNotMatch(records[0], new RegExp(token, "u"));
  const record = JSON.parse(records[0]);
  assert.equal(record.Authorization, "[REDACTED]");
  assert.equal(record.error.sqliteResultCode, 10);
  assert.match(record.error.message, /\[REDACTED\]/u);
  assert.match(record.error.stack, /\[REDACTED\]/u);
});

test("known token shapes are redacted from query values and nested errors", () => {
  const { logger, records } = recordingLogger();
  const shortBotIdToken = "123456:abcdefghijklmnopqrstuvwxyz";
  const longBotIdToken =
    "123456789012:AAE0123456789_abcdefghijklmnopqrstuvwxyz";
  const oauthToken = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";

  logger.error(
    "Credential variants failed",
    new Error(`token=${longBotIdToken}&access_token=${oauthToken}`),
    {
      url: `https://api.telegram.org/file/bot${shortBotIdToken}/photo?api_key=${oauthToken}`,
      credentials: {
        bot: longBotIdToken,
        bearer: `Bearer ${oauthToken}`,
      },
    },
  );

  const serialized = records[0];
  for (const secret of [shortBotIdToken, longBotIdToken, oauthToken]) {
    assert.doesNotMatch(serialized, new RegExp(secret, "u"));
  }
});

test("identical failures are rate-limited and report the suppressed count", () => {
  let currentTime = new Date("2026-07-25T10:00:00.000Z");
  const records = [];
  const logger = createLogger(
    {
      log: (record) => records.push(record),
      error: (record) => records.push(record),
    },
    {
      now: () => currentTime,
      failureWindowMs: 60_000,
    },
  );
  const failure = () =>
    logger.error("Crawl failed", new Error("upstream timed out"), {
      event: "crawl.failed",
      component: "list_am",
      crawlId: `crawl-${records.length}`,
      durationMs: 100,
    });

  failure();
  failure();
  failure();
  assert.equal(records.length, 1);

  currentTime = new Date("2026-07-25T10:01:00.000Z");
  failure();
  assert.equal(records.length, 2);
  assert.equal(JSON.parse(records[1]).suppressedCount, 2);
});

test("application version comes only from immutable package metadata", (t) => {
  const original = process.env.APPLICATION_VERSION;
  process.env.APPLICATION_VERSION = "forged-version";
  t.after(() => {
    if (original === undefined) delete process.env.APPLICATION_VERSION;
    else process.env.APPLICATION_VERSION = original;
  });

  const { logger, records } = recordingLogger();
  logger.info("Version provenance");
  assert.equal(JSON.parse(records[0]).applicationVersion, "1.0.0");
});

test("distinct and recurring alert transitions survive failure suppression", () => {
  const { logger, records } = recordingLogger();
  const firing = (alertName) =>
    logger.warn("Production alert firing", {
      event: "alert.firing",
      alertName,
      status: "firing",
    });
  firing("five_consecutive_crawl_failures");
  firing("list_am_challenge");
  firing("readiness_failure");
  logger.info("Production alert resolved", {
    event: "alert.resolved",
    alertName: "list_am_challenge",
    status: "resolved",
  });
  firing("list_am_challenge");
  assert.deepEqual(
    records.map((record) => {
      const { event, alertName } = JSON.parse(record);
      return [event, alertName];
    }),
    [
      ["alert.firing", "five_consecutive_crawl_failures"],
      ["alert.firing", "list_am_challenge"],
      ["alert.firing", "readiness_failure"],
      ["alert.resolved", "list_am_challenge"],
      ["alert.firing", "list_am_challenge"],
    ],
  );
});

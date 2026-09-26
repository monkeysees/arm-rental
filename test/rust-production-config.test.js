import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { getConfig } from "../src/config.js";

const binary = process.env.RENTAL_APP_BINARY;
const base = {
  TELEGRAM_BOT_TOKEN: "123456:synthetic-test-token",
  TELEGRAM_OWNER_ID: "123",
};

function native(env) {
  const result = spawnSync(binary, ["contract"], {
    input: `${JSON.stringify({ op: "config", env, cwd: "/tmp/parity" })}\n`,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test(
  "Rust configuration matches the independent Node configuration contract",
  { skip: !binary },
  () => {
    for (const env of [
      base,
      {
        ...base,
        TELEGRAM_OWNER_ID: "0x7b",
        HEALTH_PORT: "0b10000000000000",
        DISK_FREE_WARNING_PERCENT: "0o24",
      },
      {
        ...base,
        TELEGRAM_ACCESS_MODE: "allowlist",
        TELEGRAM_ALLOWED_USER_IDS: "456,789",
      },
      {
        ...base,
        DATA_DIRECTORY: "state/../data",
        HEALTH_HOST: "::1",
        HEALTH_PORT: "9001",
      },
      {
        ...base,
        TELEGRAM_CHANNEL_ID: "@example_channel",
        CHANNEL_FILTER_PRICE_AMD: "150000-",
        CHANNEL_FILTER_ROOMS: "1-3",
        CHANNEL_FILTER_LOCATIONS: "all",
      },
    ]) {
      assert.deepEqual(
        native(env),
        JSON.parse(JSON.stringify(getConfig(env, "/tmp/parity"))),
      );
    }
  },
);

test(
  "Rust rejects invalid production configuration without exposing secrets",
  { skip: !binary },
  () => {
    for (const extra of [
      { NODE_ENV: "production" },
      { TELEGRAM_ACCESS_MODE: "allowlist" },
      { TELEGRAM_ALLOWED_USER_IDS: "456" },
      { TELEGRAM_ACCESS_MODE: "allowlist", TELEGRAM_ALLOWED_USER_IDS: "123" },
      { TELEGRAM_PRIVATE_DELIVERIES_PER_MINUTE: "31" },
      { EXTERNAL_RETRY_MAX_MS: "300001" },
      { DATA_DIRECTORY: "/" },
      { LIST_AM_COOKIE_FILE: "/outside/cookies" },
      { APARTMENTS_STATE_FILE: "/tmp/parity/.data/state.sqlite3" },
      { HEALTH_HOST: "0.0.0.0" },
      { BACKUP_DAILY_RETENTION: "6" },
    ]) {
      const env = { ...base, ...extra };
      assert.throws(() => getConfig(env, "/tmp/parity"));
      const result = native(env);
      assert.equal(typeof result.error, "string");
      assert.ok(!JSON.stringify(result).includes(base.TELEGRAM_BOT_TOKEN));
    }
  },
);

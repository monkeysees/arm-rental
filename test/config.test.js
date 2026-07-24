import assert from "node:assert/strict";
import test from "node:test";

import { getConfig } from "../src/config.js";
import { LIST_AM_URL_TEMPLATE, pageUrl } from "../src/target.js";

test("configuration uses the requested target and ten initial pages", () => {
  const config = getConfig(
    {
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_OWNER_ID: "42",
    },
    "/app",
  );

  assert.equal(config.listUrlTemplate, LIST_AM_URL_TEMPLATE);
  assert.equal(config.initialPageCount, 10);
  assert.equal(config.initialDeliveryLimit, 10);
  assert.equal(
    pageUrl(1, config.listUrlTemplate),
    "https://www.list.am/ru/category/56/1?n=0&cmtype=0&crc=0&gl=2&srt=3",
  );
  assert.equal(config.telegramOwnerId, 42);
  assert.equal(config.telegramChannelId, null);
  assert.deepEqual(config.channelFilters.locations, ["r:0"]);
  assert.equal(config.apartmentsStateFile, "/app/.data/apartments.json");
  assert.equal(config.exchangeRatesStateFile, "/app/.data/exchange-rates.json");
  assert.equal(
    config.channelDeliveryStateFile,
    "/app/.data/telegram-channel-deliveries.json",
  );
});

test("configuration rejects invalid owner and page values", () => {
  assert.throws(
    () =>
      getConfig({
        TELEGRAM_BOT_TOKEN: "token",
        TELEGRAM_OWNER_ID: "not-a-number",
      }),
    /TELEGRAM_OWNER_ID must be a positive integer/,
  );
  assert.throws(() => pageUrl(0), /positive integer/);
});

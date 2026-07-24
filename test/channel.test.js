import assert from "node:assert/strict";
import test from "node:test";

import {
  channelContentHash,
  channelHashtags,
  formatChannelApartmentMessage,
  parseChannelFilters,
  publishChannelApartments,
} from "../src/channel.js";
import { getConfig } from "../src/config.js";
import { apartmentMatchesFilters, emptyFilters } from "../src/filters.js";
import { LIST_AM_URL_TEMPLATE } from "../src/target.js";

function apartment(
  itemId,
  {
    location = "Кентрон",
    amountAmd = Number(itemId) * 50_000,
    originalAmount = amountAmd,
    originalCurrency = "AMD",
    rooms = 2,
    title = `Apartment ${itemId}`,
    date = `Пятница, Июль 24, 2026, 14:${itemId.padStart(2, "0")}`,
  } = {},
) {
  return {
    itemId,
    title,
    price: {
      amountAmd,
      originalAmount,
      originalCurrency,
      exchangeRate: null,
      exchangeRateFetchedAt: null,
      exchangeRateEffectiveDate: null,
    },
    location,
    rooms,
    areaSqM: 50,
    floor: "3/5",
    date,
    firstSeenAt: "2026-07-24T10:00:00.000Z",
    url: `https://www.list.am/ru/item/${itemId}`,
  };
}

function apartmentState(...apartments) {
  return {
    version: 2,
    type: "list-am-apartments",
    urlTemplate: LIST_AM_URL_TEMPLATE,
    apartments: Object.fromEntries(
      apartments.map((value) => [value.itemId, value]),
    ),
    apartmentOrder: apartments.map(({ itemId }) => itemId),
  };
}

function memoryState(initial) {
  let value = structuredClone(initial);
  return {
    get value() {
      return structuredClone(value);
    },
    loadState: async () => structuredClone(value),
    saveState: async (_filename, state) => {
      value = structuredClone(state);
    },
  };
}

function channelConfig(overrides = {}) {
  return {
    telegramChannelId: "@rentals",
    channelDeliveryStateFile: "/state/channel.json",
    listUrlTemplate: LIST_AM_URL_TEMPLATE,
    initialDeliveryLimit: 10,
    channelFilters: { ...emptyFilters(), locations: ["r:0"] },
    ...overrides,
  };
}

test("channel environment filters support all range forms and location composition", () => {
  const exact = parseChannelFilters({
    price: "150000",
    rooms: "2",
    locations: "place:Кентрон,place:Арабкир",
  });
  assert.deepEqual(exact.price, { min: 150_000, max: 150_000 });
  assert.deepEqual(exact.rooms, { min: 2, max: 2 });
  assert.equal(exact.locations.length, 2);

  assert.deepEqual(
    parseChannelFilters({ price: "150000-", rooms: "-3", locations: "all" }),
    {
      price: { min: 150_000, max: null },
      rooms: { min: null, max: 3 },
      locations: [],
    },
  );
  assert.deepEqual(
    parseChannelFilters({
      price: "-300000",
      rooms: "1-4",
      locations: "region:Котайк,place:Кентрон",
    }),
    {
      price: { min: null, max: 300_000 },
      rooms: { min: 1, max: 4 },
      locations: ["r:3", "p:0:6"],
    },
  );

  const kentron = apartment("3", { amountAmd: 200_000, rooms: 2 });
  const abovyan = apartment("4", {
    location: "Абовян",
    amountAmd: 200_000,
    rooms: 2,
  });
  const expensive = apartment("5", { amountAmd: 350_000, rooms: 2 });
  const composed = parseChannelFilters({
    price: "150000-300000",
    rooms: "2-3",
    locations: "region:Котайк,place:Кентрон",
  });
  assert.equal(apartmentMatchesFilters(kentron, composed), true);
  assert.equal(apartmentMatchesFilters(abovyan, composed), true);
  assert.equal(apartmentMatchesFilters(expensive, composed), false);
});

test("default channel locations select all Yerevan localities only", () => {
  const filters = parseChannelFilters();
  assert.equal(apartmentMatchesFilters(apartment("1"), filters), true);
  assert.equal(
    apartmentMatchesFilters(apartment("2", { location: "Шенгавит" }), filters),
    true,
  );
  assert.equal(
    apartmentMatchesFilters(apartment("3", { location: "Абовян" }), filters),
    false,
  );
});

test("channel configuration rejects malformed and conflicting selectors", () => {
  for (const locations of [
    "Yerevan",
    "region:Unknown",
    "region:Ереван,region:ереван",
    "region:Ереван,place:Кентрон",
    "all,place:Кентрон",
    "place:",
    "place:Кентрон,",
  ]) {
    assert.throws(
      () => parseChannelFilters({ locations }),
      /CHANNEL_FILTER_LOCATIONS/u,
      locations,
    );
  }
  assert.throws(
    () => parseChannelFilters({ price: "нет" }),
    /CHANNEL_FILTER_PRICE_AMD/u,
  );
  assert.throws(
    () => parseChannelFilters({ rooms: "0" }),
    /CHANNEL_FILTER_ROOMS/u,
  );
  assert.throws(
    () =>
      getConfig({
        TELEGRAM_BOT_TOKEN: "token",
        TELEGRAM_OWNER_ID: "42",
        TELEGRAM_CHANNEL_ID: "private-channel",
      }),
    /public Telegram @username/u,
  );
});

test("channel hashtags use canonical AMD buckets and normalized Russian locations", () => {
  const boundaries = [
    [50_000, "#цена_1_50"],
    [50_001, "#цена_51_100"],
    [100_000, "#цена_51_100"],
    [100_001, "#цена_101_150"],
    [150_000, "#цена_101_150"],
  ];
  for (const [amountAmd, expected] of boundaries) {
    assert.equal(
      channelHashtags(apartment("1", { amountAmd })).includes(expected),
      true,
    );
  }

  assert.deepEqual(
    channelHashtags(
      apartment("2", {
        location: "Малатия-Себастия",
        amountAmd: null,
        rooms: null,
      }),
    ),
    ["#ереван", "#малатия_себастия", "#цена_не_указана", "#комнаты_не_указаны"],
  );
  assert.deepEqual(
    channelHashtags(apartment("3", { location: "", rooms: 1 })),
    ["#регион_не_указан", "#локация_не_указана", "#цена_101_150", "#1комн"],
  );

  const foreign = formatChannelApartmentMessage(
    apartment("4", {
      amountAmd: 585_392,
      originalAmount: 1_600,
      originalCurrency: "USD",
    }),
  );
  assert.match(foreign, /Цена: 1\u00a0600 \$/u);
  assert.match(foreign, /#цена_551_600/u);
});

test("initial channel classification is durable and sends only the latest limit oldest first", async () => {
  const storage = memoryState();
  const sent = [];
  let messageId = 100;
  const state = apartmentState(
    apartment("5"),
    apartment("4"),
    apartment("3"),
    apartment("2"),
    apartment("1"),
  );
  const result = await publishChannelApartments(
    channelConfig({ initialDeliveryLimit: 2 }),
    state,
    {
      ...storage,
      api: {
        sendMessage: async (_channelId, message) => {
          sent.push(message.split("\n")[0]);
          messageId += 1;
          return { message_id: messageId };
        },
      },
      now: () => new Date("2026-07-24T12:00:00Z"),
    },
  );

  assert.deepEqual(sent, ["Apartment 4", "Apartment 5"]);
  assert.equal(result.sentCount, 2);
  assert.equal(storage.value.apartments["5"].status, "published");
  assert.equal(storage.value.apartments["4"].status, "published");
  for (const id of ["1", "2", "3"]) {
    assert.equal(storage.value.apartments[id].status, "skipped_initial");
  }
});

test("partial channel sends resume pending posts without reselection or duplicates", async () => {
  const storage = memoryState();
  const source = apartmentState(apartment("2"), apartment("1"));
  const firstSent = [];
  await publishChannelApartments(channelConfig(), source, {
    ...storage,
    api: {
      sendMessage: async (_channelId, message) => {
        const title = message.split("\n")[0];
        firstSent.push(title);
        if (title === "Apartment 1") throw new Error("Telegram unavailable");
        return { message_id: 20 };
      },
    },
    now: () => new Date("2026-07-24T12:00:00Z"),
  });

  assert.deepEqual(firstSent, ["Apartment 1", "Apartment 2"]);
  assert.equal(storage.value.apartments["1"].status, "pending");
  assert.equal(storage.value.apartments["2"].status, "published");

  const retried = [];
  await publishChannelApartments(channelConfig(), source, {
    ...storage,
    api: {
      sendMessage: async (_channelId, message) => {
        retried.push(message.split("\n")[0]);
        return { message_id: 21 };
      },
    },
    now: () => new Date("2026-07-24T12:01:00Z"),
  });
  assert.deepEqual(retried, ["Apartment 1"]);
  assert.equal(storage.value.apartments["1"].messageId, 21);
});

test("channel filter changes affect only newly classified apartments", async () => {
  const restrictive = channelConfig({
    channelFilters: {
      ...emptyFilters(),
      price: { min: 300_000, max: null },
      locations: [],
    },
  });
  const storage = memoryState();
  const filterChanges = [];

  await publishChannelApartments(
    restrictive,
    apartmentState(apartment("1", { amountAmd: 100_000 })),
    {
      ...storage,
      api: {
        sendMessage: async () => {
          throw new Error("Filtered history must not send");
        },
      },
      now: () => new Date("2026-07-24T12:00:00Z"),
    },
  );
  assert.equal(storage.value.apartments["1"].status, "filtered");

  const sent = [];
  await publishChannelApartments(
    channelConfig({ channelFilters: emptyFilters() }),
    apartmentState(
      apartment("2", { amountAmd: 100_000 }),
      apartment("1", { amountAmd: 100_000 }),
    ),
    {
      ...storage,
      api: {
        sendMessage: async (_channelId, message) => {
          sent.push(message.split("\n")[0]);
          return { message_id: 22 };
        },
      },
      onFilterFingerprintChange: (event) => filterChanges.push(event),
      now: () => new Date("2026-07-24T12:01:00Z"),
    },
  );

  assert.deepEqual(sent, ["Apartment 2"]);
  assert.equal(storage.value.apartments["1"].status, "filtered");
  assert.equal(storage.value.apartments["2"].status, "published");
  assert.equal(filterChanges.length, 1);
});

test("published channel posts edit on rendered changes and republish when missing", async () => {
  const storage = memoryState();
  const original = apartment("1");
  const api = {
    sendMessage: async () => ({ message_id: 10 }),
    editMessageText: async () => {},
  };
  await publishChannelApartments(channelConfig(), apartmentState(original), {
    ...storage,
    api,
    now: () => new Date("2026-07-24T12:00:00Z"),
  });

  let editCalls = 0;
  const changed = { ...original, title: "Updated title" };
  await publishChannelApartments(channelConfig(), apartmentState(changed), {
    ...storage,
    api: {
      sendMessage: async () => {
        throw new Error("Unexpected send");
      },
      editMessageText: async () => {
        editCalls += 1;
      },
    },
    now: () => new Date("2026-07-24T12:01:00Z"),
  });
  assert.equal(editCalls, 1);
  assert.equal(
    storage.value.apartments["1"].contentHash,
    channelContentHash(formatChannelApartmentMessage(changed)),
  );

  await publishChannelApartments(channelConfig(), apartmentState(changed), {
    ...storage,
    api: {
      sendMessage: async () => {
        throw new Error("Unexpected send");
      },
      editMessageText: async () => {
        editCalls += 1;
      },
    },
  });
  assert.equal(editCalls, 1);

  await publishChannelApartments(
    channelConfig(),
    apartmentState({ ...changed, date: "Posting date changed" }),
    {
      ...storage,
      api: {
        sendMessage: async () => {
          throw new Error("Unexpected send");
        },
        editMessageText: async () => {
          editCalls += 1;
        },
      },
    },
  );
  assert.equal(editCalls, 1);

  const changedAgain = { ...changed, rooms: 3 };
  await publishChannelApartments(
    channelConfig(),
    apartmentState(changedAgain),
    {
      ...storage,
      api: {
        editMessageText: async () => {
          throw new Error(
            "Telegram editMessageText failed: Bad Request: message to edit not found",
          );
        },
        sendMessage: async () => ({ message_id: 99 }),
      },
      now: () => new Date("2026-07-24T12:02:00Z"),
    },
  );
  assert.equal(storage.value.apartments["1"].messageId, 99);
  assert.equal(
    storage.value.apartments["1"].contentHash,
    channelContentHash(formatChannelApartmentMessage(changedAgain)),
  );
});

test("failed channel edits retain the acknowledged hash for a later retry", async () => {
  const original = apartment("1");
  const originalMessage = formatChannelApartmentMessage(original);
  const storage = memoryState({
    version: 1,
    type: "telegram-channel-deliveries",
    channelId: "@rentals",
    urlTemplate: LIST_AM_URL_TEMPLATE,
    initialized: true,
    filterFingerprint:
      "427073d8e9ba4c9d8f424e45d9b63f6d21a893089653cf44e899e9477f6f281b",
    apartments: {
      1: {
        status: "published",
        messageId: 10,
        contentHash: channelContentHash(originalMessage),
        classifiedAt: "2026-07-24T12:00:00.000Z",
        publishedAt: "2026-07-24T12:00:00.000Z",
      },
    },
  });
  const changed = { ...original, title: "Changed" };
  const acknowledgedHash = storage.value.apartments["1"].contentHash;

  await publishChannelApartments(channelConfig(), apartmentState(changed), {
    ...storage,
    api: {
      editMessageText: async () => {
        throw new Error("Telegram unavailable");
      },
    },
  });
  assert.equal(storage.value.apartments["1"].contentHash, acknowledgedHash);

  let retries = 0;
  await publishChannelApartments(channelConfig(), apartmentState(changed), {
    ...storage,
    api: {
      editMessageText: async () => {
        retries += 1;
      },
    },
    now: () => new Date("2026-07-24T12:01:00Z"),
  });
  assert.equal(retries, 1);
});

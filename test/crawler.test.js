import assert from "node:assert/strict";
import test from "node:test";

import { crawlApartments } from "../src/crawler.js";
import { emptyFilters } from "../src/filters.js";
import { LIST_AM_URL_TEMPLATE } from "../src/target.js";

const config = {
  listUrlTemplate: LIST_AM_URL_TEMPLATE,
  initialPageCount: 10,
  initialDeliveryLimit: 10,
  apartmentsStateFile: "/state/apartments.json",
  deliveryStateFile: "/state/deliveries.json",
};

function page(...ids) {
  return datedPage(...ids.map((id) => [id, "Пятница, Июль 24, 2026, 14:31"]));
}

function datedPage(...apartments) {
  return `
    <div id="contentr">
      ${apartments
        .map(
          ([id, date]) => `
            <a class="fav-item-info-container" href="/ru/item/${id}">
              <div class="dltitle"><div class="pt">Apartment ${id}</div></div>
              <div class="p">${id},000 ֏ monthly</div>
              <div class="at">Arabkir, 2 rm., 50 sq.m., 3/5 floor</div>
              <div class="d">${date}</div>
            </a>`,
        )
        .join("")}
    </div>`;
}

function memoryState(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    loadState: async (filename) => structuredClone(files.get(filename)),
    saveState: async (filename, state) => {
      files.set(filename, structuredClone(state));
    },
  };
}

test("initial crawl parses pages 1 through 10 and stores every apartment", async () => {
  const state = memoryState();
  const fetched = [];
  const delivered = [];

  const result = await crawlApartments(
    { ...config, initialDeliveryLimit: 3 },
    {
      ...state,
      fetchPage: async (url) => {
        fetched.push(url);
        const pageNumber = Number(new URL(url).pathname.split("/").at(-1));
        return new Response(
          page(
            ...(pageNumber === 2
              ? ["1", String(pageNumber)]
              : [String(pageNumber)]),
          ),
        );
      },
      deliverApartment: async ({ itemId }) => delivered.push(itemId),
      now: () => new Date("2026-07-24T12:00:00Z"),
    },
  );

  assert.equal(result.status, "initial-crawl");
  assert.equal(result.pagesParsed, 10);
  assert.equal(result.discoveredCount, 10);
  assert.equal(result.notifiedCount, 3);
  assert.equal(result.skippedCount, 7);
  assert.equal(fetched.length, 10);
  assert.deepEqual(delivered, ["3", "2", "1"]);
  assert.equal(
    Object.keys(state.files.get(config.apartmentsStateFile).apartments).length,
    10,
  );
  assert.deepEqual(
    Object.keys(state.files.get(config.deliveryStateFile).skipped).sort(),
    ["10", "4", "5", "6", "7", "8", "9"],
  );

  const nextResult = await crawlApartments(
    { ...config, initialDeliveryLimit: 3 },
    {
      ...state,
      fetchPage: async () =>
        new Response(
          datedPage(
            ["11", "Пятница, Июль 24, 2026, 14:32"],
            ["1", "Пятница, Июль 24, 2026, 14:31"],
            ["0", "Пятница, Июль 24, 2026, 14:30"],
          ),
        ),
      deliverApartment: async ({ itemId }) => delivered.push(itemId),
      now: () => new Date("2026-07-24T12:01:00Z"),
    },
  );

  assert.equal(nextResult.notifiedCount, 1);
  assert.equal(nextResult.skippedCount, 0);
  assert.deepEqual(delivered, ["3", "2", "1", "11"]);
});

test("later crawl continues past known IDs until the latest known date", async () => {
  const known = {
    version: 1,
    type: "list-am-apartments",
    urlTemplate: LIST_AM_URL_TEMPLATE,
    apartments: {
      95: {
        itemId: "95",
        date: "Пятница, Июль 24, 2026, 14:00",
        firstSeenAt: "2026-07-24T10:00:00.000Z",
      },
      90: {
        itemId: "90",
        date: "Пятница, Июль 24, 2026, 14:31",
        firstSeenAt: "2026-07-24T10:00:00.000Z",
      },
    },
    apartmentOrder: ["90", "95"],
  };
  const state = memoryState({
    [config.apartmentsStateFile]: known,
  });
  let fetchCount = 0;

  const result = await crawlApartments(config, {
    ...state,
    fetchPage: async () => {
      fetchCount += 1;
      return new Response(
        datedPage(
          ["101", "Пятница, Июль 24, 2026, 15:00"],
          // A known ad may be refreshed above the previous date watermark.
          ["95", "Пятница, Июль 24, 2026, 14:50"],
          ["100", "Пятница, Июль 24, 2026, 14:40"],
          // Unseen IDs sharing the boundary minute must still be captured.
          ["91", "Пятница, Июль 24, 2026, 14:31"],
          ["90", "Пятница, Июль 24, 2026, 14:31"],
          ["80", "Пятница, Июль 24, 2026, 14:30"],
        ),
      );
    },
    now: () => new Date("2026-07-24T12:00:00Z"),
  });

  assert.equal(fetchCount, 1);
  assert.equal(result.lastKnownDate, "Пятница, Июль 24, 2026, 14:31");
  assert.equal(result.stoppedAtKnownDate, "Пятница, Июль 24, 2026, 14:31");
  assert.deepEqual(
    result.discovered.map(({ itemId }) => itemId),
    ["101", "100", "91"],
  );
  assert.equal(
    state.files.get(config.apartmentsStateFile).apartments["80"],
    undefined,
  );
});

test("a failed Telegram delivery remains pending without losing discovery", async () => {
  const state = memoryState();
  const firstAttempts = [];

  await assert.rejects(
    crawlApartments(
      { ...config, initialPageCount: 1 },
      {
        ...state,
        fetchPage: async () => new Response(page("3", "2", "1")),
        deliverApartment: async ({ itemId }) => {
          firstAttempts.push(itemId);
          if (itemId === "2") throw new Error("Telegram unavailable");
        },
        now: () => new Date("2026-07-24T12:00:00Z"),
      },
    ),
    /Telegram unavailable/,
  );

  assert.deepEqual(firstAttempts, ["1", "2"]);
  assert.deepEqual(
    Object.keys(state.files.get(config.apartmentsStateFile).apartments).sort(),
    ["1", "2", "3"],
  );
  assert.deepEqual(
    Object.keys(state.files.get(config.deliveryStateFile).notified),
    ["1"],
  );

  const retried = [];
  await crawlApartments(config, {
    ...state,
    fetchPage: async () => new Response(page("3", "2", "1")),
    deliverApartment: async ({ itemId }) => retried.push(itemId),
    now: () => new Date("2026-07-24T12:01:00Z"),
  });

  assert.deepEqual(retried, ["2", "3"]);
});

test("delivery filters skip non-matching apartments without losing discovery", async () => {
  const state = memoryState();
  const delivered = [];
  const html = `
    <div id="contentr">
      <a class="fav-item-info-container" href="/ru/item/4">
        <div class="pt">Apartment 4</div><div class="p">220000 ֏</div>
        <div class="at">Гюмри, 2 ком., 50 кв.м., 3/5 этаж</div>
        <div class="d">Пятница, Июль 24, 2026, 14:34</div>
      </a>
      <a class="fav-item-info-container" href="/ru/item/3">
        <div class="pt">Apartment 3</div><div class="p">240000 ֏</div>
        <div class="at">Кентрон, 4 ком., 50 кв.м., 3/5 этаж</div>
        <div class="d">Пятница, Июль 24, 2026, 14:33</div>
      </a>
      <a class="fav-item-info-container" href="/ru/item/2">
        <div class="pt">Apartment 2</div><div class="p">200000 ֏</div>
        <div class="at">Арабкир, 2 ком., 50 кв.м., 3/5 этаж</div>
        <div class="d">Пятница, Июль 24, 2026, 14:32</div>
      </a>
      <a class="fav-item-info-container" href="/ru/item/1">
        <div class="pt">Apartment 1</div><div class="p">180000 ֏</div>
        <div class="at">Арабкир, 1 ком., 50 кв.м., 3/5 этаж</div>
        <div class="d">Пятница, Июль 24, 2026, 14:31</div>
      </a>
    </div>`;

  const result = await crawlApartments(
    { ...config, initialPageCount: 1 },
    {
      ...state,
      fetchPage: async () => new Response(html),
      filters: {
        price: { min: 190_000, max: 230_000 },
        rooms: { min: 2, max: 3 },
        locations: ["r:0"],
      },
      deliverApartment: async ({ itemId }) => delivered.push(itemId),
      now: () => new Date("2026-07-24T12:00:00Z"),
    },
  );

  assert.deepEqual(delivered, ["2"]);
  assert.equal(result.discoveredCount, 4);
  assert.equal(result.notifiedCount, 1);
  assert.equal(result.filteredCount, 3);
  assert.deepEqual(
    Object.keys(state.files.get(config.deliveryStateFile).filtered).sort(),
    ["1", "3", "4"],
  );
  assert.equal(
    Object.keys(state.files.get(config.apartmentsStateFile).apartments).length,
    4,
  );
});

test("crawler stores converted AMD prices and delivers the original price data", async () => {
  const state = memoryState();
  const delivered = [];
  const exchangeRates = {
    fetchedAt: "2026-07-24T09:15:00.000Z",
    effectiveDate: "2026-07-24",
    rates: {
      USD: { amount: 1, rate: 365.87 },
      EUR: { amount: 1, rate: 416.43 },
      RUB: { amount: 1, rate: 4.6763 },
    },
  };
  const html = `
    <div id="contentr">
      <a class="fav-item-info-container" href="/ru/item/20">
        <div class="pt">Apartment 20</div><div class="p">$1,600</div>
        <div class="at">Кентрон, 2 ком., 75 кв.м., 11/14 этаж</div>
        <div class="d">Пятница, Июль 24, 2026, 14:31</div>
      </a>
    </div>`;

  const result = await crawlApartments(
    { ...config, initialPageCount: 1 },
    {
      ...state,
      exchangeRates,
      fetchPage: async () => new Response(html),
      filters: {
        ...emptyFilters(),
        price: { min: 580_000, max: 590_000 },
      },
      deliverApartment: async (apartment) =>
        delivered.push(structuredClone(apartment)),
      now: () => new Date("2026-07-24T12:00:00Z"),
    },
  );

  const stored = state.files.get(config.apartmentsStateFile).apartments["20"];
  assert.equal(result.notifiedCount, 1);
  assert.equal(state.files.get(config.apartmentsStateFile).version, 2);
  assert.deepEqual(stored.price, {
    amountAmd: 585_392,
    originalAmount: 1_600,
    originalCurrency: "USD",
    exchangeRate: 365.87,
    exchangeRateFetchedAt: "2026-07-24T09:15:00.000Z",
    exchangeRateEffectiveDate: "2026-07-24",
  });
  assert.deepEqual(delivered[0].price, stored.price);
});

test("crawler migrates legacy foreign prices with the current persisted rate", async () => {
  const legacyApartment = {
    itemId: "30",
    title: "Legacy apartment",
    price: { amount: 1_000, currency: "€" },
    location: "Кентрон",
    rooms: 2,
    areaSqM: 60,
    floor: "4/9",
    date: "Пятница, Июль 24, 2026, 14:31",
    firstSeenAt: "2026-07-24T08:00:00.000Z",
    url: "https://www.list.am/ru/item/30",
  };
  const state = memoryState({
    [config.apartmentsStateFile]: {
      version: 1,
      type: "list-am-apartments",
      urlTemplate: LIST_AM_URL_TEMPLATE,
      apartments: { 30: legacyApartment },
      apartmentOrder: ["30"],
    },
  });

  await crawlApartments(config, {
    ...state,
    exchangeRates: {
      fetchedAt: "2026-07-24T09:15:00.000Z",
      effectiveDate: "2026-07-24",
      rates: {
        USD: { amount: 1, rate: 365.87 },
        EUR: { amount: 1, rate: 416.43 },
        RUB: { amount: 1, rate: 4.6763 },
      },
    },
    fetchPage: async () =>
      new Response(`
        <div id="contentr">
          <a class="fav-item-info-container" href="/ru/item/30">
            <div class="pt">Legacy apartment</div><div class="p">€1,000</div>
            <div class="at">Кентрон, 2 ком., 60 кв.м., 4/9 этаж</div>
            <div class="d">Пятница, Июль 24, 2026, 14:31</div>
          </a>
          <a class="fav-item-info-container" href="/ru/item/29">
            <div class="pt">Older apartment</div><div class="p">200000 ֏</div>
            <div class="at">Кентрон, 2 ком., 60 кв.м., 4/9 этаж</div>
            <div class="d">Пятница, Июль 24, 2026, 14:30</div>
          </a>
        </div>`),
    now: () => new Date("2026-07-24T12:00:00Z"),
  });

  const migrated = state.files.get(config.apartmentsStateFile);
  assert.equal(migrated.version, 2);
  assert.deepEqual(migrated.apartments["30"].price, {
    amountAmd: 416_430,
    originalAmount: 1_000,
    originalCurrency: "EUR",
    exchangeRate: 416.43,
    exchangeRateFetchedAt: "2026-07-24T09:15:00.000Z",
    exchangeRateEffectiveDate: "2026-07-24",
  });
  assert.equal(
    migrated.apartments["30"].firstSeenAt,
    "2026-07-24T08:00:00.000Z",
  );
});

test("known cards update source data while preserving first-seen and price audit semantics", async () => {
  const firstSeenAt = "2026-07-24T08:00:00.000Z";
  const oldRateAt = "2026-07-23T09:15:00.000Z";
  const state = memoryState({
    [config.apartmentsStateFile]: {
      version: 2,
      type: "list-am-apartments",
      urlTemplate: LIST_AM_URL_TEMPLATE,
      apartments: {
        40: {
          itemId: "40",
          title: "Old title",
          price: {
            amountAmd: 365_000,
            originalAmount: 1_000,
            originalCurrency: "USD",
            exchangeRate: 365,
            exchangeRateFetchedAt: oldRateAt,
            exchangeRateEffectiveDate: "2026-07-23",
          },
          location: "Кентрон",
          rooms: 2,
          areaSqM: 60,
          floor: "4/9",
          date: "Пятница, Июль 24, 2026, 14:31",
          firstSeenAt,
          url: "https://www.list.am/ru/item/40",
        },
      },
      apartmentOrder: ["40"],
    },
  });
  const exchangeRates = {
    fetchedAt: "2026-07-24T09:15:00.000Z",
    effectiveDate: "2026-07-24",
    rates: {
      USD: { amount: 1, rate: 370 },
      EUR: { amount: 1, rate: 420 },
      RUB: { amount: 1, rate: 4.7 },
    },
  };

  const result = await crawlApartments(config, {
    ...state,
    exchangeRates,
    fetchPage: async () =>
      new Response(`
        <div id="contentr">
          <a class="fav-item-info-container" href="/ru/item/40">
            <div class="pt">New title</div><div class="p">$1,100</div>
            <div class="at">Кентрон, 3 ком., 65 кв.м., 5/9 этаж</div>
            <div class="d">Пятница, Июль 24, 2026, 14:32</div>
          </a>
          <a class="fav-item-info-container" href="/ru/item/39">
            <div class="pt">Older</div><div class="p">200000 ֏</div>
            <div class="at">Кентрон, 2 ком., 60 кв.м., 4/9 этаж</div>
            <div class="d">Пятница, Июль 24, 2026, 14:30</div>
          </a>
        </div>`),
    now: () => new Date("2026-07-24T12:00:00Z"),
  });

  const updated = state.files.get(config.apartmentsStateFile).apartments["40"];
  assert.equal(result.status, "updated-apartments");
  assert.equal(result.updatedCount, 1);
  assert.equal(updated.firstSeenAt, firstSeenAt);
  assert.equal(updated.updatedAt, "2026-07-24T12:00:00.000Z");
  assert.equal(updated.title, "New title");
  assert.equal(updated.rooms, 3);
  assert.deepEqual(updated.price, {
    amountAmd: 407_000,
    originalAmount: 1_100,
    originalCurrency: "USD",
    exchangeRate: 370,
    exchangeRateFetchedAt: exchangeRates.fetchedAt,
    exchangeRateEffectiveDate: exchangeRates.effectiveDate,
  });
});

import assert from "node:assert/strict";
import test from "node:test";

import { crawlApartments } from "../src/crawler.js";
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

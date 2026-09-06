import assert from "node:assert/strict";
import test from "node:test";

import { crawlApartments } from "../src/crawler.js";
import { emptyFilters } from "../src/filters.js";
import { PrivateDeliveryBarrier } from "../src/rate-limit.js";
import { ListAmIntegrityReason } from "../src/source-integrity.js";
import { LIST_AM_SOURCES, LIST_AM_URL_TEMPLATE } from "../src/target.js";
import { createMemoryStateAccess } from "../test-support/memory-state.js";

const config = {
  listUrlTemplate: LIST_AM_URL_TEMPLATE,
  initialPageCount: 10,
  addedCategoryPageCount: 2,
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

/** The redesigned card shape List.am publishes with no posting date at all. */
function undatedPage(...ids) {
  return `
    <div id="contentr">
      ${ids
        .map(
          (id) => `
            <a class="fav-item-info-container" href="/ru/item/${id}">
              <div class="dltitle"><div class="pt">Apartment ${id}</div></div>
              <div class="p">${id},000 ֏ monthly</div>
              <div class="at">Arabkir, 2 rm., 50 sq.m., 3/5 floor</div>
            </a>`,
        )
        .join("")}
    </div>`;
}

function memoryState(options = {}) {
  const access = createMemoryStateAccess({
    listUrlTemplate: config.listUrlTemplate,
    ...options,
  });
  return { stateAccess: access, stored: access.stored, writes: access.writes };
}

function defaultDeliveries(state) {
  return state.stored.recipients.default;
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
  assert.equal(Object.keys(state.stored.apartments.apartments).length, 10);
  assert.deepEqual(Object.keys(defaultDeliveries(state).skipped).sort(), [
    "10",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
  ]);

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

/** A configuration that reads both List.am categories, as production does. */
const bothCategories = { ...config, listSources: LIST_AM_SOURCES };

/** Serves each category its own pages, the way List.am paginates them. */
function categoryPages(pagesByKind) {
  return async (url) => {
    const [, category, page] = new URL(url).pathname.match(
      /\/category\/(\d+)\/(\d+)$/u,
    );
    const pages =
      pagesByKind[category === "1377" ? "house" : "apartment"] || [];
    return new Response(pages[Number(page) - 1] ?? '<div id="contentr"></div>');
  };
}

test("a crawl reads both categories and delivers each kind to whoever follows it", async () => {
  const state = memoryState();
  const delivered = { 42: [], 77: [], 99: [] };

  const result = await crawlApartments(
    { ...bothCategories, initialPageCount: 1 },
    {
      ...state,
      fetchPage: categoryPages({
        apartment: [datedPage(["10", "Пятница, Июль 24, 2026, 14:31"])],
        house: [
          datedPage(
            ["20", "Пятница, Июль 24, 2026, 14:40"],
            ["21", "Пятница, Июль 24, 2026, 14:20"],
          ),
        ],
      }),
      privateDeliveries: [
        // The default subscription follows apartments only.
        {
          recipientId: "42",
          filters: emptyFilters(),
          deliverApartment: async ({ itemId }) => delivered[42].push(itemId),
        },
        {
          recipientId: "77",
          filters: { ...emptyFilters(), kinds: ["house"] },
          deliverApartment: async ({ itemId }) => delivered[77].push(itemId),
        },
        {
          recipientId: "99",
          filters: { ...emptyFilters(), kinds: ["apartment", "house"] },
          deliverApartment: async ({ itemId }) => delivered[99].push(itemId),
        },
      ],
      now: () => new Date("2026-07-24T12:00:00Z"),
    },
  );

  assert.equal(result.discoveredCount, 3);
  assert.deepEqual(delivered[42], ["10"]);
  assert.deepEqual(delivered[77], ["21", "20"]);
  // Both categories form one newest-first stream, so a subscription following
  // both is delivered by posting date rather than category by category.
  assert.deepEqual(delivered[99], ["21", "10", "20"]);

  const stored = state.stored.apartments;
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(stored.apartments).map(([itemId, { kind }]) => [
        itemId,
        kind,
      ]),
    ),
    { 10: "apartment", 20: "house", 21: "house" },
  );
  assert.deepEqual(stored.apartmentOrder, ["20", "10", "21"]);
  assert.deepEqual(
    result.sources.map(({ kind }) => kind),
    ["apartment", "house"],
  );
  assert.deepEqual(stored.sourceIntegrity.recentFirstPageCounts, {
    apartment: [1],
    house: [2],
  });
});

test("a category added to a running installation starts from its own history", async () => {
  const state = memoryState({
    apartments: {
      version: 4,
      type: "list-am-apartments",
      urlTemplate: config.listUrlTemplate,
      checkedAt: "2026-07-24T11:00:00.000Z",
      lastCrawl: { initialRun: true, pagesParsed: 1 },
      apartments: {
        10: {
          itemId: "10",
          kind: "apartment",
          date: "Пятница, Июль 24, 2026, 14:31",
          firstSeenAt: "2026-07-24T10:00:00.000Z",
          lastSeenAt: "2026-07-24T11:00:00.000Z",
        },
      },
      apartmentOrder: ["10"],
      sourceIntegrity: {
        recentFirstPageCounts: { apartment: [1] },
        lastSuccessfulAt: "2026-07-24T11:00:00.000Z",
      },
    },
  });
  const fetched = [];

  const result = await crawlApartments(
    { ...bothCategories, initialPageCount: 3, addedCategoryPageCount: 3 },
    {
      ...state,
      fetchPage: async (url) => {
        fetched.push(url);
        return categoryPages({
          apartment: [
            datedPage(
              ["11", "Пятница, Июль 24, 2026, 15:00"],
              // Older than the apartment watermark: pagination stops here.
              ["9", "Пятница, Июль 24, 2026, 14:00"],
            ),
          ],
          house: [page("20"), page("21"), page("22")],
        })(url);
      },
      now: () => new Date("2026-07-24T12:00:00Z"),
    },
  );

  // Apartments keep their watermark; the new category runs its first crawl
  // over the initial page budget instead of inheriting that watermark.
  assert.deepEqual(
    fetched.map((url) => new URL(url).pathname),
    [
      "/ru/category/56/1",
      "/ru/category/1377/1",
      "/ru/category/1377/2",
      "/ru/category/1377/3",
    ],
  );
  assert.deepEqual(result.sources, [
    {
      kind: "apartment",
      initialRun: false,
      pagesParsed: 1,
      lastKnownDate: "Пятница, Июль 24, 2026, 14:31",
      stoppedAtKnownDate: "Пятница, Июль 24, 2026, 14:31",
      exhausted: false,
    },
    {
      kind: "house",
      initialRun: true,
      pagesParsed: 3,
      lastKnownDate: null,
      stoppedAtKnownDate: null,
      exhausted: false,
    },
  ]);
  assert.deepEqual(
    result.discovered.map(({ itemId, kind }) => `${kind}:${itemId}`),
    ["apartment:11", "house:20", "house:21", "house:22"],
  );
});

test("an added category keeps its first crawl inside the deployment window", async () => {
  const state = memoryState({
    apartments: {
      version: 4,
      type: "list-am-apartments",
      urlTemplate: config.listUrlTemplate,
      checkedAt: "2026-07-24T11:00:00.000Z",
      lastCrawl: { initialRun: true, pagesParsed: 1 },
      apartments: {
        10: {
          itemId: "10",
          kind: "apartment",
          date: "Пятница, Июль 24, 2026, 14:31",
          firstSeenAt: "2026-07-24T10:00:00.000Z",
          lastSeenAt: "2026-07-24T11:00:00.000Z",
        },
      },
      apartmentOrder: ["10"],
      sourceIntegrity: {
        recentFirstPageCounts: { apartment: [1] },
        lastSuccessfulAt: "2026-07-24T11:00:00.000Z",
      },
    },
  });
  const fetched = [];

  const result = await crawlApartments(
    { ...bothCategories, initialPageCount: 10, addedCategoryPageCount: 2 },
    {
      ...state,
      fetchPage: async (url) => {
        fetched.push(url);
        return categoryPages({
          apartment: [
            datedPage(
              ["11", "Пятница, Июль 24, 2026, 15:00"],
              ["9", "Пятница, Июль 24, 2026, 14:00"],
            ),
          ],
          house: Array.from({ length: 10 }, (_value, index) =>
            page(String(20 + index)),
          ),
        })(url);
      },
      now: () => new Date("2026-07-24T12:00:00Z"),
    },
  );

  // The category joining a populated installation takes the smaller budget,
  // not the ten pages a first installation is allowed. A first crawl that
  // cannot finish inside the candidate observation window persists nothing,
  // so an oversized one would restart unchanged on every later attempt.
  assert.deepEqual(
    fetched.map((url) => new URL(url).pathname),
    ["/ru/category/56/1", "/ru/category/1377/1", "/ru/category/1377/2"],
  );
  assert.equal(
    result.sources.find(({ kind }) => kind === "house").pagesParsed,
    2,
  );
  assert.deepEqual(
    result.discovered.map(({ itemId, kind }) => `${kind}:${itemId}`),
    ["apartment:11", "house:20", "house:21"],
  );
});

test("crawler consumes normalized apartments from page diagnostics", async () => {
  const state = memoryState();
  const result = await crawlApartments(
    { ...config, initialPageCount: 1 },
    {
      ...state,
      fetchPage: async () =>
        new Response(`
          <div id="contentr">
            <a class="fav-item-info-container" href="/ru/item/500">
              <div class="dltitle"><div class="pt">Apartment 500</div></div>
              <div class="d">Friday, July 24, 2026, 14:31</div>
            </a>
            <a class="fav-item-info-container" href="/ru/item/500">Duplicate</a>
          </div>`),
      now: () => new Date("2026-07-24T12:00:00Z"),
    },
  );

  assert.equal(result.discoveredCount, 1);
  assert.deepEqual(Object.keys(state.stored.apartments.apartments), ["500"]);
});

test("a later empty page is a valid pagination terminator", async () => {
  const state = memoryState();
  let fetchCount = 0;

  const result = await crawlApartments(config, {
    ...state,
    fetchPage: async () => {
      fetchCount += 1;
      return new Response(
        fetchCount === 1 ? page("700") : '<div id="contentr"></div>',
      );
    },
    now: () => new Date("2026-07-24T12:00:00Z"),
  });

  assert.equal(fetchCount, 2);
  assert.equal(result.pagesParsed, 2);
  assert.deepEqual(result.sources, [
    {
      kind: "apartment",
      initialRun: true,
      pagesParsed: 2,
      lastKnownDate: null,
      stoppedAtKnownDate: null,
      exhausted: true,
    },
  ]);
  assert.deepEqual(Object.keys(state.stored.apartments.apartments), ["700"]);
});

test("a late integrity failure leaves apartment, delivery, and channel state untouched", async () => {
  const state = memoryState();
  const privateSends = [];
  const channelCallbacks = [];
  const integrityChecks = [];
  let fetchCount = 0;
  const invalidRepeatedPage = page("800").replace(
    /\s*<\/div>\s*$/u,
    '<a class="fav-item-info-container" href="/item/invalid">Rejected</a></div>',
  );

  await assert.rejects(
    crawlApartments(
      { ...config, initialPageCount: 2 },
      {
        ...state,
        fetchPage: async () => {
          fetchCount += 1;
          return new Response(
            fetchCount === 1 ? page("800") : invalidRepeatedPage,
          );
        },
        deliverApartment: async (...arguments_) =>
          privateSends.push(arguments_),
        afterStateSaved: async (...arguments_) =>
          channelCallbacks.push(arguments_),
        onSourceIntegrityChecked: async (observation) =>
          integrityChecks.push(observation),
      },
    ),
    (error) =>
      error.reason === ListAmIntegrityReason.IDENTITY_REJECTION &&
      error.page === 2,
  );

  assert.equal(fetchCount, 2);
  assert.deepEqual(state.writes, []);
  assert.deepEqual(privateSends, []);
  assert.deepEqual(channelCallbacks, []);
  assert.deepEqual(integrityChecks, []);
  assert.equal(state.stored.apartments, undefined);
  assert.deepEqual(state.stored.recipients, {});
});

test("integrity validation precedes posting-date watermark termination", async () => {
  const apartmentSeed = {
    version: 2,
    type: "list-am-apartments",
    urlTemplate: config.listUrlTemplate,
    apartments: {
      900: {
        itemId: "900",
        date: "Friday, July 24, 2026, 14:31",
        firstSeenAt: "2026-07-24T10:00:00.000Z",
      },
    },
    apartmentOrder: ["900"],
  };
  const state = memoryState({ apartments: apartmentSeed });
  const invalidWatermarkPage = datedPage([
    "899",
    "Friday, July 24, 2026, 14:30",
  ]).replace(
    /\s*<\/div>\s*$/u,
    '<a class="fav-item-info-container" href="/item/invalid">Rejected</a></div>',
  );

  await assert.rejects(
    crawlApartments(config, {
      ...state,
      fetchPage: async () => new Response(invalidWatermarkPage),
    }),
    (error) =>
      error.reason === ListAmIntegrityReason.IDENTITY_REJECTION &&
      error.page === 1,
  );
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.stored.apartments, apartmentSeed);
});

test("successful crawls atomically retain the five newest first-page counts", async () => {
  const apartmentSeed = {
    version: 3,
    type: "list-am-apartments",
    urlTemplate: config.listUrlTemplate,
    apartments: {},
    apartmentOrder: [],
    sourceIntegrity: {
      recentFirstPageCounts: [5, 4, 3, 2, 1],
      lastSuccessfulAt: "2026-07-24T11:00:00.000Z",
    },
  };
  const state = memoryState({ apartments: apartmentSeed });

  await crawlApartments(
    { ...config, initialPageCount: 1 },
    {
      ...state,
      fetchPage: async () => new Response(page("1001", "1002", "1003")),
      now: () => new Date("2026-07-24T12:00:00.000Z"),
    },
  );

  const stored = state.stored.apartments;
  assert.equal(stored.version, 4);
  assert.deepEqual(stored.sourceIntegrity, {
    recentFirstPageCounts: { apartment: [4, 3, 2, 1, 3] },
    lastSuccessfulAt: "2026-07-24T12:00:00.000Z",
  });
});

test("restart reuses the baseline and a failure cannot advance it", async () => {
  const apartmentSeed = {
    version: 3,
    type: "list-am-apartments",
    urlTemplate: config.listUrlTemplate,
    apartments: {},
    apartmentOrder: [],
    sourceIntegrity: {
      recentFirstPageCounts: [20, 20, 20],
      lastSuccessfulAt: "2026-07-24T11:00:00.000Z",
    },
  };
  const state = memoryState({ apartments: apartmentSeed });
  const ids = Array.from({ length: 9 }, (_value, index) =>
    String(1100 + index),
  );

  await assert.rejects(
    crawlApartments(
      { ...config, initialPageCount: 1 },
      {
        ...state,
        fetchPage: async () => new Response(page(...ids)),
      },
    ),
    (error) => error.reason === ListAmIntegrityReason.FIRST_PAGE_COUNT_DROP,
  );

  assert.deepEqual(state.stored.apartments, apartmentSeed);
});

test("a failed apartment-state commit cannot advance count history", async () => {
  const apartmentSeed = {
    version: 3,
    type: "list-am-apartments",
    urlTemplate: config.listUrlTemplate,
    apartments: {},
    apartmentOrder: [],
    sourceIntegrity: {
      recentFirstPageCounts: [3, 3, 3],
      lastSuccessfulAt: "2026-07-24T11:00:00.000Z",
    },
  };
  const state = memoryState({
    apartments: apartmentSeed,
    onWrite: (domain) => {
      if (domain === "apartments") {
        throw new Error("durable apartment write failed");
      }
    },
  });

  await assert.rejects(
    crawlApartments(
      { ...config, initialPageCount: 1 },
      {
        ...state,
        fetchPage: async () => new Response(page("1201", "1202", "1203")),
        now: () => new Date("2026-07-24T12:00:00.000Z"),
      },
    ),
    /durable apartment write failed/u,
  );

  assert.deepEqual(state.stored.apartments, apartmentSeed);
});

test("crawler fails closed on a malformed version-three baseline", async () => {
  const apartmentSeed = {
    version: 3,
    type: "list-am-apartments",
    urlTemplate: config.listUrlTemplate,
    apartments: {},
    apartmentOrder: [],
    sourceIntegrity: { recentFirstPageCounts: [1, 2, 3, 4, 5, 6] },
  };
  const state = memoryState({ apartments: apartmentSeed });
  let fetched = false;

  await assert.rejects(
    crawlApartments(config, {
      ...state,
      fetchPage: async () => {
        fetched = true;
        return new Response(page("1"));
      },
    }),
    (error) => error.code === "ERR_STATE_INCOMPATIBLE",
  );
  assert.equal(fetched, false);
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.stored.apartments, apartmentSeed);
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
    apartments: known,
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
  assert.equal(
    result.sources[0].lastKnownDate,
    "Пятница, Июль 24, 2026, 14:31",
  );
  assert.equal(
    result.sources[0].stoppedAtKnownDate,
    "Пятница, Июль 24, 2026, 14:31",
  );
  assert.deepEqual(
    result.discovered.map(({ itemId }) => itemId),
    ["101", "100", "91"],
  );
  assert.equal(state.stored.apartments.apartments["80"], undefined);
});

test("a known ad encountered at the date watermark records a durable last-seen time", async () => {
  const state = memoryState();
  await crawlApartments(
    { ...config, initialPageCount: 1 },
    {
      ...state,
      fetchPage: async () =>
        new Response(
          datedPage(
            ["2", "Пятница, Июль 24, 2026, 14:31"],
            ["1", "Пятница, Июль 24, 2026, 14:30"],
          ),
        ),
      now: () => new Date("2026-07-24T12:00:00Z"),
    },
  );

  await crawlApartments(config, {
    ...state,
    // A renewed ad may be moved to the front without changing its displayed
    // date or any other rendered source field.
    fetchPage: async () =>
      new Response(datedPage(["1", "Пятница, Июль 24, 2026, 14:30"])),
    now: () => new Date("2026-07-24T12:01:00Z"),
  });

  const stored = state.stored.apartments;
  assert.equal(stored.apartments["1"].lastSeenAt, "2026-07-24T12:01:00.000Z");
  assert.equal(stored.apartments["1"].updatedAt, undefined);
  assert.equal(
    stored.lastCrawl.sources[0].stoppedAtKnownDate,
    stored.lastCrawl.sources[0].lastKnownDate,
  );
});

test("a failed Telegram delivery remains pending without losing discovery", async () => {
  const state = memoryState();
  const firstAttempts = [];
  const integrityChecks = [];

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
        onSourceIntegrityChecked: async (observation) =>
          integrityChecks.push(observation),
        now: () => new Date("2026-07-24T12:00:00Z"),
      },
    ),
    /Telegram unavailable/,
  );

  assert.deepEqual(firstAttempts, ["1", "2"]);
  assert.equal(integrityChecks.length, 1);
  assert.equal(integrityChecks[0].pages[0].parsedCount, 3);
  assert.equal(JSON.stringify(integrityChecks).includes("apartments"), false);
  assert.deepEqual(Object.keys(state.stored.apartments.apartments).sort(), [
    "1",
    "2",
    "3",
  ]);
  assert.deepEqual(Object.keys(defaultDeliveries(state).notified), ["1"]);

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
  assert.deepEqual(Object.keys(defaultDeliveries(state).filtered).sort(), [
    "1",
    "3",
    "4",
  ]);
  assert.equal(Object.keys(state.stored.apartments.apartments).length, 4);
});

test("an updated filtered apartment is readmitted privately when it now matches", async () => {
  const state = memoryState();
  const filters = {
    ...emptyFilters(),
    price: { min: null, max: 250_000 },
  };
  const listingPage = (price) => `
    <div id="contentr">
      <a class="fav-item-info-container" href="/ru/item/51">
        <div class="pt">Apartment 51</div><div class="p">${price} ֏</div>
        <div class="at">Кентрон, 2 ком., 50 кв.м., 3/5 этаж</div>
        <div class="d">Пятница, Июль 24, 2026, 14:31</div>
      </a>
    </div>`;

  await crawlApartments(
    { ...config, initialPageCount: 1 },
    {
      ...state,
      filters,
      fetchPage: async () => new Response(listingPage("300000")),
      deliverApartment: async () => {
        throw new Error("A filtered apartment must not be delivered");
      },
      now: () => new Date("2026-07-24T12:00:00.000Z"),
    },
  );
  assert.ok(defaultDeliveries(state).filtered["51"]);

  const delivered = [];
  const updatedResult = await crawlApartments(config, {
    ...state,
    filters,
    fetchPage: async () => new Response(listingPage("220000")),
    deliverApartment: async ({ itemId }) => delivered.push(itemId),
    now: () => new Date("2026-07-24T12:01:00.000Z"),
  });

  assert.deepEqual(delivered, ["51"]);
  assert.equal(updatedResult.notifiedCount, 1);
  assert.equal(updatedResult.readmittedCount, 1);
  assert.equal(defaultDeliveries(state).filtered["51"], undefined);
  assert.ok(defaultDeliveries(state).notified["51"]);
});

test("a widened filter releases nothing until List.am touches the card", async () => {
  const state = memoryState();
  let filters = { ...emptyFilters(), price: { min: null, max: 250_000 } };
  const card = ([id, date, price]) => `
      <a class="fav-item-info-container" href="/ru/item/${id}">
        <div class="pt">Apartment ${id}</div><div class="p">${price} ֏</div>
        <div class="at">Кентрон, 2 ком., 50 кв.м., 3/5 этаж</div>
        <div class="d">${date}</div>
      </a>`;
  const listing = (...cards) =>
    `<div id="contentr">${cards.map(card).join("")}</div>`;
  const delivered = [];
  const crawl = (html, at) =>
    crawlApartments(
      { ...config, initialPageCount: 1 },
      {
        ...state,
        filters,
        fetchPage: async () => new Response(html),
        deliverApartment: async ({ itemId }) => delivered.push(itemId),
        now: () => new Date(at),
      },
    );

  const posted = {
    2: "Вторник, Июль 21, 2026, 11:00",
    1: "Вторник, Июль 21, 2026, 10:00",
    3: "Пятница, Июль 24, 2026, 09:00",
  };
  // Three days before the filter change: 2 is delivered, 1 is rejected.
  await crawl(
    listing(["2", posted[2], "200000"], ["1", posted[1], "300000"]),
    "2026-07-21T12:00:00.000Z",
  );
  assert.deepEqual(delivered, ["2"]);
  assert.ok(defaultDeliveries(state).filtered["1"]);

  // Two days before it, List.am reprices both beyond the current filter.
  const repriced = await crawl(
    listing(["2", posted[2], "300000"], ["1", posted[1], "310000"]),
    "2026-07-22T12:00:00.000Z",
  );
  assert.equal(repriced.updatedCount, 2);
  assert.deepEqual(delivered, ["2"]);

  // Hours before it, 3 is discovered and rejected by the same filter.
  await crawl(
    listing(
      ["3", posted[3], "320000"],
      ["2", posted[2], "300000"],
      ["1", posted[1], "310000"],
    ),
    "2026-07-24T12:00:00.000Z",
  );
  assert.ok(defaultDeliveries(state).filtered["3"]);

  // The widened filter now admits all three, and the crawl releases none of
  // them: a filter edit is the user's own doing, so the menu asks before that
  // history is sent. Their rejections stand until List.am touches the cards.
  filters = { ...emptyFilters(), price: { min: null, max: 400_000 } };
  const widened = await crawl(
    listing(
      ["3", posted[3], "320000"],
      ["2", posted[2], "300000"],
      ["1", posted[1], "310000"],
    ),
    "2026-07-24T12:05:00.000Z",
  );
  assert.deepEqual(delivered, ["2"]);
  assert.equal(widened.readmittedCount, 0);
  assert.ok(defaultDeliveries(state).filtered["3"]);
  assert.ok(defaultDeliveries(state).filtered["1"]);

  // A fresh List.am change releases the older rejected apartment after all.
  const renewed = await crawl(
    listing(["3", posted[3], "320000"], ["1", posted[1], "330000"]),
    "2026-07-24T12:10:00.000Z",
  );
  assert.equal(renewed.updatedCount, 1);
  assert.equal(renewed.readmittedCount, 1);
  assert.deepEqual(delivered, ["2", "1"]);
  assert.ok(defaultDeliveries(state).notified["1"]);
  // The delivered apartment carrying only a stale update stays quiet.
  assert.equal(
    defaultDeliveries(state).notified["2"],
    "2026-07-21T12:00:00.000Z",
  );
});

test("one crawl maintains independent delivery histories for multiple users", async () => {
  const state = memoryState();
  const delivered = { 42: [], 99: [] };

  const result = await crawlApartments(
    { ...config, initialPageCount: 1 },
    {
      ...state,
      fetchPage: async () => new Response(page("3", "2", "1")),
      privateDeliveries: [
        {
          recipientId: "42",
          filters: emptyFilters(),
          deliverApartment: async ({ itemId }) => delivered[42].push(itemId),
        },
        {
          recipientId: "99",
          filters: { rooms: { min: 3, max: 3 } },
          deliverApartment: async ({ itemId }) => delivered[99].push(itemId),
        },
      ],
      now: () => new Date("2026-07-24T12:00:00Z"),
    },
  );

  assert.deepEqual(delivered[42], ["1", "2", "3"]);
  assert.deepEqual(delivered[99], []);
  assert.equal(result.notifiedCount, 3);
  const recipients = state.stored.recipients;
  assert.deepEqual(Object.keys(recipients["42"].notified), ["1", "2", "3"]);
  assert.deepEqual(Object.keys(recipients["99"].filtered).sort(), [
    "1",
    "2",
    "3",
  ]);
});

test("slow recipients do not block peers or channel publication", async () => {
  const delivered = { 42: [], 99: [] };
  let releaseSlowRecipient;
  const slowRecipientReleased = new Promise((resolve) => {
    releaseSlowRecipient = resolve;
  });
  let slowRecipientStarted;
  const slowRecipientReady = new Promise((resolve) => {
    slowRecipientStarted = resolve;
  });
  let peerFinished;
  const peerReady = new Promise((resolve) => {
    peerFinished = resolve;
  });
  let deliveryWrites = 0;
  let concurrentDeliveryWrites = 0;
  let maximumConcurrentDeliveryWrites = 0;
  let channelPublished = false;
  // Every delivery decision yields inside its write, so an unserialized second
  // writer would overlap with it and raise the observed concurrency.
  const state = memoryState({
    onWrite: async (domain) => {
      if (domain !== "privateDeliveries") return;
      deliveryWrites += 1;
      concurrentDeliveryWrites += 1;
      maximumConcurrentDeliveryWrites = Math.max(
        maximumConcurrentDeliveryWrites,
        concurrentDeliveryWrites,
      );
      await Promise.resolve();
      concurrentDeliveryWrites -= 1;
    },
  });

  const crawling = crawlApartments(
    { ...config, initialPageCount: 1 },
    {
      ...state,
      fetchPage: async () => new Response(page("3", "2", "1")),
      privateDeliveries: [
        {
          recipientId: "42",
          deliverApartment: async ({ itemId }) => {
            delivered[42].push(itemId);
            if (itemId === "1") {
              slowRecipientStarted();
              await slowRecipientReleased;
            }
          },
        },
        {
          recipientId: "99",
          deliverApartment: async ({ itemId }) => {
            delivered[99].push(itemId);
            if (itemId === "3") peerFinished();
          },
        },
      ],
      afterStateSaved: async () => {
        channelPublished = true;
      },
      now: () => new Date("2026-07-24T12:00:00Z"),
    },
  );

  await slowRecipientReady;
  await peerReady;
  assert.equal(channelPublished, true);
  assert.deepEqual(delivered[42], ["1"]);
  assert.deepEqual(delivered[99], ["1", "2", "3"]);

  releaseSlowRecipient();
  const result = await crawling;
  assert.deepEqual(delivered[42], ["1", "2", "3"]);
  assert.equal(result.notifiedCount, 6);
  assert.ok(deliveryWrites > 0);
  assert.equal(maximumConcurrentDeliveryWrites, 1);
  const recipients = state.stored.recipients;
  assert.deepEqual(Object.keys(recipients[42].notified), ["1", "2", "3"]);
  assert.deepEqual(Object.keys(recipients[99].notified), ["1", "2", "3"]);
});

test("deletion drains target acknowledgements without blocking peers or channel", async () => {
  const state = memoryState();
  const barrier = new PrivateDeliveryBarrier();
  let deliveryStateMutation = Promise.resolve();
  const mutateDeliveryState = (operation) => {
    const pending = deliveryStateMutation.then(operation);
    deliveryStateMutation = pending.catch(() => {});
    return pending;
  };
  let targetAuthorized = true;
  let releaseTarget;
  const targetReleased = new Promise((resolve) => {
    releaseTarget = resolve;
  });
  let targetStarted;
  const targetReady = new Promise((resolve) => {
    targetStarted = resolve;
  });
  let peerCompleted;
  const peerReady = new Promise((resolve) => {
    peerCompleted = resolve;
  });
  let channelPublished = false;

  const crawling = crawlApartments(
    { ...config, initialPageCount: 1 },
    {
      ...state,
      deliveryStateMutation: mutateDeliveryState,
      fetchPage: async () => new Response(page("2", "1")),
      privateDeliveries: [
        {
          recipientId: "42",
          isAuthorized: () => targetAuthorized,
          runDeliveryWorker: (operation) => barrier.run("42", operation),
          deliverApartment: async () => {
            targetStarted();
            await targetReleased;
          },
        },
        {
          recipientId: "99",
          deliverApartment: async ({ itemId }) => {
            if (itemId === "2") peerCompleted();
          },
        },
      ],
      afterStateSaved: async () => {
        channelPublished = true;
      },
      now: () => new Date("2026-07-24T12:00:00Z"),
    },
  );

  await targetReady;
  targetAuthorized = false;
  barrier.block("42");
  const drained = barrier.drain("42");
  await peerReady;
  assert.equal(channelPublished, true);
  releaseTarget();
  await drained;
  await mutateDeliveryState(() => state.stateAccess.deleteUserData("42"));
  barrier.clear("42");
  await crawling;

  const recipients = state.stored.recipients;
  assert.equal(recipients[42], undefined);
  assert.deepEqual(Object.keys(recipients[99].notified), ["1", "2"]);
});

test("private delivery rechecks live authorization without blocking peers", async () => {
  const state = memoryState();
  const delivered = { 7: [], 42: [], 99: [] };
  let user99Authorized = true;

  await crawlApartments(
    { ...config, initialPageCount: 1 },
    {
      ...state,
      fetchPage: async () => new Response(page("3", "2", "1")),
      privateDeliveries: [
        {
          recipientId: "42",
          isAuthorized: () => false,
          deliverApartment: async ({ itemId }) => delivered[42].push(itemId),
        },
        {
          recipientId: "99",
          isAuthorized: () => user99Authorized,
          deliverApartment: async ({ itemId }) => {
            delivered[99].push(itemId);
            user99Authorized = false;
          },
        },
        {
          recipientId: "7",
          isAuthorized: () => true,
          deliverApartment: async ({ itemId }) => delivered[7].push(itemId),
        },
      ],
      now: () => new Date("2026-07-24T12:00:00Z"),
    },
  );

  assert.deepEqual(delivered[42], []);
  assert.deepEqual(delivered[99], ["1"]);
  assert.deepEqual(delivered[7], ["1", "2", "3"]);
  const recipients = state.stored.recipients;
  assert.equal(recipients[42], undefined);
  assert.deepEqual(Object.keys(recipients[99].notified), ["1"]);
  assert.deepEqual(Object.keys(recipients[7].notified), ["1", "2", "3"]);
});

test("a user can skip the initial selection and receive later apartments", async () => {
  const state = memoryState();
  const delivered = [];
  const privateDelivery = {
    recipientId: "42",
    filters: emptyFilters(),
    sendInitialApartments: false,
    deliverApartment: async ({ itemId }) => delivered.push(itemId),
  };

  const initialResult = await crawlApartments(
    { ...config, initialPageCount: 1 },
    {
      ...state,
      fetchPage: async () => new Response(page("3", "2", "1")),
      privateDeliveries: [privateDelivery],
      now: () => new Date("2026-07-24T12:00:00Z"),
    },
  );

  assert.deepEqual(delivered, []);
  assert.equal(initialResult.notifiedCount, 0);
  assert.equal(initialResult.skippedCount, 3);
  assert.deepEqual(Object.keys(state.stored.recipients["42"].skipped).sort(), [
    "1",
    "2",
    "3",
  ]);

  const laterResult = await crawlApartments(config, {
    ...state,
    fetchPage: async () => new Response(page("4", "3", "2", "1")),
    privateDeliveries: [privateDelivery],
    now: () => new Date("2026-07-24T12:01:00Z"),
  });

  assert.deepEqual(delivered, ["4"]);
  assert.equal(laterResult.notifiedCount, 1);
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

  const stored = state.stored.apartments.apartments["20"];
  assert.equal(result.notifiedCount, 1);
  assert.equal(state.stored.apartments.version, 4);
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
    apartments: {
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

  const migrated = state.stored.apartments;
  assert.equal(migrated.version, 4);
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
    apartments: {
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

  const updated = state.stored.apartments.apartments["40"];
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

test("an updated apartment is delivered again privately when it still matches filters", async () => {
  const state = memoryState();
  const filters = {
    ...emptyFilters(),
    rooms: { min: 2, max: 2 },
  };
  const listingPage = (title, rooms = 2) => `
    <div id="contentr">
      <a class="fav-item-info-container" href="/ru/item/50">
        <div class="pt">${title}</div><div class="p">250000 ֏</div>
        <div class="at">Кентрон, ${rooms} ком., 60 кв.м., 4/9 этаж</div>
        <div class="d">Пятница, Июль 24, 2026, 14:31</div>
      </a>
    </div>`;
  const delivered = [];

  await crawlApartments(
    { ...config, initialPageCount: 1 },
    {
      ...state,
      filters,
      fetchPage: async () => new Response(listingPage("Original title")),
      deliverApartment: async ({ title }) => delivered.push(title),
      now: () => new Date("2026-07-24T12:00:00.000Z"),
    },
  );

  await assert.rejects(
    crawlApartments(config, {
      ...state,
      filters,
      fetchPage: async () => new Response(listingPage("Updated title")),
      deliverApartment: async () => {
        throw new Error("Telegram unavailable");
      },
      now: () => new Date("2026-07-24T12:01:00.000Z"),
    }),
    /Telegram unavailable/u,
  );
  assert.equal(
    defaultDeliveries(state).notified["50"],
    "2026-07-24T12:00:00.000Z",
  );

  const retry = await crawlApartments(config, {
    ...state,
    filters,
    fetchPage: async () => new Response(listingPage("Updated title")),
    deliverApartment: async ({ title }) => delivered.push(title),
    now: () => new Date("2026-07-24T12:02:00.000Z"),
  });

  assert.equal(retry.notifiedCount, 1);
  assert.deepEqual(delivered, ["Original title", "Updated title"]);
  assert.equal(
    defaultDeliveries(state).notified["50"],
    "2026-07-24T12:02:00.000Z",
  );

  const filteredUpdate = await crawlApartments(config, {
    ...state,
    filters,
    fetchPage: async () =>
      new Response(listingPage("Updated to three rooms", 3)),
    deliverApartment: async () => {
      throw new Error("A non-matching update must not be delivered");
    },
    now: () => new Date("2026-07-24T12:03:00.000Z"),
  });

  assert.equal(filteredUpdate.updatedCount, 1);
  assert.equal(filteredUpdate.notifiedCount, 0);
  assert.deepEqual(delivered, ["Original title", "Updated title"]);
});

test("a monitoring answer only decides the last day of matching history", async () => {
  const state = memoryState();
  const delivered = [];
  const announced = [];
  const listing = datedPage(
    ["9", "Пятница, Июль 24, 2026, 09:00"],
    ["8", "Понедельник, Июль 20, 2026, 09:00"],
  );

  const result = await crawlApartments(
    { ...config, initialPageCount: 1 },
    {
      ...state,
      fetchPage: async () => new Response(listing),
      privateDeliveries: [
        {
          recipientId: "42",
          filters: emptyFilters(),
          sendInitialApartments: true,
          announceDelivery: async ({ count }) => announced.push(count),
          deliverApartment: async ({ itemId }) => delivered.push(itemId),
        },
      ],
      now: () => new Date("2026-07-24T12:00:00Z"),
    },
  );

  // Accepting history buys the current day of it, not everything List.am has
  // published, so the four-day-old match is never sent.
  assert.deepEqual(delivered, ["9"]);
  assert.deepEqual(announced, [1]);
  assert.equal(result.notifiedCount, 1);
  const recipient = state.stored.recipients["42"];
  assert.ok(recipient.notified["9"]);
  // Nothing was decided about the older match: a List.am update can still
  // bring it back inside the window and deliver it as fresh activity.
  assert.equal(recipient.skipped["8"], undefined);
  assert.equal(recipient.filtered["8"], undefined);
});

test("a restart decides the paused backlog and announces what it sends", async () => {
  const state = memoryState();
  const delivered = [];
  const announced = [];
  const target = (sendInitialApartments) => ({
    recipientId: "42",
    filters: emptyFilters(),
    sendInitialApartments,
    announceDelivery: async ({ count }) => announced.push(count),
    deliverApartment: async ({ itemId }) => delivered.push(itemId),
  });
  const crawl = (html, at, privateDeliveries) =>
    crawlApartments(
      { ...config, initialPageCount: 1 },
      {
        ...state,
        fetchPage: async () => new Response(html),
        ...(privateDeliveries ? { privateDeliveries } : {}),
        now: () => new Date(at),
      },
    );

  await crawl(page("1"), "2026-07-24T12:00:00Z", [target(true)]);
  assert.deepEqual(delivered, ["1"]);
  assert.deepEqual(announced, [1]);

  // Monitoring is stopped: the crawl keeps running for other recipients and
  // this user is classified by nothing.
  await crawl(page("3", "2", "1"), "2026-07-24T12:05:00Z");
  assert.equal(state.stored.recipients["42"].skipped["2"], undefined);

  // Restarting reopens the selection gate the way the bot does when the user
  // answers the question again. Declining leaves the backlog skipped for good.
  await state.stateAccess.privateDeliveries.decisions.requestSelection("42");
  const restarted = await crawl(page("3", "2", "1"), "2026-07-24T12:10:00Z", [
    target(false),
  ]);
  assert.deepEqual(delivered, ["1"]);
  assert.equal(restarted.skippedCount, 2);
  assert.deepEqual(Object.keys(state.stored.recipients["42"].skipped).sort(), [
    "2",
    "3",
  ]);

  // A listing discovered after the answer is news: it arrives on its own,
  // without a heads-up message ahead of it.
  await crawl(page("4", "3", "2", "1"), "2026-07-24T12:15:00Z", [
    target(false),
  ]);
  assert.deepEqual(delivered, ["1", "4"]);
  assert.deepEqual(announced, [1]);

  // So does a card List.am changes in the very crawl that redelivers it.
  const bumped = datedPage(
    ["4", "Пятница, Июль 24, 2026, 15:00"],
    ["3", "Пятница, Июль 24, 2026, 14:31"],
    ["2", "Пятница, Июль 24, 2026, 14:31"],
    ["1", "Пятница, Июль 24, 2026, 14:31"],
  );
  const bumpedResult = await crawl(bumped, "2026-07-24T12:20:00Z", [
    target(false),
  ]);
  assert.equal(bumpedResult.updatedCount, 1);
  assert.deepEqual(delivered, ["1", "4", "4"]);
  assert.deepEqual(announced, [1]);
});

test("a declined restart keeps what List.am changed during the pause", async () => {
  const state = memoryState();
  const filters = { ...emptyFilters(), price: { min: null, max: 250_000 } };
  const listing = (price) => `
    <div id="contentr">
      <a class="fav-item-info-container" href="/ru/item/61">
        <div class="pt">Apartment 61</div><div class="p">${price} ֏</div>
        <div class="at">Кентрон, 2 ком., 50 кв.м., 3/5 этаж</div>
        <div class="d">Пятница, Июль 24, 2026, 14:31</div>
      </a>
    </div>`;
  const delivered = [];
  const crawl = (price, at, monitoring) =>
    crawlApartments(
      { ...config, initialPageCount: 1 },
      {
        ...state,
        fetchPage: async () => new Response(listing(price)),
        ...(monitoring
          ? {
              privateDeliveries: [
                {
                  recipientId: "42",
                  filters,
                  sendInitialApartments: false,
                  deliverApartment: async ({ itemId }) =>
                    delivered.push(itemId),
                },
              ],
            }
          : {}),
        now: () => new Date(at),
      },
    );

  await crawl("300000", "2026-07-24T12:00:00Z", true);
  assert.ok(state.stored.recipients["42"].filtered["61"]);

  // While monitoring is off, List.am reprices the card into the filter. That
  // change would release it on its own for an active user.
  await crawl("200000", "2026-07-24T12:05:00Z");

  // The restart answer decides it first, and a declined apartment stays
  // declined: the rejection it carried must not readmit it behind the answer.
  await state.stateAccess.privateDeliveries.decisions.requestSelection("42");
  const restarted = await crawl("200000", "2026-07-24T12:10:00Z", true);

  assert.deepEqual(delivered, []);
  assert.equal(restarted.readmittedCount, 0);
  assert.equal(restarted.notifiedCount, 0);
  assert.ok(state.stored.recipients["42"].skipped["61"]);
  assert.equal(state.stored.recipients["42"].filtered["61"], undefined);
});

test("crawler reads only the delivery targets' own decision history", async () => {
  // A peer whose history has nothing to do with this crawl. The decision table
  // holds every answer the installation ever recorded, so a crawl that reads
  // it whole puts an unbounded, ever-growing read on the event loop the
  // browser's CDP client shares — and reads rows no worker is entitled to.
  const state = memoryState({
    deliveries: {
      42: { initialSelectionApplied: true },
      99: {
        initialSelectionApplied: true,
        notified: Object.fromEntries(
          Array.from({ length: 500 }, (_, index) => [
            String(index),
            "2026-07-24T10:00:00.000Z",
          ]),
        ),
      },
    },
  });
  const wholeTableReads = [];
  const recipientReads = [];
  const stateAccess = {
    ...state.stateAccess,
    privateDeliveries: {
      ...state.stateAccess.privateDeliveries,
      load: async () => {
        wholeTableReads.push("load");
        return state.stateAccess.privateDeliveries.load();
      },
      loadRecipient: async (recipientId) => {
        recipientReads.push(String(recipientId));
        return state.stateAccess.privateDeliveries.loadRecipient(recipientId);
      },
    },
  };

  await crawlApartments(config, {
    stateAccess,
    fetchPage: async () => new Response(page("61")),
    privateDeliveries: [
      {
        recipientId: "42",
        filters: emptyFilters(),
        deliverApartment: async () => {},
      },
    ],
    now: () => new Date("2026-07-24T14:35:00Z"),
  });

  assert.deepEqual(wholeTableReads, []);
  assert.deepEqual(recipientReads, ["42"]);
});

test("a card without a posting date is dated by the crawl and delivered", async () => {
  const state = memoryState();
  const delivered = [];

  const result = await crawlApartments(
    { ...config, initialPageCount: 1 },
    {
      ...state,
      fetchPage: async () => new Response(undatedPage("1")),
      deliverApartment: async ({ itemId }) => delivered.push(itemId),
      now: () => new Date("2026-09-05T22:15:00Z"),
    },
  );

  assert.equal(result.discoveredCount, 1);
  assert.deepEqual(delivered, ["1"]);
  assert.equal(
    state.stored.apartments.apartments["1"].date,
    "Суббота, Сентябрь 05, 2026, 22:15",
    "the crawl dates an undated card with its own timestamp",
  );
});

test("a date the crawl supplied is kept, so the card never reads as changed", async () => {
  const state = memoryState();
  const delivered = [];
  const crawl = (isoNow) =>
    crawlApartments(
      { ...config, initialPageCount: 1 },
      {
        ...state,
        fetchPage: async () => new Response(undatedPage("1")),
        deliverApartment: async ({ itemId }) => delivered.push(itemId),
        now: () => new Date(isoNow),
      },
    );

  await crawl("2026-09-05T22:15:00Z");
  // The next crawl runs on a later calendar day: restamping would move the
  // date, report the card as changed, and deliver it again on every pass.
  const second = await crawl("2026-09-06T09:00:00Z");

  assert.equal(second.updatedCount, 0);
  assert.deepEqual(delivered, ["1"]);
  assert.equal(
    state.stored.apartments.apartments["1"].date,
    "Суббота, Сентябрь 05, 2026, 22:15",
  );
});

test("an undated card is discovered behind same-day cards the source dated", async () => {
  const state = memoryState();
  const delivered = [];
  const crawl = (html, isoNow) =>
    crawlApartments(
      { ...config, initialPageCount: 1 },
      {
        ...state,
        fetchPage: async () => new Response(html),
        deliverApartment: async ({ itemId }) => delivered.push(itemId),
        now: () => new Date(isoNow),
      },
    );

  // The watermark is now the end of 5 September, because that is where a card
  // printed with today's date resolves to.
  await crawl(datedPage(["1", "Сегодня, 18:57"]), "2026-09-05T19:00:00Z");
  assert.deepEqual(delivered, ["1"]);

  // A supplied date names 22:15, which is below that watermark. Weighing it
  // there would read the card as history and abandon the page behind it.
  const second = await crawl(
    `${undatedPage("2")}${datedPage(["3", "Сегодня, 17:00"])}`,
    "2026-09-05T22:15:00Z",
  );

  assert.equal(second.discoveredCount, 1);
  assert.deepEqual(delivered, ["1", "2"]);
});

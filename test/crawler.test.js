import assert from "node:assert/strict";
import test from "node:test";

import { crawlApartments, removeDeliveryRecipient } from "../src/crawler.js";
import { emptyFilters } from "../src/filters.js";
import { PrivateDeliveryBarrier } from "../src/rate-limit.js";
import { ListAmIntegrityReason } from "../src/source-integrity.js";
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

function defaultDeliveries(state) {
  return state.files.get(config.deliveryStateFile).recipients.default;
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
  assert.deepEqual(
    Object.keys(state.files.get(config.apartmentsStateFile).apartments),
    ["500"],
  );
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
  assert.equal(result.exhausted, true);
  assert.deepEqual(
    Object.keys(state.files.get(config.apartmentsStateFile).apartments),
    ["700"],
  );
});

test("a late integrity failure leaves apartment, delivery, and channel state untouched", async () => {
  const deliverySeed = {
    version: 2,
    type: "telegram-deliveries",
    urlTemplate: config.listUrlTemplate,
    recipients: {},
  };
  const state = memoryState({
    [config.deliveryStateFile]: deliverySeed,
  });
  const writes = [];
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
        saveState: async (...arguments_) => writes.push(arguments_),
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
  assert.deepEqual(writes, []);
  assert.deepEqual(privateSends, []);
  assert.deepEqual(channelCallbacks, []);
  assert.deepEqual(integrityChecks, []);
  assert.equal(state.files.has(config.apartmentsStateFile), false);
  assert.deepEqual(state.files.get(config.deliveryStateFile), deliverySeed);
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
  const state = memoryState({ [config.apartmentsStateFile]: apartmentSeed });
  const invalidWatermarkPage = datedPage([
    "899",
    "Friday, July 24, 2026, 14:30",
  ]).replace(
    /\s*<\/div>\s*$/u,
    '<a class="fav-item-info-container" href="/item/invalid">Rejected</a></div>',
  );
  let writes = 0;

  await assert.rejects(
    crawlApartments(config, {
      ...state,
      saveState: async () => {
        writes += 1;
      },
      fetchPage: async () => new Response(invalidWatermarkPage),
    }),
    (error) =>
      error.reason === ListAmIntegrityReason.IDENTITY_REJECTION &&
      error.page === 1,
  );
  assert.equal(writes, 0);
  assert.deepEqual(state.files.get(config.apartmentsStateFile), apartmentSeed);
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
  const state = memoryState({ [config.apartmentsStateFile]: apartmentSeed });

  await crawlApartments(
    { ...config, initialPageCount: 1 },
    {
      ...state,
      fetchPage: async () => new Response(page("1001", "1002", "1003")),
      now: () => new Date("2026-07-24T12:00:00.000Z"),
    },
  );

  const stored = state.files.get(config.apartmentsStateFile);
  assert.equal(stored.version, 3);
  assert.deepEqual(stored.sourceIntegrity, {
    recentFirstPageCounts: [4, 3, 2, 1, 3],
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
  const state = memoryState({ [config.apartmentsStateFile]: apartmentSeed });
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

  assert.deepEqual(state.files.get(config.apartmentsStateFile), apartmentSeed);
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
  const state = memoryState({ [config.apartmentsStateFile]: apartmentSeed });

  await assert.rejects(
    crawlApartments(
      { ...config, initialPageCount: 1 },
      {
        ...state,
        saveState: async () => {
          throw new Error("durable apartment write failed");
        },
        fetchPage: async () => new Response(page("1201", "1202", "1203")),
        now: () => new Date("2026-07-24T12:00:00.000Z"),
      },
    ),
    /durable apartment write failed/u,
  );

  assert.deepEqual(state.files.get(config.apartmentsStateFile), apartmentSeed);
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
  const state = memoryState({ [config.apartmentsStateFile]: apartmentSeed });
  let fetched = false;
  let writes = 0;

  await assert.rejects(
    crawlApartments(config, {
      ...state,
      saveState: async () => {
        writes += 1;
      },
      fetchPage: async () => {
        fetched = true;
        return new Response(page("1"));
      },
    }),
    (error) => error.code === "ERR_STATE_INCOMPATIBLE",
  );
  assert.equal(fetched, false);
  assert.equal(writes, 0);
  assert.deepEqual(state.files.get(config.apartmentsStateFile), apartmentSeed);
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

  const stored = state.files.get(config.apartmentsStateFile);
  assert.equal(stored.apartments["1"].lastSeenAt, "2026-07-24T12:01:00.000Z");
  assert.equal(stored.apartments["1"].updatedAt, undefined);
  assert.equal(
    stored.lastCrawl.stoppedAtKnownDate,
    stored.lastCrawl.lastKnownDate,
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
  assert.deepEqual(
    Object.keys(state.files.get(config.apartmentsStateFile).apartments).sort(),
    ["1", "2", "3"],
  );
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
  assert.equal(
    Object.keys(state.files.get(config.apartmentsStateFile).apartments).length,
    4,
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
  const deliveryState = state.files.get(config.deliveryStateFile);
  assert.deepEqual(Object.keys(deliveryState.recipients["42"].notified), [
    "1",
    "2",
    "3",
  ]);
  assert.deepEqual(
    Object.keys(deliveryState.recipients["99"].filtered).sort(),
    ["1", "2", "3"],
  );
});

test("slow recipients do not block peers or channel publication", async () => {
  const state = memoryState();
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
  const saveState = async (filename, value) => {
    if (filename === config.deliveryStateFile) {
      deliveryWrites += 1;
      concurrentDeliveryWrites += 1;
      maximumConcurrentDeliveryWrites = Math.max(
        maximumConcurrentDeliveryWrites,
        concurrentDeliveryWrites,
      );
      await Promise.resolve();
    }
    state.files.set(filename, structuredClone(value));
    if (filename === config.deliveryStateFile) concurrentDeliveryWrites -= 1;
  };

  const crawling = crawlApartments(
    { ...config, initialPageCount: 1 },
    {
      ...state,
      saveState,
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
  const recipients = state.files.get(config.deliveryStateFile).recipients;
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
  await mutateDeliveryState(() => removeDeliveryRecipient(config, "42", state));
  barrier.clear("42");
  await crawling;

  const recipients = state.files.get(config.deliveryStateFile).recipients;
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
  const recipients = state.files.get(config.deliveryStateFile).recipients;
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
  assert.deepEqual(
    Object.keys(
      state.files.get(config.deliveryStateFile).recipients["42"].skipped,
    ).sort(),
    ["1", "2", "3"],
  );

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

  const stored = state.files.get(config.apartmentsStateFile).apartments["20"];
  assert.equal(result.notifiedCount, 1);
  assert.equal(state.files.get(config.apartmentsStateFile).version, 3);
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
  assert.equal(migrated.version, 3);
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

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { Session } from "node:inspector";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

const { values } = parseArgs({
  options: {
    "implementation-root": {
      type: "string",
      default: fileURLToPath(new URL("..", import.meta.url)),
    },
    listings: { type: "string", default: "5442" },
    encounters: { type: "string", default: "40" },
    repeats: { type: "string", default: "10" },
  },
});
const listings = Number(values.listings);
const encounters = Number(values.encounters);
const repeats = Number(values.repeats);
for (const value of [listings, encounters, repeats])
  assert(Number.isSafeInteger(value) && value > 0);
assert(encounters <= listings);
const moduleAt = (name) =>
  import(pathToFileURL(path.join(values["implementation-root"], "src", name)));
const [
  { crawlApartments },
  { openStateDatabase },
  { createSqliteRepositories },
  { createSqliteStateAccess },
] = await Promise.all([
  moduleAt("crawler.js"),
  moduleAt("sqlite-database.js"),
  moduleAt("sqlite-repositories.js"),
  moduleAt("sqlite-state-access.js"),
]);
const directory = mkdtempSync(
  path.join(tmpdir(), "incremental-crawl-benchmark-"),
);
const template = "https://www.list.am/ru/category/56/{page}";
const metrics = [];
const database = openStateDatabase({
  dataDirectory: directory,
  listUrlTemplate: template,
  create: true,
  onMetric: (metric) => metrics.push(metric),
});
const repositories = createSqliteRepositories(database, {
  listUrlTemplate: template,
});
const stateAccess = createSqliteStateAccess(database, repositories);
const stamp = "2026-09-15T10:00:00.000Z";
const ids = Array.from({ length: listings }, (_, index) =>
  String(900000000 + index),
);
const apartments = Object.fromEntries(
  ids.map((itemId, index) => [
    itemId,
    {
      itemId,
      kind: "apartment",
      title: `Apartment ${itemId}`,
      url: `https://www.list.am/ru/item/${itemId}`,
      price: {
        amountAmd: 200000,
        originalAmount: 200000,
        originalCurrency: "AMD",
        exchangeRate: null,
        exchangeRateFetchedAt: null,
        exchangeRateEffectiveDate: null,
      },
      location: "Arabkir",
      rooms: 2,
      areaSqM: 50,
      floor: "3/5",
      date:
        index < encounters
          ? "Вторник, Сентябрь 15, 2026, 09:00"
          : "Понедельник, Сентябрь 14, 2026, 09:00",
      firstSeenAt: stamp,
      lastSeenAt: stamp,
    },
  ]),
);
repositories.apartments.importState({
  version: 4,
  type: "list-am-apartments",
  urlTemplate: template,
  checkedAt: stamp,
  lastCrawl: {},
  sourceIntegrity: { recentFirstPageCounts: {} },
  apartments,
  apartmentOrder: ids,
});
repositories.privateDeliveries.initializeSelection("1", {
  skipped: Object.fromEntries(ids.map((id) => [id, stamp])),
});
const html = `<div id="contentr">${ids
  .slice(0, encounters)
  .map(
    (id) =>
      `<a class="fav-item-info-container" href="/ru/item/${id}"><div class="pt">Apartment ${id}</div><div class="p">200000 ֏</div><div class="at">Arabkir, 2 ком., 50 sq.m., 3/5 floor</div><div class="d">Вторник, Сентябрь 15, 2026, 09:00</div></a>`,
  )
  .join("")}</div>`;
const originalStringify = JSON.stringify;
const originalParse = JSON.parse;
const originalLoad = stateAccess.apartments.load;
const originalLoadRecipient = stateAccess.privateDeliveries.loadRecipient;
let payloadSerializations = 0;
let serializedPayloadBytes = 0;
let payloadParses = 0;
let fullHistoryReads = 0;
let consumerListings = 0;
let recipientDecisionIdsRequested = 0;
let clock = 0;
const session = new Session();
session.connect();
const post = promisify(session.post.bind(session));
const allocated = (node) =>
  node.selfSize +
  node.children.reduce((sum, child) => sum + allocated(child), 0);
const fileBytes = (name) => {
  try {
    return statSync(name).size;
  } catch {
    return 0;
  }
};
const results = [];
try {
  JSON.stringify = function (value, ...args) {
    const serialized = originalStringify.call(JSON, value, ...args);
    if (value?.itemId && value?.price) {
      payloadSerializations++;
      serializedPayloadBytes += Buffer.byteLength(serialized);
    }
    return serialized;
  };
  JSON.parse = function (...args) {
    const value = originalParse.apply(JSON, args);
    if (value?.itemId && value?.price) payloadParses++;
    return value;
  };
  stateAccess.apartments.load = (...args) => {
    fullHistoryReads++;
    return originalLoad(...args);
  };
  stateAccess.privateDeliveries.loadRecipient = (recipientId, itemIds) => {
    recipientDecisionIdsRequested += itemIds.length;
    return originalLoadRecipient(recipientId, itemIds);
  };
  for (const phase of [
    "discovery-only",
    "channel-history-materialization",
    "private-history-delivery",
  ]) {
    database.connection.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    globalThis.gc?.();
    metrics.length = 0;
    recipientDecisionIdsRequested = 0;
    payloadSerializations =
      serializedPayloadBytes =
      payloadParses =
      fullHistoryReads =
      consumerListings =
        0;
    await post("HeapProfiler.startSampling", {
      samplingInterval: 16384,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    const cpu = process.cpuUsage();
    const start = performance.now();
    for (let repeat = 0; repeat < repeats; repeat++) {
      const result = await crawlApartments(
        {
          listUrlTemplate: template,
          initialPageCount: 1,
          initialDeliveryLimit: 2,
        },
        {
          stateAccess,
          now: () => new Date(Date.parse(stamp) + ++clock * 1000),
          fetchPage: async (url) =>
            new Response(
              url.endsWith("/1") ? html : '<div id="contentr"></div>',
            ),
          ...(phase === "channel-history-materialization"
            ? {
                afterStateSaved: (state) => {
                  consumerListings += Object.keys(state.apartments).length;
                },
              }
            : {}),
          ...(phase === "private-history-delivery"
            ? {
                privateDeliveries: [
                  {
                    recipientId: "1",
                    filters: {},
                    deliverApartment: () => {
                      throw new Error("Skipped listing must not be sent");
                    },
                  },
                ],
              }
            : {}),
        },
      );
      assert.equal(result.status, "unchanged");
      assert.equal(result.totalCount, listings);
    }
    const durationMs = performance.now() - start;
    const usage = process.cpuUsage(cpu);
    const { profile } = await post("HeapProfiler.stopSampling");
    results.push({
      phase,
      repeats,
      cpuMs: (usage.user + usage.system) / 1000,
      wallMs: durationMs,
      sampledAllocatedBytes: allocated(profile.head),
      heapUsedBytes: process.memoryUsage().heapUsed,
      rssBytes: process.memoryUsage().rss,
      payloadSerializations,
      serializedPayloadBytes,
      payloadParses,
      fullHistoryReads,
      consumerListings,
      recipientDecisionIdsRequested,
      rowsChanged: metrics
        .filter((metric) => metric.name === "state.transaction.completed")
        .reduce((sum, metric) => sum + metric.rowsChanged, 0),
      transactionMs: metrics
        .filter((metric) => metric.name === "state.transaction.completed")
        .reduce((sum, metric) => sum + metric.durationMs, 0),
      databaseBytes: fileBytes(database.filename),
      walBytes: fileBytes(`${database.filename}-wal`),
    });
  }
} finally {
  JSON.stringify = originalStringify;
  JSON.parse = originalParse;
  session.disconnect();
  database.close();
  rmSync(directory, { recursive: true, force: true });
}
console.log(
  JSON.stringify(
    {
      node: process.version,
      listings,
      encounters,
      samplingIntervalBytes: 16384,
      limitations:
        "Sampled V8 allocations include collected objects and profiler overhead; channel phase measures history materialization only, private phase retains full-history listing/decision reads; synthetic offline source, no Telegram calls.",
      results,
    },
    null,
    2,
  ),
);

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { crawlApartments } from "../src/crawler.js";
import { postingDateSortValue } from "../src/posting-date.js";
import { openStateDatabase } from "../src/sqlite-database.js";
import { createSqliteRepositories } from "../src/sqlite-repositories.js";
import { createSqliteStateAccess } from "../src/sqlite-state-access.js";
import { createLegacyDatabase } from "./helpers/sqlite-legacy.js";

const template = "https://www.list.am/ru/category/56/{page}";
const checkedAt = "2026-09-15T10:00:00.000Z";
const date = "Вторник, Сентябрь 15, 2026, 09:00";
function apartment(itemId, overrides = {}) {
  return {
    itemId,
    kind: "apartment",
    title: `Apartment ${itemId}`,
    date,
    price: { amountAmd: 200000 },
    firstSeenAt: checkedAt,
    lastSeenAt: checkedAt,
    ...overrides,
  };
}
function state(apartments, order = Object.keys(apartments)) {
  return {
    version: 4,
    type: "list-am-apartments",
    urlTemplate: template,
    checkedAt,
    lastCrawl: {},
    sourceIntegrity: { recentFirstPageCounts: {} },
    apartments,
    apartmentOrder: order,
  };
}
function setup(t, beforeOpen) {
  const directory = mkdtempSync(path.join(tmpdir(), "incremental-crawl-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  beforeOpen?.(directory);
  const metrics = [];
  const database = openStateDatabase({
    dataDirectory: directory,
    listUrlTemplate: template,
    create: !beforeOpen,
    onMetric: (metric) => metrics.push(metric),
  });
  t.after(() => database.close());
  const repositories = createSqliteRepositories(database, {
    listUrlTemplate: template,
  });
  const stateAccess = createSqliteStateAccess(database, repositories);
  return {
    database,
    repository: repositories.apartments,
    stateAccess,
    metrics,
  };
}
function page(ids, title = "Apartment") {
  return `<div id="contentr">${ids.map((id) => `<a class="fav-item-info-container" href="/ru/item/${id}"><div class="pt">${title} ${id}</div><div class="p">200000 ֏</div><div class="at">Arabkir, 2 rm., 50 sq.m., 3/5 floor</div><div class="d">${date}</div></a>`).join("")}</div>`;
}
function crawl(stateAccess, ids, options = {}) {
  return crawlApartments(
    { listUrlTemplate: template, initialPageCount: 1, initialDeliveryLimit: 2 },
    {
      stateAccess,
      now: () => new Date(checkedAt),
      fetchPage: async (url) =>
        new Response(
          url.endsWith("/1") ? page(ids) : '<div id="contentr"></div>',
        ),
      ...options,
    },
  );
}

test("unchanged discovery reads encountered payloads and only updates their encounter metadata", async (t) => {
  const { database, repository, stateAccess, metrics } = setup(t);
  await crawl(stateAccess, ["1", "2", "3"]);
  const historical = repository.load();
  database.connection.exec(`CREATE TEMP TABLE payload_writes(item_id TEXT);
    CREATE TEMP TRIGGER track_payload UPDATE OF payload_json ON apartments BEGIN INSERT INTO payload_writes VALUES (new.item_id); END;`);
  const originalLoad = stateAccess.apartments.load;
  stateAccess.apartments.load = () => {
    throw new Error("Discovery must not load history");
  };
  const found = [];
  const originalFind = stateAccess.apartments.findEncountered;
  stateAccess.apartments.findEncountered = (ids) => {
    found.push(...ids);
    return originalFind(ids);
  };
  const result = await crawl(stateAccess, ["2", "1"], {
    now: () => new Date("2026-09-15T11:00:00.000Z"),
  });
  assert.equal(result.status, "unchanged");
  assert.equal(result.totalCount, 3);
  assert.deepEqual(found, ["2", "1"]);
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM payload_writes").get()
      .count,
    0,
  );
  assert.equal(
    metrics
      .filter(
        (metric) =>
          metric.operation === "crawl_commit" &&
          metric.name === "state.transaction.completed",
      )
      .at(-1).rowsChanged,
    3,
  );
  assert.equal(
    database
      .prepare(
        "SELECT count(*) AS count FROM sqlite_temp_master WHERE name = 'crawl_present_items'",
      )
      .get().count,
    0,
  );
  stateAccess.apartments.load = originalLoad;
  const current = repository.load();
  assert.deepEqual(current.apartmentOrder, ["2", "1", "3"]);
  assert.deepEqual(current.apartments["3"], historical.apartments["3"]);
  assert.equal(current.apartments["2"].lastSeenAt, "2026-09-15T11:00:00.000Z");
  await crawl(stateAccess, ["3"], {
    fetchPage: async () => new Response(page(["3"], "Changed")),
  });
  assert.deepEqual(
    database
      .prepare("SELECT item_id FROM payload_writes")
      .all()
      .map((row) => row.item_id),
    ["3"],
  );
});

test("an interruption before metadata commit rolls back payloads, encounter order and watermarks", async (t) => {
  const { database, repository, stateAccess } = setup(t);
  await crawl(stateAccess, ["1", "2"]);
  const previous = repository.load();
  database.connection.exec(
    "CREATE TEMP TRIGGER fail_metadata BEFORE UPDATE ON crawl_state BEGIN SELECT RAISE(ABORT, 'injected interruption'); END;",
  );
  await assert.rejects(
    crawl(stateAccess, ["3", "2"], {
      now: () => new Date("2026-09-15T11:00:00.000Z"),
    }),
  );
  assert.deepEqual(repository.load(), previous);
  assert.equal(repository.loadCrawl(["apartment"]).totalCount, 2);
});

test("v2 migration retains payloads, exact order, category watermarks and last-seen timestamps", (t) => {
  const seed = state(
    {
      1: apartment("1"),
      2: apartment("2", {
        kind: "house",
        date: "Понедельник, Сентябрь 14, 2026, 08:00",
      }),
      3: apartment("3", { date: null, lastSeenAt: undefined }),
    },
    ["3", "1", "2"],
  );
  const { repository } = setup(t, (directory) => {
    const legacy = createLegacyDatabase(directory, {
      listUrlTemplate: template,
    });
    legacy
      .prepare("INSERT INTO crawl_state VALUES (1, ?, ?, ?, ?)")
      .run(
        seed.checkedAt,
        JSON.stringify(seed.lastCrawl),
        JSON.stringify(seed.apartmentOrder),
        JSON.stringify(seed.sourceIntegrity),
      );
    for (const [id, value] of Object.entries(seed.apartments))
      legacy
        .prepare("INSERT INTO apartments VALUES (?, ?)")
        .run(id, JSON.stringify(value));
    legacy.close();
  });
  assert.deepEqual(repository.load(), JSON.parse(JSON.stringify(seed)));
  assert.deepEqual(repository.loadCrawl(["apartment", "house"]).watermarks, {
    apartment: { initialRun: false, date, value: postingDateSortValue(date) },
    house: {
      initialRun: false,
      date: seed.apartments["2"].date,
      value: postingDateSortValue(seed.apartments["2"].date),
    },
  });
});

test("indexed watermarks match retained-history date parsing through midnight, year rollover and leap years", (t) => {
  const { repository } = setup(t);
  const dates = [
    "Сегодня, 18:00",
    "Yesterday, 09:00",
    "Декабрь 31",
    "Январь 01",
    "Февраль 29",
    "Февраль 28",
    "Март 01",
    "Сентябрь 04",
    "Вторник, Сентябрь 15, 2026, 09:00",
    null,
  ];
  const apartments = Object.fromEntries(
    dates.map((value, index) => [
      String(index + 1),
      apartment(String(index + 1), {
        date: value,
        kind: index % 2 ? "house" : "apartment",
      }),
    ]),
  );
  repository.importState(state(apartments));
  for (const reference of [
    "2026-12-31T23:59:59.999Z",
    "2027-01-01T00:00:00.000Z",
    "2027-02-28T23:59:59.999Z",
    "2028-02-28T12:00:00.000Z",
    "2028-03-01T12:00:00.000Z",
  ]) {
    const mock = t.mock.method(Date, "now", () => Date.parse(reference));
    for (const kind of ["apartment", "house"]) {
      const expected = Object.values(apartments)
        .filter((value) => value.kind === kind)
        .reduce(
          (max, value) =>
            Math.max(max, postingDateSortValue(value.date) ?? -Infinity),
          -Infinity,
        );
      assert.equal(
        repository.loadCrawl([kind]).watermarks[kind].value,
        expected,
        reference,
      );
    }
    mock.mock.restore();
  }
});

test("legacy prices normalize atomically even when absent and stay frozen after rates change", async (t) => {
  const { repository, stateAccess } = setup(t);
  repository.importState(
    state({ 1: apartment("1", { price: { amount: 1000, currency: "$" } }) }),
  );
  const rates = (rate) => ({
    fetchedAt: checkedAt,
    effectiveDate: "2026-09-15",
    rates: { USD: { amount: 1, rate } },
  });
  await crawl(stateAccess, ["2"], { exchangeRates: rates(380) });
  assert.equal(repository.load().apartments["1"].price.amountAmd, 380000);
  assert.deepEqual(repository.findLegacyPrices(), []);
  await crawl(stateAccess, ["2"], { exchangeRates: rates(400) });
  assert.equal(repository.load().apartments["1"].price.amountAmd, 380000);
});

test("invalid retained membership fails migration without advancing the schema", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "incremental-invalid-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const legacy = createLegacyDatabase(directory, { listUrlTemplate: template });
  legacy
    .prepare(
      "INSERT INTO crawl_state VALUES (1, ?, '{}', '[\"missing\"]', '{\"recentFirstPageCounts\":{}}')",
    )
    .run(checkedAt);
  assert.throws(() =>
    openStateDatabase({ dataDirectory: directory, listUrlTemplate: template }),
  );
  assert.equal(legacy.prepare("PRAGMA user_version").get().user_version, 2);
  assert.equal(
    legacy.prepare("SELECT apartment_order_json FROM crawl_state").get()
      .apartment_order_json,
    '["missing"]',
  );
  legacy.close();
});

test("full validation rejects a retained count inconsistent with metadata", (t) => {
  const { database, repository } = setup(t);
  repository.importState(state({ 1: apartment("1") }));
  assert.throws(() =>
    database.prepare("UPDATE crawl_state SET total_count = -1").run(),
  );
  assert.throws(() =>
    database.prepare("UPDATE apartments SET encounter_sequence = -1").run(),
  );
  database.prepare("UPDATE crawl_state SET total_count = 2").run();
  assert.throws(() => repository.load(), /count does not match/);
});

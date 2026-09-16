import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "implementation-root": {
      type: "string",
      default: fileURLToPath(new URL("..", import.meta.url)),
    },
    mode: { type: "string", default: "private" },
    listings: { type: "string", default: "5442" },
    users: { type: "string", default: "88" },
    encounters: { type: "string", default: "40" },
    repeats: { type: "string", default: "5" },
  },
});
for (const name of ["listings", "users", "encounters", "repeats"]) {
  values[name] = Number(values[name]);
  assert(Number.isSafeInteger(values[name]) && values[name] > 0);
}
assert(["private", "channel"].includes(values.mode));
assert(values.encounters <= values.listings);
const moduleAt = (name) =>
  import(pathToFileURL(path.join(values["implementation-root"], "src", name)));
const [
  { crawlApartments },
  { emptyFilters },
  { openStateDatabase },
  { createSqliteRepositories },
  { createSqliteStateAccess },
  channel,
] = await Promise.all([
  moduleAt("crawler.js"),
  moduleAt("filters.js"),
  moduleAt("sqlite-database.js"),
  moduleAt("sqlite-repositories.js"),
  moduleAt("sqlite-state-access.js"),
  moduleAt("channel.js"),
]);
const directory = mkdtempSync(path.join(tmpdir(), "delivery-benchmark-"));
const stamp = "2026-09-15T10:00:00.000Z";
const template = "https://www.list.am/ru/category/56/{page}";
const config = {
  listUrlTemplate: template,
  initialPageCount: 1,
  initialDeliveryLimit: 4,
  telegramChannelId: "@synthetic",
  channelFilters: emptyFilters(),
};
const ids = Array.from({ length: values.listings }, (_, i) =>
  String(900000000 + i),
);
let database, repositories, access;
function open(create = false) {
  database = openStateDatabase({
    dataDirectory: directory,
    listUrlTemplate: template,
    create,
  });
  repositories = createSqliteRepositories(database, {
    listUrlTemplate: template,
    channelId: config.telegramChannelId,
  });
  access = createSqliteStateAccess(database, repositories);
}
let revision = 0,
  sent = 0,
  edited = 0,
  failed = 0,
  fail = false,
  messageId = 0;
let clock = Date.parse(stamp);
const now = () => new Date(clock);
const api = {
  sendMessage: async () => {
    if (fail) {
      failed++;
      throw new Error("synthetic failure");
    }
    sent++;
    return { message_id: ++messageId };
  },
  editMessageText: async () => {
    if (fail) {
      failed++;
      throw new Error("synthetic failure");
    }
    edited++;
  },
};
const filters = (user) => ({
  ...emptyFilters(),
  price: {
    min: 100000 + (user % 4) * 100000,
    max: 100000 + (user % 4) * 100000,
  },
});
function html(population) {
  return `<div id="contentr">${population
    .map((id) => {
      const index = Number(id) - 900000000;
      return `<a class="category-data-list-card__destination" href="/ru/item/${id}"><div class="dltitle">Rental ${index}${index === 0 && revision ? ` revision ${revision}` : ""}</div><div class="p">${100000 + (index % 4) * 100000} ֏</div><div class="l">Арабкир</div><div class="at">2 ком. · 60 кв.м. · 3/9 этаж</div><div class="d">Вторник, Сентябрь 15, 2026, 10:00</div></a>`;
    })
    .join("")}</div>`;
}
async function crawl(population, deliveries = true) {
  clock += 1000;
  const fixture = html(population);
  return crawlApartments(config, {
    stateAccess: access,
    now,
    fetchPage: async (url) =>
      new Response(url.endsWith("/1") ? fixture : '<div id="contentr"></div>'),
    ...(deliveries && values.mode === "private"
      ? {
          privateDeliveries: Array.from(
            { length: values.users },
            (_, user) => ({
              recipientId: String(user + 1),
              filters: filters(user),
              sendInitialApartments: true,
              deliverApartment: async () => {
                sent++;
              },
            }),
          ),
        }
      : {}),
    ...(deliveries && values.mode === "channel"
      ? {
          // Older revisions require the retained snapshot; incremental stores ignore it.
          afterStateSaved: (state) =>
            channel.publishChannelApartments(config, state, {
              api,
              stateStore: access.channelDeliveries,
              now,
            }),
        }
      : {}),
  });
}
function cgroup(name) {
  try {
    return readFileSync(`/sys/fs/cgroup/${name}`, "utf8").trim();
  } catch {
    return null;
  }
}
const results = [];
async function measure(phase, action) {
  sent = edited = failed = 0;
  globalThis.gc?.();
  const cpu = process.cpuUsage(),
    start = performance.now();
  await action();
  const usage = process.cpuUsage(cpu);
  results.push({
    phase,
    wallMs: performance.now() - start,
    cpuMs: (usage.user + usage.system) / 1000,
    rssBytes: process.memoryUsage().rss,
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
    cgroupPeakBytes: cgroup("memory.peak"),
    sent,
    edited,
    failed,
  });
}
try {
  open(true);
  await crawl(ids, false);
  if (values.mode === "private") {
    database.transaction("benchmark_seed", () => {
      for (let user = 0; user < values.users; user++) {
        const filtered = {};
        for (let index = 0; index < ids.length; index++) {
          if (index % 4 === user % 4)
            repositories.privateDeliveries.acknowledge(
              String(user + 1),
              ids[index],
              stamp,
              { transaction: false },
            );
          else filtered[ids[index]] = stamp;
        }
        repositories.privateDeliveries.initializeSelection(
          String(user + 1),
          { filtered },
          { transaction: false },
        );
      }
    });
  } else {
    const state = repositories.apartments.load();
    repositories.channelDeliveries.importState({
      version: 1,
      type: "telegram-channel-deliveries",
      channelId: config.telegramChannelId,
      urlTemplate: template,
      initialized: true,
      filterFingerprint: channel.channelFilterFingerprint(
        config.channelFilters,
      ),
      apartments: Object.fromEntries(
        ids.map((id) => [
          id,
          {
            status: "published",
            classifiedAt: stamp,
            messageId: ++messageId,
            contentHash: channel.channelContentHash(
              channel.formatChannelApartmentMessage(state.apartments[id]),
            ),
            publishedAt: stamp,
          },
        ]),
      ),
    });
  }
  const sparse = ids.slice(0, values.encounters);
  await crawl(sparse);
  for (let i = 0; i < values.repeats; i++)
    await measure(`unchanged-${i + 1}`, async () => {
      await crawl(sparse);
      assert.equal(sent + edited, 0);
    });
  revision = 1;
  await measure("source-update", async () => {
    await crawl(sparse);
    assert.equal(
      sent + edited,
      values.mode === "channel" ? 1 : Math.ceil(values.users / 4),
    );
  });
  if (values.mode === "channel") {
    revision = 2;
    fail = true;
    await measure("failed-update", async () => {
      await crawl(sparse);
      assert.equal(failed, 1);
      assert.equal(sent + edited, 0);
    });
    database.close();
    open();
    fail = false;
    await measure("restart-retry", async () => {
      await crawl(sparse);
      assert.equal(edited, 1);
    });
  } else {
    database.close();
    open();
  }
  await measure("restart-drained", async () => {
    await crawl(sparse);
    assert.equal(sent + edited, 0);
  });
  console.log(
    JSON.stringify(
      {
        status: "passed",
        node: process.version,
        revision: process.env.BASELINE_REVISION || "working-tree",
        workload: values,
        limits: { cpu: cgroup("cpu.max"), memory: cgroup("memory.max") },
        results,
      },
      null,
      2,
    ),
  );
} finally {
  database?.close();
  rmSync(directory, { recursive: true, force: true });
}

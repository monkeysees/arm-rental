import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "implementation-root": {
      type: "string",
      default: fileURLToPath(new URL("..", import.meta.url)),
    },
    users: { type: "string", default: "88" },
    listings: { type: "string", default: "1000" },
    selected: { type: "string", default: "100" },
    "send-delay-ms": { type: "string", default: "5" },
  },
});
for (const key of ["users", "listings", "selected", "send-delay-ms"]) {
  values[key] = Number(values[key]);
  assert(Number.isSafeInteger(values[key]) && values[key] > 0);
}
assert(values.selected <= values.listings);
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
const directory = mkdtempSync(path.join(tmpdir(), "private-concurrency-"));
const config = {
  listUrlTemplate: "https://www.list.am/ru/category/56/{page}",
  initialPageCount: 1,
  initialDeliveryLimit: values.selected,
};
const options = {
  dataDirectory: directory,
  listUrlTemplate: config.listUrlTemplate,
};
const database = openStateDatabase({ ...options, create: true });
const repositories = createSqliteRepositories(database, options);
const stateAccess = createSqliteStateAccess(database, repositories);
const now = () => new Date("2026-09-16T12:00:00Z");
const html = `<div id="contentr">${Array.from(
  { length: values.listings },
  (_, index) => {
    const id = values.listings - index;
    return `<a class="fav-item-info-container" href="/ru/item/${id}"><div class="dltitle"><div class="pt">Synthetic apartment ${id}</div></div><div class="p">100000 ֏ monthly</div><div class="at">Arabkir, 2 rm., 50 sq.m., 3/5 floor</div><div class="d">Среда, Сентябрь 16, 2026, 10:00</div></a>`;
  },
).join("")}</div>`;
const fetchPage = async () => new Response(html);
let start;
let active = 0;
let peakActive = 0;
let sent = 0;
const first = new Map();
const previous = new Map();
const announced = new Set();
const network = async (id, apartment) => {
  active += 1;
  peakActive = Math.max(peakActive, active);
  try {
    await delay(
      id === "1" && !announced.has(id) ? 100 : values["send-delay-ms"],
    );
    if (!apartment) {
      announced.add(id);
      return;
    }
    assert(announced.has(id));
    const item = Number(apartment.itemId);
    assert.equal(
      item,
      (previous.get(id) ?? values.listings - values.selected) + 1,
    );
    previous.set(id, item);
    if (!first.has(id)) first.set(id, performance.now() - start);
    sent += 1;
  } finally {
    active -= 1;
  }
};
const cgroup = (name) => {
  try {
    return readFileSync(`/sys/fs/cgroup/${name}`, "utf8").trim();
  } catch {
    return null;
  }
};
try {
  await crawlApartments(config, { stateAccess, fetchPage, now });
  globalThis.gc?.();
  const rssBeforeBytes = process.memoryUsage().rss;
  const cpu = process.cpuUsage();
  start = performance.now();
  const result = await crawlApartments(config, {
    stateAccess,
    fetchPage,
    now,
    privateDeliveries: Array.from({ length: values.users }, (_, index) => {
      const recipientId = String(index + 1);
      return {
        recipientId,
        announceDelivery: () => network(recipientId),
        deliverApartment: (apartment) => network(recipientId, apartment),
      };
    }),
  });
  const wallMs = performance.now() - start;
  const used = process.cpuUsage(cpu);
  assert.equal(sent, values.users * values.selected);
  assert.equal(result.notifiedCount, sent);
  assert.equal(first.size, values.users);
  assert.equal(active, 0);
  const latency = [...first.values()].sort((a, b) => a - b);
  console.log(
    JSON.stringify(
      {
        status: "passed",
        node: process.version,
        workload: values,
        limits: { cpu: cgroup("cpu.max"), memory: cgroup("memory.max") },
        wallMs,
        cpuMs: (used.user + used.system) / 1000,
        sent,
        messagesPerSecond: (sent / wallMs) * 1000,
        peakActive,
        rssBeforeBytes,
        peakRssBytes: process.resourceUsage().maxRSS * 1024,
        cgroupPeakBytes: cgroup("memory.peak"),
        firstListingLatencyMs: {
          p50: latency[Math.ceil(latency.length * 0.5) - 1],
          p95: latency[Math.ceil(latency.length * 0.95) - 1],
          max: latency.at(-1),
        },
      },
      null,
      2,
    ),
  );
} finally {
  database.close();
  rmSync(directory, { recursive: true, force: true });
}

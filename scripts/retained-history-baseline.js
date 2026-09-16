import assert from "node:assert/strict";
import { fork, execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { crawlApartments } from "../src/crawler.js";
import { emptyFilters } from "../src/filters.js";
import { openStateDatabase } from "../src/sqlite-database.js";
import { createSqliteRepositories } from "../src/sqlite-repositories.js";
import { createSqliteStateAccess } from "../src/sqlite-state-access.js";
import { LIST_AM_SOURCES, LIST_AM_URL_TEMPLATE } from "../src/target.js";
import { formatApartmentMessage } from "../src/telegram.js";

const { values } = parseArgs({
  options: {
    listings: { type: "string", default: "5442" },
    users: { type: "string", default: "88" },
    decisions: { type: "string", default: "577501" },
    repeats: { type: "string", default: "5" },
    phase: { type: "string" },
    directory: { type: "string" },
  },
});
for (const name of ["listings", "users", "decisions", "repeats"]) {
  values[name] = Number(values[name]);
  assert(
    Number.isSafeInteger(values[name]) && values[name] > 0,
    `Invalid ${name}`,
  );
}
assert(
  values.listings >= 8 && values.users >= 4,
  "Need at least eight listings and four recipients",
);
assert(
  Number.isSafeInteger(values.listings * values.users),
  "Population product exceeds safe integer range",
);
// Larger retained populations automatically grow the decision population.
values.decisions = Math.max(values.decisions, values.listings * values.users);
const stamp = "2026-09-15T10:00:00.000Z";
const id = (index) => String(900000000 + index);
const base = Array.from({ length: values.listings }, (_, index) => index);
const filters = (user) => ({
  ...emptyFilters(),
  kinds: ["apartment", "house"],
  price: {
    min: 100000 + (user % 4) * 100000,
    max: 100000 + (user % 4) * 100000,
  },
});
function textFile(filename) {
  try {
    return readFileSync(filename, "utf8").trim();
  } catch {
    return null;
  }
}
function numberFile(filename) {
  try {
    const value = readFileSync(filename, "utf8").trim();
    return value === "max" ? value : Number(value);
  } catch {
    return null;
  }
}
function bytes(filename) {
  try {
    return statSync(filename).size;
  } catch {
    return 0;
  }
}
function fixture(indices, kind, updated, mixedDates = false) {
  return `<div id="contentr">${indices
    .filter((index) => index % 2 === (kind === "house" ? 1 : 0))
    .map(
      (index) =>
        `<a class="category-data-list-card__destination" href="/ru/item/${id(index)}"><div class="dltitle">Synthetic rental ${index}${updated && index === 0 ? " updated" : ""}</div><div class="p">${100000 + (index % 4) * 100000} ֏</div><div class="l">Арабкир</div><div class="at">2 ком. · 60 кв.м. · 3/9 этаж</div><div class="d">${mixedDates && index < 2 ? "Понедельник, Сентябрь 14" : "Вторник, Сентябрь 15"}, 2026, ${mixedDates && index < 2 ? "12:00" : "10:00"}</div></a>`,
    )
    .join("")}</div>`;
}
async function worker() {
  assert(process.send && values.directory);
  let transactions = 0;
  let transactionMs = 0;
  const database = openStateDatabase({
    dataDirectory: values.directory,
    listUrlTemplate: LIST_AM_URL_TEMPLATE,
    create: ["seed", "ordering"].includes(values.phase),
    onMetric(metric) {
      if (metric.name === "state.transaction.completed") {
        transactions++;
        transactionMs += metric.durationMs;
      }
    },
  });
  const repos = createSqliteRepositories(database, {
    listUrlTemplate: LIST_AM_URL_TEMPLATE,
  });
  const access = createSqliteStateAccess(database, repos);
  const results = [];
  let clock = 0;
  async function measure(name, action) {
    const cpu = process.cpuUsage();
    const start = performance.now();
    const tx = transactions;
    const txMs = transactionMs;
    const detail = await action();
    const usage = process.cpuUsage(cpu);
    results.push({
      phase: name,
      wallMs: performance.now() - start,
      cpuMs: (usage.user + usage.system) / 1000,
      rssBytes: process.memoryUsage().rss,
      maxRssBytes: process.resourceUsage().maxRSS * 1024,
      heapUsedBytes: process.memoryUsage().heapUsed,
      cgroupCurrentBytes: numberFile("/sys/fs/cgroup/memory.current"),
      cgroupPeakBytes: numberFile("/sys/fs/cgroup/memory.peak"),
      databaseBytes: bytes(database.filename),
      walBytes: bytes(`${database.filename}-wal`),
      transactions: transactions - tx,
      transactionMs: transactionMs - txMs,
      ...detail,
    });
  }
  async function crawl(
    indices,
    {
      updated = false,
      recipients = null,
      failAfter = Infinity,
      mixedDates = false,
    } = {},
  ) {
    let messages = 0;
    let announcements = 0;
    let interrupted = false;
    let payloadBytes = 0;
    const sent = {};
    const users =
      recipients ||
      Array.from({ length: values.users }, (_, user) => ({
        user,
        filters: filters(user),
      }));
    await crawlApartments(
      {
        listUrlTemplate: LIST_AM_URL_TEMPLATE,
        listSources: LIST_AM_SOURCES,
        initialPageCount: 1,
        initialDeliveryLimit: 4,
      },
      {
        stateAccess: access,
        now: () => new Date(Date.parse(stamp) + ++clock * 1000),
        fetchPage: async (url) =>
          new Response(
            new URL(url).pathname.split("/").at(-1) === "1"
              ? fixture(
                  indices,
                  url.includes("/1377/") ? "house" : "apartment",
                  updated,
                  mixedDates,
                )
              : '<div id="contentr"></div>',
          ),
        privateDeliveries: users.map(
          ({
            user,
            filters: selectedFilters,
            sendInitialApartments = true,
          }) => ({
            recipientId: String(user + 1),
            filters: selectedFilters,
            sendInitialApartments,
            announceDelivery: async () => {
              announcements++;
            },
            deliverApartment: async (apartment) => {
              if (messages >= failAfter) {
                interrupted = true;
                throw new Error("SYNTHETIC_INTERRUPTION");
              }
              (sent[user] ||= []).push(apartment.itemId);
              messages++;
              payloadBytes += Buffer.byteLength(
                formatApartmentMessage(apartment),
              );
            },
          }),
        ),
      },
    ).catch((error) => {
      if (error.message !== "SYNTHETIC_INTERRUPTION" || !interrupted)
        throw error;
    });
    const expectedOrder = [
      ...indices.filter((index) => index % 2 === 0),
      ...indices.filter((index) => index % 2 === 1),
    ]
      .reverse()
      .map(id);
    for (const items of Object.values(sent)) {
      if (!mixedDates)
        assert.deepEqual(
          items,
          expectedOrder.filter((item) => items.includes(item)),
          "Delivery order must be oldest first within the stable source order",
        );
      assert.equal(
        new Set(items).size,
        items.length,
        "Duplicate fixture delivery",
      );
    }
    return { messages, announcements, interrupted, payloadBytes, sent };
  }
  try {
    if (values.phase === "ordering") {
      await measure("posting-date-order", async () => {
        const result = await crawl([0, 1, 2, 3], {
          mixedDates: true,
          recipients: [
            {
              user: 0,
              filters: { ...emptyFilters(), kinds: ["apartment", "house"] },
            },
          ],
        });
        assert.deepEqual(result.sent[0], [
          "900000001",
          "900000000",
          "900000003",
          "900000002",
        ]);
        return result;
      });
    } else if (values.phase === "seed") {
      await measure("setup", async () => {
        await crawl(base, { recipients: [] });
        database.transaction("retained_baseline_seed", () => {
          for (let user = 0; user < values.users; user++) {
            repos.telegram.saveUser(
              {
                chatId: user + 1,
                active: true,
                sendInitialApartments: true,
                filters: filters(user),
                pendingFilterInput: null,
              },
              { transaction: false },
            );
            const filtered = {};
            const skipped = {};
            const count =
              Math.floor(values.decisions / values.users) +
              (user < values.decisions % values.users ? 1 : 0);
            for (let index = 0; index < count; index++) {
              const item =
                index < values.listings ? id(index) : `absent-${index}`;
              if (index % 4 !== user % 4) filtered[item] = stamp;
              else if (index % 20 === 4) skipped[item] = stamp;
              else
                repos.privateDeliveries.acknowledge(
                  String(user + 1),
                  item,
                  stamp,
                  { transaction: false },
                );
            }
            repos.privateDeliveries.initializeSelection(
              String(user + 1),
              { filtered, skipped },
              { transaction: false },
            );
          }
        });
        const counts = database
          .prepare(
            "SELECT CASE status WHEN 0 THEN 'notified' WHEN 1 THEN 'skipped' WHEN 2 THEN 'filtered' END AS status, count(*) AS count FROM private_delivery_decisions GROUP BY status ORDER BY 1",
          )
          .all();
        assert.equal(
          counts.reduce((sum, row) => sum + row.count, 0),
          values.decisions,
        );
        assert.equal(
          Object.keys(repos.apartments.load().apartments).length,
          values.listings,
        );
        return { decisionDistribution: counts };
      });
    } else if (values.phase === "steady") {
      for (let repeat = 0; repeat < values.repeats; repeat++)
        await measure(`unchanged-${repeat + 1}`, async () => {
          const result = await crawl(base);
          assert.equal(result.messages, 0);
          return result;
        });
      await measure("updated", async () => {
        const result = await crawl(base, { updated: true });
        assert.equal(result.messages, Math.ceil(values.users / 4));
        for (const items of Object.values(result.sent))
          assert.deepEqual(items, [id(0)]);
        return result;
      });
      await measure("returning", async () => {
        const returning = values.listings + 8;
        for (let user = 0; user < values.users; user++)
          repos.privateDeliveries.acknowledge(
            String(user + 1),
            id(returning),
            stamp,
          );
        const result = await crawl([...base, returning], { updated: true });
        assert.equal(result.messages, 0);
        return result;
      });
      await measure("interrupted", async () => {
        const result = await crawl(
          [
            ...base,
            ...Array.from({ length: 8 }, (_, index) => values.listings + index),
          ],
          { updated: true, failAfter: 3 },
        );
        assert(result.interrupted);
        assert.equal(result.messages, 3);
        return result;
      });
    } else {
      const current = [
        ...base,
        ...Array.from({ length: 8 }, (_, index) => values.listings + index),
      ];
      await measure("resumed", async () => {
        const result = await crawl(current, { updated: true });
        assert.equal(result.messages, values.users * 2 - 3);
        return result;
      });
      await measure("drained", async () => {
        const result = await crawl(current, { updated: true });
        assert.equal(result.messages, 0);
        return result;
      });
      const broad = { ...emptyFilters(), kinds: ["apartment", "house"] };
      await measure("initial-selection", async () => {
        const result = await crawl(current, {
          updated: true,
          recipients: [{ user: values.users, filters: broad }],
        });
        assert.equal(result.messages, 4);
        assert.equal(result.announcements, 1);
        return result;
      });
      await measure("history-accept", async () => {
        access.privateDeliveries.decisions.requestSelection("1");
        const result = await crawl(current, {
          updated: true,
          recipients: [{ user: 0, filters: broad }],
        });
        assert.equal(result.messages, 4);
        assert.equal(result.announcements, 1);
        return result;
      });
      await measure("history-decline", async () => {
        const recipient = repos.privateDeliveries.loadRecipient(
          "2",
          current.map(id),
        );
        access.privateDeliveries.decisions.declineHistory(
          "2",
          recipient.filtered,
        );
        const result = await crawl(current, {
          updated: true,
          recipients: [{ user: 1, filters: broad }],
        });
        assert.equal(result.messages, 0);
        return result;
      });
      await measure("final-drained", async () => {
        const result = await crawl(current, {
          updated: true,
          recipients: [
            { user: 0, filters: broad },
            { user: 1, filters: broad },
            { user: values.users, filters: broad },
          ],
        });
        assert.equal(result.messages, 0);
        return result;
      });
    }
    const absentDecisions = database
      .prepare(
        "SELECT count(*) AS count FROM private_delivery_decisions WHERE item_id GLOB 'absent-*' AND decided_at = ?",
      )
      .get(Date.parse(stamp)).count;
    if (values.phase !== "ordering")
      assert.equal(
        absentDecisions,
        values.decisions - values.listings * values.users,
        "Historical decisions for absent listings must survive every phase",
      );
    results.at(-1).retainedAbsentDecisions = absentDecisions;
    process.send(results);
  } finally {
    database.close();
  }
}
async function main() {
  const directory = await mkdtemp(
    path.join(process.env.BASELINE_DATA_ROOT || tmpdir(), "retained-baseline-"),
  );
  const results = [];
  const start = performance.now();
  const cpu = process.cpuUsage();
  let revision = process.env.BASELINE_REVISION || "unknown";
  try {
    revision =
      process.env.BASELINE_REVISION ||
      execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
  } catch {
    /* Image revision is supplied by the runner. */
  }
  try {
    for (const phase of ["seed", "steady", "recovery", "ordering"]) {
      const phases = await new Promise((resolve, reject) => {
        let result;
        const child = fork(
          fileURLToPath(import.meta.url),
          [
            ...process.argv.slice(2),
            "--phase",
            phase,
            "--directory",
            phase === "ordering" ? path.join(directory, "ordering") : directory,
          ],
          { stdio: ["ignore", "inherit", "inherit", "ipc"] },
        );
        child.on("message", (message) => {
          result = message;
        });
        child.on("error", reject);
        child.on("exit", (code) =>
          code === 0 && result
            ? resolve(result)
            : reject(new Error(`Worker ${phase} failed (${code})`)),
        );
      });
      results.push(...phases);
    }
    const delivered = new Set();
    for (const result of results.filter((result) =>
      ["interrupted", "resumed"].includes(result.phase),
    ))
      for (const [user, items] of Object.entries(result.sent))
        for (const item of items) {
          const key = `${user}:${item}`;
          assert(!delivered.has(key), "Duplicate across restart");
          delivered.add(key);
        }
    for (const result of results) delete result.sent;
    const usage = process.cpuUsage(cpu);
    console.log(
      JSON.stringify(
        {
          status: "passed",
          node: process.version,
          revision,
          image: process.env.BASELINE_IMAGE || null,
          platform: `${process.platform}/${process.arch}`,
          workload: values,
          limits: {
            cpu: textFile("/sys/fs/cgroup/cpu.max"),
            memoryBytes: numberFile("/sys/fs/cgroup/memory.max"),
          },
          coordinator: {
            wallMs: performance.now() - start,
            cpuMs: (usage.user + usage.system) / 1000,
            maxRssBytes: process.resourceUsage().maxRSS * 1024,
          },
          results,
          duplicateDeliveries: 0,
          pendingDeliveries: 0,
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
await (values.phase ? worker() : main());

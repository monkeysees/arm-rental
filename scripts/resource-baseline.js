import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { crawlApartments } from "../src/crawler.js";
import { deliveryAnnouncementText } from "../src/filter-ui.js";
import { emptyFilters } from "../src/filters.js";
import { PrivateDeliveryRateLimiter } from "../src/rate-limit.js";
import { openStateDatabase } from "../src/sqlite-database.js";
import { createSqliteRepositories } from "../src/sqlite-repositories.js";
import { createSqliteStateAccess } from "../src/sqlite-state-access.js";
import { LIST_AM_SOURCES, LIST_AM_URL_TEMPLATE } from "../src/target.js";
import { formatApartmentMessage } from "../src/telegram.js";

const { values } = parseArgs({
  options: {
    users: { type: "string", default: "1000" },
    listings: { type: "string", default: "20" },
    history: { type: "string", default: "250" },
    rate: { type: "string", default: "20" },
    scenario: { type: "string", default: "all" },
    phase: { type: "string" },
    directory: { type: "string" },
  },
});
for (const name of ["users", "listings", "history", "rate"]) {
  values[name] = Number(values[name]);
  assert(
    Number.isSafeInteger(values[name]) &&
      values[name] >= (name === "history" ? 0 : 1),
    `Invalid ${name}`,
  );
}
assert(["all", "mixed"].includes(values.scenario), "Invalid scenario");
assert(
  values.listings >= 4,
  "At least four listings are needed for both categories and price cohorts",
);
const TIME = "2026-09-10T12:00:00.000Z";
const PHASES = [
  "seed",
  "initial",
  "unchanged",
  "interrupted",
  "resumed",
  "verified",
];
const expectedPerBatch =
  values.scenario === "all"
    ? values.users * values.listings
    : Array.from(
        { length: 4 },
        (_, cohort) =>
          Math.max(0, Math.ceil((values.users - cohort) / 4)) *
          Math.max(0, Math.ceil((values.listings - cohort) / 4)),
      ).reduce((sum, count) => sum + count, 0);
assert(
  Number.isSafeInteger(expectedPerBatch) && expectedPerBatch >= 2,
  "Workload must produce at least two deliveries per batch",
);
const FAIL_AFTER = Math.min(
  expectedPerBatch - 1,
  Math.max(1, Math.floor(values.users / 2)),
);

function readNumber(filename) {
  try {
    return Number(readFileSync(filename, "utf8").trim());
  } catch {
    return null;
  }
}

function listings(batch, kind) {
  return Array.from({ length: values.listings }, (_, index) => ({
    id: String(999999990000000 + batch * values.listings + index),
    kind: index % 2 === 0 ? "apartment" : "house",
    price: 100000 + (index % 4) * 100000,
  })).filter((listing) => listing.kind === kind);
}

function fixture(batch, kind) {
  return `<html><body><div id="contentr">${listings(batch, kind)
    .map(
      ({ id, price }) => `
    <a class="category-data-list-card__destination" href="/ru/item/${id}">
      <div class="dltitle">Synthetic rental ${id}</div>
      <div class="p">${price} ֏</div><div class="l">Арабкир</div>
      <div class="at">2 ком. · 60 кв.м. · 3/9 этаж</div>
      <div class="d">Четверг, Сентябрь 10, 2026, ${batch ? "11:30" : "11:00"}</div>
    </a>`,
    )
    .join("")}</div></body></html>`;
}

async function worker() {
  assert(
    typeof process.send === "function",
    "Worker phases are internal to the benchmark coordinator",
  );
  assert(PHASES.includes(values.phase), "Invalid phase");
  assert(values.directory, "Worker needs its isolated data directory");
  let transactions = 0;
  let transactionMs = 0;
  const database = openStateDatabase({
    dataDirectory: values.directory,
    listUrlTemplate: LIST_AM_URL_TEMPLATE,
    create: values.phase === "seed",
    onMetric: (metric) => {
      if (metric.name === "state.transaction.completed") {
        transactions += 1;
        transactionMs += metric.durationMs;
      }
    },
  });
  const repositories = createSqliteRepositories(database, {
    listUrlTemplate: LIST_AM_URL_TEMPLATE,
  });
  const stateAccess = createSqliteStateAccess(database, repositories);
  const sent = [];
  let announcements = 0;
  let payloadBytes = 0;
  let interrupted = false;
  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  loopDelay.enable();
  const cpuStart = process.cpuUsage();
  const start = performance.now();
  try {
    if (values.phase === "seed") {
      const history = Object.fromEntries(
        Array.from({ length: values.history }, (_, index) => [
          `history-${index}`,
          "2026-08-01T00:00:00.000Z",
        ]),
      );
      database.transaction("baseline_seed", () => {
        for (let index = 0; index < values.users; index += 1) {
          const filters = { ...emptyFilters(), kinds: ["apartment", "house"] };
          if (values.scenario === "mixed")
            filters.price = {
              min: 100000 + (index % 4) * 100000,
              max: 100000 + (index % 4) * 100000,
            };
          repositories.telegram.saveUser(
            {
              chatId: index + 1,
              active: true,
              sendInitialApartments: true,
              filters,
              pendingFilterInput: null,
            },
            { transaction: false },
          );
          repositories.privateDeliveries.addDecisions(
            String(index + 1),
            "filtered",
            history,
            { transaction: false },
          );
        }
      });
    } else {
      const batch = ["interrupted", "resumed", "verified"].includes(
        values.phase,
      )
        ? 1
        : 0;
      const htmlFor = (url) => {
        const location = new URL(url);
        if (location.pathname.split("/").at(-1) !== "1")
          return '<div id="contentr"></div>';
        return fixture(
          batch,
          location.pathname.includes("/1377/") ? "house" : "apartment",
        );
      };
      const fetchPage = async (url) => new Response(htmlFor(url));
      const limiter = new PrivateDeliveryRateLimiter({
        deliveriesPerMinute: values.rate,
      });
      const users = Object.values(repositories.telegram.load().users).filter(
        (user) => user.active,
      );
      assert.equal(users.length, values.users);
      const privateDeliveries = users.map((user) => {
        const recipientId = String(user.chatId);
        const send = (text, itemId) =>
          limiter.run(recipientId, async () => {
            if (values.phase === "interrupted" && sent.length >= FAIL_AFTER) {
              interrupted = true;
              throw new Error("BASELINE_DELIVERY_INTERRUPTED");
            }
            payloadBytes += Buffer.byteLength(text);
            if (itemId) sent.push(`${recipientId}:${itemId}`);
            else announcements += 1;
          });
        return {
          recipientId,
          filters: user.filters,
          sendInitialApartments: user.sendInitialApartments,
          announceDelivery: ({ count }) =>
            send(deliveryAnnouncementText(count)),
          deliverApartment: (apartment) =>
            send(formatApartmentMessage(apartment), apartment.itemId),
        };
      });
      try {
        await crawlApartments(
          {
            listUrlTemplate: LIST_AM_URL_TEMPLATE,
            listSources: LIST_AM_SOURCES,
            initialPageCount: 1,
            initialDeliveryLimit: values.listings,
          },
          {
            stateAccess,
            fetchPage,
            privateDeliveries,
            now: () => new Date(TIME),
          },
        );
      } catch (error) {
        if (error.message !== "BASELINE_DELIVERY_INTERRUPTED" || !interrupted)
          throw error;
      }
      assert.equal(interrupted, values.phase === "interrupted");
      if (["unchanged", "verified"].includes(values.phase))
        assert.equal(sent.length, 0, "Acknowledged listings were resent");
    }
    const cpu = process.cpuUsage(cpuStart);
    const result = {
      phase: values.phase,
      wallMs: Math.round(performance.now() - start),
      nodeCpuMs: Math.round((cpu.user + cpu.system) / 1000),
      nodeMaxRssMiB: process.resourceUsage().maxRSS / 1024,
      eventLoopMaxMs: loopDelay.max / 1e6,
      transactions,
      transactionMs,
      messages: sent.length,
      announcements,
      payloadBytes,
      interrupted,
      sent,
    };
    if (values.phase === "verified") {
      // Check retention in SQLite after timing the crawl, without loading the
      // history into JavaScript just to verify that it survived.
      result.retainedHistoryDecisions = database
        .prepare(
          `SELECT count(*) AS count FROM private_delivery_decisions
          WHERE item_id GLOB 'history-*' AND status = 2
          AND decided_at = 1785542400000`,
        )
        .get().count;
      assert.equal(
        result.retainedHistoryDecisions,
        values.users * values.history,
        "Retained historical decisions changed or disappeared",
      );
    }
    database.close();
    result.databaseBytes = statSync(
      path.join(values.directory, "state.sqlite3"),
    ).size;
    process.send(result);
  } finally {
    loopDelay.disable();
    database.close();
  }
}

async function main() {
  const directory = await mkdtemp(
    path.join(
      process.env.BASELINE_DATA_ROOT || tmpdir(),
      "arm-rental-baseline-",
    ),
  );
  const results = [];
  const sent = new Set();
  let peakCgroupBytes = 0;
  const report = (error) =>
    console.log(
      JSON.stringify(
        {
          status: error ? "failed" : "passed",
          node: process.version,
          platform: `${process.platform}/${process.arch}`,
          workload: values,
          results,
          sampledCgroupPeakMiB: peakCgroupBytes
            ? peakCgroupBytes / 1024 ** 2
            : null,
          lifetimeCgroupPeakMiB:
            (readNumber("/sys/fs/cgroup/memory.peak") || 0) / 1024 ** 2 || null,
          ...(error
            ? { error: error.message }
            : { duplicateDeliveries: 0, pendingDeliveries: 0 }),
        },
        null,
        2,
      ),
    );
  const sample = setInterval(() => {
    peakCgroupBytes = Math.max(
      peakCgroupBytes,
      readNumber("/sys/fs/cgroup/memory.current") || 0,
    );
  }, 25);
  try {
    for (const phase of PHASES) {
      const result = await new Promise((resolve, reject) => {
        let result;
        const child = fork(
          fileURLToPath(import.meta.url),
          [
            ...process.argv.slice(2),
            "--phase",
            phase,
            "--directory",
            directory,
          ],
          { stdio: ["ignore", "inherit", "inherit", "ipc"] },
        );
        child.on("message", (message) => {
          result = message;
        });
        child.on("error", reject);
        child.on("exit", (code, signal) =>
          code === 0 && result
            ? resolve(result)
            : reject(new Error(`Phase ${phase} failed: ${code ?? signal}`)),
        );
      });
      for (const key of result.sent) {
        assert(
          !sent.has(key),
          "A delivery was duplicated across process restarts",
        );
        sent.add(key);
      }
      assert.equal(
        result.announcements,
        ["initial", "resumed"].includes(phase)
          ? new Set(result.sent.map((key) => key.split(":")[0])).size
          : 0,
        "History announcements changed",
      );
      delete result.sent;
      results.push(result);
      console.error(JSON.stringify(result));
    }
    assert.equal(
      results.find((result) => result.phase === "initial").messages,
      expectedPerBatch,
    );
    assert.equal(
      sent.size,
      expectedPerBatch * 2,
      "Pending messages did not drain completely",
    );
    report();
  } catch (error) {
    report(error);
    throw error;
  } finally {
    clearInterval(sample);
    await rm(directory, { recursive: true, force: true });
  }
}

await (values.phase ? worker() : main());

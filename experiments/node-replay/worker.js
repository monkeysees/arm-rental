import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { crawlApartments } from "../../src/crawler.js";
import { openStateDatabase } from "../../src/sqlite-database.js";
import { createSqliteRepositories } from "../../src/sqlite-repositories.js";
import { createSqliteStateAccess } from "../../src/sqlite-state-access.js";
import { PrivateDeliveryRateLimiter } from "../../src/rate-limit.js";
import { LIST_AM_SOURCES, LIST_AM_URL_TEMPLATE } from "../../src/target.js";
import {
  contract,
  retainedIds,
  absentIds,
  sequence,
  groupOf,
  filtersFor,
  phasePage,
  phases,
} from "./fixture.js";
import { replayClock } from "./clock.js";
import { memory, size, distribution } from "./metrics.js";

const [directory, stage, population, mode, resultFile] = process.argv.slice(2);
const users = Number(population);
const options = {
  dataDirectory: directory,
  listUrlTemplate: LIST_AM_URL_TEMPLATE,
};
let transactionProfile = {};
const db = openStateDatabase({
  ...options,
  create: stage === "seed",
  onMetric: (metric) => {
    if (metric.name !== "state.transaction.completed") return;
    const entry = (transactionProfile[metric.operation] ??= {
      count: 0,
      rowsChanged: 0,
      durationMs: 0,
    });
    entry.count++;
    entry.rowsChanged += metric.rowsChanged;
    entry.durationMs += metric.durationMs;
  },
});
const repos = createSqliteRepositories(db, options);
const access = createSqliteStateAccess(db, repos);
const config = {
  listUrlTemplate: LIST_AM_URL_TEMPLATE,
  listSources: LIST_AM_SOURCES,
  initialPageCount: 1,
  initialDeliveryLimit: contract.initialDeliveryLimit,
};
const results = [];
const idleMemory = memory();
let phaseNumber = stage === "resume" ? 20 : 0;
const stamp = contract.seed.timestamp;
const priorRun =
  stage === "resume"
    ? JSON.parse(readFileSync(`${directory}/exercise.json`, "utf8"))
    : null;
const restartGapMs = priorRun
  ? mode === "virtual"
    ? 1000
    : Date.now() - priorRun.completedAt
  : 0;

async function crawl(name) {
  transactionProfile = {};
  const fixture = phases.find((phase) => phase.name === name);
  const ids = fixture.ids;
  const deliver = !fixture.action.startsWith("store-without-delivery");
  const interrupt = name === "interrupted";
  console.error(`${mode} ${users}: ${name}`);
  const clock = replayClock(mode);
  const transport = contract.transport;
  const limiter = new PrivateDeliveryRateLimiter({
    deliveriesPerMinute: transport.recipientMessagesPerMinute,
    monotonicNow: clock.now,
    sleep: clock.sleep,
  });
  const epoch =
    Date.parse(contract.clockEpoch) + ++phaseNumber * contract.crawlIntervalMs;
  const sent = Array.from({ length: users }, () => []);
  const classifications = [];
  let classifiedRecipients = 0,
    classificationWallMs = 0;
  const announced = new Set();
  const ages = [],
    first = [];
  const progressCounts = Array(9).fill(0);
  progressCounts[0] = users;
  let minimumProgress = 0,
    maximumProgress = 0,
    maximumLead = 0;
  const queueAgeOffset =
    name === "resumed"
      ? priorRun.results.at(-1).clockDrainMs + restartGapMs
      : 0;
  let attempts = 0,
    retries = 0,
    announcements = 0,
    active = 0,
    peakActive = 0;
  let globalReadyAt = 0,
    classifiedAt,
    firstSendAt;
  const started = performance.now(),
    cpu = process.cpuUsage();
  const before = memory();
  let sampledPeak = before.rss,
    sampledServicePeak = before.serviceCurrentBytes;
  const sample = setInterval(() => {
    const current = memory();
    sampledPeak = Math.max(sampledPeak, current.rss);
    sampledServicePeak = Math.max(
      sampledServicePeak,
      current.serviceCurrentBytes,
    );
  }, 20);
  const targets = Array.from({ length: users }, (_, user) => {
    const recipientId = String(user + 1),
      group = user % 4;
    let retryAt = 0,
      retrying = false,
      injected = false;
    const tokenTimes = [];
    let classified = false;
    async function send(apartment, count) {
      classifiedAt ??= performance.now() - started;
      firstSendAt ??= clock.now();
      if (interrupt && sent[user].length === 2)
        throw new Error("REPLAY_INTERRUPT");
      if (apartment) {
        const expected = contract.expected[name][group][sent[user].length];
        assert.equal(
          apartment.itemId,
          expected,
          `${name}: recipient ${recipientId} order`,
        );
        assert.equal(
          apartment.title,
          `Replay rental ${expected}${name === "updated" ? " updated" : ""}`,
        );
        assert.equal(apartment.price.amountAmd, contract.profiles[group].price);
        assert.equal(
          apartment.price.originalAmount,
          contract.profiles[group].originalAmount,
        );
        assert.equal(
          apartment.price.originalCurrency,
          contract.profiles[group].currency,
        );
        assert.equal(apartment.areaSqM, 60);
        assert.equal(apartment.floor, "3/9");
        assert.equal(apartment.url, `https://www.list.am/ru/item/${expected}`);
        assert.equal(apartment.kind, contract.profiles[group].kind);
        assert.equal(apartment.rooms, 2);
        assert.equal(apartment.location, "Арабкир");
        if (name === "catchup" || name === "resumed")
          assert(announced.has(user));
      }
      return limiter.run(
        recipientId,
        async () => {
          if (!retrying) {
            tokenTimes.push(clock.now());
            for (let i = 0; i < tokenTimes.length; i++) {
              assert(
                tokenTimes.length - i <=
                  transport.recipientBurst +
                    Math.floor(
                      ((clock.now() - tokenTimes[i] + 0.001) *
                        transport.recipientMessagesPerMinute) /
                        60000,
                    ),
                "recipient transport rate exceeded",
              );
            }
          }
          assert(
            clock.now() + 0.001 >= globalReadyAt,
            "global transport rate exceeded",
          );
          globalReadyAt =
            clock.now() + 1000 / transport.globalAttemptsPerSecond;
          attempts++;
          active++;
          peakActive = Math.max(peakActive, active);
          await clock.transport(transport.latencyMs);
          active--;
          if (
            name === "catchup" &&
            apartment &&
            user % transport.retryRecipientsModulo === 0 &&
            !injected
          ) {
            injected = true;
            retrying = true;
            retryAt = clock.now() + transport.retryAfterMs;
            retries++;
            return { deferred: true };
          }
          if (retrying) assert(clock.now() >= retryAt);
          retrying = false;
          if (!apartment) {
            assert.equal(count, contract.expected[name][group].length);
            assert(!announced.has(user));
            announced.add(user);
            announcements++;
          } else {
            if (!sent[user].length) first.push(clock.now());
            ages.push(queueAgeOffset + clock.now());
            progressCounts[sent[user].length]--;
            sent[user].push(apartment.itemId);
            progressCounts[sent[user].length]++;
            while (!progressCounts[minimumProgress]) minimumProgress++;
            maximumProgress = Math.max(maximumProgress, sent[user].length);
            maximumLead = Math.max(
              maximumLead,
              maximumProgress - minimumProgress,
            );
          }
        },
        { consumeToken: !retrying },
      );
    }
    return {
      recipientId,
      runDeliveryWorker: async (operation) => {
        await operation();
        if (!classified) {
          classified = true;
          classifiedRecipients++;
          if (classifiedRecipients === users)
            classificationWallMs = performance.now() - started;
        }
      },
      filters: filtersFor(group),
      sendInitialApartments: true,
      deliveryDelayMs: () =>
        Math.max(
          globalReadyAt - clock.now(),
          retrying ? retryAt - clock.now() : limiter.delayMs(recipientId),
          0,
        ),
      announceDelivery: ({ count }) => send(null, count),
      deliverApartment: (apartment) => send(apartment),
    };
  });
  let interrupted = false;
  try {
    await crawlApartments(config, {
      stateAccess: access,
      exchangeRates: contract.exchangeRates,
      now: () => new Date(epoch + clock.now()),
      fetchPage: async (url) =>
        new Response(
          new URL(url).pathname.split("/").at(-1) === "1"
            ? phasePage(fixture, url.includes("/1377/") ? "house" : "apartment")
            : '<div id="contentr"></div>',
        ),
      deliverySleep: clock.sleep,
      privateDeliveries: deliver ? targets : [],
    });
  } catch (error) {
    if (!interrupt || error.message !== "REPLAY_INTERRUPT") throw error;
    interrupted = true;
  } finally {
    clearInterval(sample);
  }
  assert.equal(interrupted, interrupt);
  assert.equal(active, 0);
  assert(peakActive <= 8);
  if (name === "catchup") {
    assert.equal(retries, Math.ceil(users / transport.retryRecipientsModulo));
    assert.equal(announcements, users);
  }
  if (deliver) {
    for (let user = 0; user < users; user++) {
      assert.deepEqual(
        sent[user],
        contract.expected[name][user % 4],
        `${name}: complete output for ${user + 1}`,
      );
      const recipient = repos.privateDeliveries.loadRecipient(
        String(user + 1),
        ids,
      );
      const outcomes = Object.fromEntries(
        ids.map((id) => [
          id,
          ["notified", "skipped", "filtered"].find(
            (status) => recipient[status][id],
          ) ?? "pending",
        ]),
      );
      if (user < 4) classifications.push(outcomes);
      else assert.deepEqual(outcomes, classifications[user % 4]);
      for (const id of sent[user])
        assert(recipient.notified[id], "durable acknowledgement missing");
      for (const id of ids) {
        if (groupOf(id) !== user % 4)
          assert(recipient.filtered[id], "nonmatch must be filtered");
      }
      if (name === "catchup") {
        for (const id of contract.expected.skippedCatchup[user % 4])
          assert(recipient.skipped[id]);
      }
    }
  }
  const usage = process.cpuUsage(cpu),
    wallMs = performance.now() - started;
  const sentCount = sent.reduce((total, items) => total + items.length, 0);
  const summary = {
    name,
    transactionProfile,
    wallMs,
    cpuMs: (usage.user + usage.system) / 1000,
    clockMode: mode,
    clockDrainMs: clock.now(),
    sent: sentCount,
    attempts,
    retries,
    announcements,
    firstSendWallMs: classifiedAt ?? wallMs,
    classificationWallMs,
    classifiedRecipients,
    firstSendClockMs: firstSendAt ?? 0,
    queueAgeMs: distribution(ages),
    firstRecipientProgressMs: distribution(first),
    recipientsWithProgress: first.length,
    maximumRecipientLead: maximumLead,
    peakActive,
    queueAgeOffsetMs: queueAgeOffset,
    wallMessagesPerSecond: mode === "wall" ? sentCount / (wallMs / 1000) : null,
    memoryBefore: before,
    memoryAfter: memory(),
    sampledPeakRssBytes: sampledPeak,
    sampledPeakServiceBytes: sampledServicePeak,
    databaseBytes: size(db.filename),
    walBytes: size(`${db.filename}-wal`),
    deliveriesByProfile: deliver ? sent.slice(0, 4) : null,
    classificationsByProfile: deliver ? classifications : null,
    recipientsAsserted: deliver ? users : 0,
  };
  results.push(summary);
  return summary;
}
function verifyRetained() {
  for (let user = 0; user < users; user++) {
    const recipient = repos.privateDeliveries.loadRecipient(
      String(user + 1),
      absentIds,
    );
    for (const id of absentIds) {
      const status = groupOf(id) === user % 4 ? "notified" : "filtered";
      assert.equal(recipient[status][id], stamp);
    }
  }
}
try {
  if (stage === "seed") {
    await crawl("seed");
    const start = performance.now(),
      cpu = process.cpuUsage();
    db.transaction("replay_seed", () => {
      for (let user = 0; user < users; user++) {
        const filtered = {};
        for (const id of [...retainedIds, ...absentIds]) {
          if (groupOf(id) === user % 4)
            repos.privateDeliveries.acknowledge(String(user + 1), id, stamp, {
              transaction: false,
            });
          else filtered[id] = stamp;
        }
        repos.privateDeliveries.initializeSelection(
          String(user + 1),
          { filtered },
          { transaction: false },
        );
      }
    });
    const usage = process.cpuUsage(cpu);
    results.push({
      name: "seed-decisions",
      wallMs: performance.now() - start,
      cpuMs: (usage.user + usage.system) / 1000,
      memoryAfter: memory(),
      decisions: users * contract.seed.decisionsPerRecipient,
      databaseBytes: size(db.filename),
      walBytes: size(`${db.filename}-wal`),
    });
  } else if (stage === "exercise") {
    await crawl("unchanged");
    results.at(-1).bootstrap = true;
    for (let i = 0; i < contract.measurement.steadySamples; i++)
      await crawl("unchanged");
    await crawl("updated");
    await crawl("fresh");
    await crawl("catchup-store");
    for (let user = 0; user < users; user++)
      repos.privateDeliveries.requestSelection(String(user + 1));
    await crawl("catchup");
    await crawl("interrupted");
  } else {
    // Verify the interrupted prefix before any resumed delivery can mask a lost acknowledgement.
    for (let user = 0; user < users; user++) {
      const recipient = repos.privateDeliveries.loadRecipient(
        String(user + 1),
        sequence(400000, 32),
      );
      for (const id of contract.expected.interrupted[user % 4])
        assert(recipient.notified[id]);
      for (const id of contract.expected.resumed[user % 4])
        assert(!recipient.notified[id]);
    }
    await crawl("resumed");
    await crawl("drained");
    await crawl("returning");
  }
  verifyRetained();
  writeFileSync(
    resultFile,
    JSON.stringify({
      stage,
      idleMemory,
      results,
      completedAt: Date.now(),
      restartGapMs,
      retainedAbsentDecisions: users * absentIds.length,
    }),
  );
  if (stage === "exercise") process.exit(23);
} finally {
  db.close();
}

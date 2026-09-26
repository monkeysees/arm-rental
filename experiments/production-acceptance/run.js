import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { openStateDatabase } from "../../src/sqlite-database.js";
import { createSqliteRepositories } from "../../src/sqlite-repositories.js";
import { normalizeFilters } from "../../src/filters.js";
import { formatApartmentMessage } from "../../src/telegram.js";
import { normalizeApartmentPrice } from "../../src/prices.js";
import { formatPostingDate } from "../../src/posting-date.js";
import { LIST_AM_URL_TEMPLATE } from "../../src/target.js";
import {
  contract,
  phases,
  phasePage,
  filtersFor,
  groupOf,
} from "../node-replay/fixture.js";
import { evaluateCapacity } from "../node-replay/capacity.js";

const { values } = parseArgs({
  options: {
    binary: { type: "string" },
    image: { type: "string" },
    output: { type: "string" },
    users: { type: "string", default: "500" },
    phases: { type: "string", default: "catchup" },
    "keep-state": { type: "boolean", default: false },
  },
});
assert(
  (values.binary || values.image) && values.output,
  "--binary or --image and fresh --output directory required",
);
const users = Number(values.users);
assert([4, 500].includes(users));
assert(["catchup", "all"].includes(values.phases));
const binary = values.binary ? path.resolve(values.binary) : null,
  output = path.resolve(values.output),
  directory = path.join(output, "state");
await mkdir(output, { mode: 0o700 });
await mkdir(directory, { mode: 0o700 });
let imageId = null;
const imageBinaryPath = "/usr/local/bin/rental-app";
const containerPrefix = `rental-acceptance-${process.pid}`;
if (values.image) {
  imageId = (
    await run("docker", [
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      values.image,
    ])
  ).trim();
  const extractionContainer = `${containerPrefix}-identity`;
  await run("docker", ["create", "--name", extractionContainer, imageId]);
  try {
    await run("docker", [
      "cp",
      `${extractionContainer}:${imageBinaryPath}`,
      path.join(output, "packaged-rental-app"),
    ]);
  } finally {
    await run("docker", ["rm", extractionContainer]);
  }
}
const report = {
  version: 1,
  status: "running",
  runtime: "full-native-production",
  users,
  diagnostic: users !== 500,
  mode: "wall",
  node: process.version,
  startedAt: new Date().toISOString(),
  binarySha256: createHash("sha256")
    .update(
      await readFile(
        imageId ? path.join(output, "packaged-rental-app") : binary,
      ),
    )
    .digest("hex"),
  imageId,
  contractSha256: createHash("sha256")
    .update(
      await readFile(new URL("../node-replay/contract.json", import.meta.url)),
    )
    .digest("hex"),
  phases: [],
  memoryGate: null,
};
const stamp = formatPostingDate(Date.now());
let fixture = phases.find((p) => p.name === "catchup-store"),
  current = null,
  nextSlot = 0,
  server,
  child;
let activeContainer = null;
const env = {
  NODE_ENV: "test",
  DATA_DIRECTORY: directory,
  TELEGRAM_BOT_TOKEN: "123:synthetic-acceptance-token",
  TELEGRAM_OWNER_ID: "1",
  CURL_IMPERSONATE_PATH: imageId
    ? "/usr/local/bin/curl-impersonate"
    : "/usr/bin/curl",
  ...(imageId ? { SQLITE_TMPDIR: "/sqlite-tmp" } : {}),
  INITIAL_PAGE_COUNT: "1",
  INITIAL_DELIVERY_LIMIT: String(contract.initialDeliveryLimit),
  POLL_INTERVAL_MS: "60000",
  TELEGRAM_POLL_TIMEOUT_SECONDS: "1",
  TELEGRAM_PRIVATE_DELIVERIES_PER_MINUTE: String(
    contract.transport.recipientMessagesPerMinute,
  ),
  EXTERNAL_RETRY_BASE_MS: "10",
  EXTERNAL_RETRY_MAX_MS: "100",
};
function nativeInvocation(args, extraEnv, name) {
  if (!imageId)
    return {
      program: binary,
      args,
      env: { PATH: process.env.PATH, ...extraEnv },
    };
  return {
    program: "docker",
    args: [
      "run",
      "--rm",
      "--init",
      "--name",
      name,
      "--network",
      "host",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--user",
      "1000:1000",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=64m",
      "--tmpfs",
      "/sqlite-tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000",
      "--mount",
      `type=bind,source=${directory},target=${directory}`,
      ...Object.entries(extraEnv).flatMap(([key, value]) => [
        "--env",
        `${key}=${value}`,
      ]),
      "--entrypoint",
      imageBinaryPath,
      "-i",
      imageId,
      ...args,
    ],
    env: process.env,
  };
}
async function stopNative(interrupted = false) {
  if (activeContainer) {
    await run(
      "docker",
      interrupted
        ? ["kill", "--signal", "KILL", activeContainer]
        : ["stop", "--time", "15", activeContainer],
    );
    activeContainer = null;
  } else child.kill(interrupted ? "SIGKILL" : "SIGTERM");
}
function database() {
  return openStateDatabase({
    dataDirectory: directory,
    listUrlTemplate: LIST_AM_URL_TEMPLATE,
  });
}
function repositories(db) {
  return createSqliteRepositories(db, {
    listUrlTemplate: LIST_AM_URL_TEMPLATE,
  });
}
function historicalDigest() {
  const db = database();
  try {
    const hash = createHash("sha256");
    let count = 0;
    for (const row of db
      .prepare(
        "SELECT recipient_id,item_id,status,decided_at FROM private_delivery_decisions WHERE item_id >= '100008' AND item_id < '200000' ORDER BY recipient_id,item_id",
      )
      .iterate()) {
      hash.update(
        JSON.stringify([
          row.recipient_id,
          row.item_id,
          row.status,
          row.decided_at,
        ]) + "\n",
      );
      count++;
    }
    return { count, sha256: hash.digest("hex") };
  } finally {
    db.close();
  }
}
async function run(program, args, { input, extraEnv } = {}) {
  const p = spawn(program, args, {
    env: extraEnv ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  p.stdout.on("data", (s) => (stdout += s));
  p.stderr.on("data", (s) => (stderr += s));
  p.stdin.end(input);
  const exit = await new Promise((resolve, reject) => {
    p.on("error", reject);
    p.on("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.equal(exit.code, 0, stderr);
  return stdout;
}
async function unusedPort() {
  const s = createServer();
  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
  const port = s.address().port;
  await new Promise((resolve) => s.close(resolve));
  return port;
}
function sourceHtml(url) {
  if (new URL(url, "http://127.0.0.1").pathname.split("/").at(-1) !== "1")
    return '<div id="contentr"></div>';
  return phasePage(
    fixture,
    url.includes("/1377/") ? "house" : "apartment",
  ).replaceAll("Среда, Сентябрь 16, 2026, 10:00", stamp);
}
async function peer(request, response) {
  if (request.url.startsWith("/ru/category/")) {
    response.setHeader("content-type", "text/html");
    response.end(sourceHtml(request.url));
    return;
  }
  if (request.url === "/cba") {
    response.setHeader("content-type", "text/xml");
    response.end(
      `<ExchangeRatesLatestResult><CurrentDate>${new Date().toISOString().slice(0, 10)}</CurrentDate>${["USD", "EUR", "RUB"].map((iso) => `<ExchangeRate><ISO>${iso}</ISO><Amount>1</Amount><Rate>400</Rate></ExchangeRate>`).join("")}</ExchangeRatesLatestResult>`,
    );
    return;
  }
  const parts = [];
  for await (const part of request) parts.push(part);
  const payload = JSON.parse(Buffer.concat(parts));
  const method = request.url.split("/").at(-1);
  let result = true;
  if (method === "getMe") result = { id: 999, is_bot: true };
  if (method === "getUpdates") {
    await delay(100);
    result = [];
  }
  if (method === "sendMessage") {
    assert(current, "delivery outside measured phase");
    const user = Number(payload.chat_id) - 1;
    assert(user >= 0 && user < users, "unexpected recipient");
    const match = payload.text.match(
      /https:\/\/www\.list\.am\/ru\/item\/(\d+)/u,
    );
    const id = match?.[1];
    const now = performance.now();
    nextSlot =
      Math.max(nextSlot, now) +
      1000 / contract.transport.globalAttemptsPerSecond;
    current.attempts++;
    current.active++;
    current.peakActive = Math.max(current.peakActive, current.active);
    try {
      await delay(Math.max(0, nextSlot - now));
      if (
        id &&
        current.name === "catchup" &&
        user % contract.transport.retryRecipientsModulo === 0 &&
        !current.retryUsers.has(user)
      ) {
        current.retryUsers.add(user);
        current.retries++;
        response.writeHead(429, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ok: false,
            error_code: 429,
            parameters: { retry_after: 1 },
          }),
        );
        return;
      }
      if (
        id &&
        current.name === "interrupted" &&
        current.sent[user].length === 2
      ) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ok: false,
            error_code: 500,
            description: "Injected acceptance interruption",
          }),
        );
        return;
      }
      if (id) {
        const expected = contract.expected[current.name][user % 4];
        assert.equal(
          id,
          expected[current.sent[user].length],
          `${current.name}: recipient ${user + 1} ordering`,
        );
        const profile = contract.profiles[groupOf(id)];
        const listing = {
          itemId: id,
          kind: profile.kind,
          title: `Replay rental ${id}${Number(id) < 100008 ? " updated" : ""}`,
          url: `https://www.list.am/ru/item/${id}`,
          location: "Арабкир",
          rooms: 2,
          areaSqM: 60,
          floor: "3/9",
          price: normalizeApartmentPrice(
            { amount: profile.originalAmount, currency: profile.currency },
            {
              fetchedAt: "2026-09-16T10:00:00.000Z",
              effectiveDate: "2026-09-15",
              rates: { USD: { amount: 1, rate: 400 } },
            },
          ),
        };
        assert.equal(payload.text, formatApartmentMessage(listing));
        if (current.sent[user].length === 0)
          current.first[user] = performance.now();
        current.sent[user].push(id);
      } else {
        assert(
          ["catchup", "resumed"].includes(current.name),
          "unexpected history announcement",
        );
        assert(payload.text.includes(current.name === "catchup" ? "8" : "6"));
        assert(!current.announced.has(user));
        current.announced.add(user);
      }
      result = { message_id: current.attempts + 1000 };
    } finally {
      current.active--;
    }
  }
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ ok: true, result }));
}
function verifyPhase(name) {
  const expected = contract.expected[name];
  const db = database();
  try {
    const repos = repositories(db);
    const ids = phases.find((p) => p.name === name).ids;
    for (let user = 0; user < users; user++) {
      assert.deepEqual(
        current.sent[user],
        expected[user % 4],
        `${name} complete output ${user + 1}`,
      );
      const recipient = repos.privateDeliveries.loadRecipient(
        String(user + 1),
        ids,
      );
      for (const id of current.sent[user])
        assert(
          recipient.notified[id],
          `${name} missing durable acknowledgement`,
        );
      for (const id of ids)
        if (groupOf(id) !== user % 4)
          assert(recipient.filtered[id], `${name} missing filtered decision`);
      if (name === "catchup")
        for (const id of contract.expected.skippedCatchup[user % 4])
          assert(recipient.skipped[id], "catchup skip missing");
    }
    if (name === "catchup") {
      assert.equal(current.retries, Math.ceil(users / 10));
      assert.equal(current.announced.size, users);
    }
  } finally {
    db.close();
  }
}
async function servicePhase(name, origin) {
  fixture = phases.find((p) => p.name === name);
  current = {
    name,
    sent: Array.from({ length: users }, () => []),
    first: [],
    announced: new Set(),
    retryUsers: new Set(),
    attempts: 0,
    retries: 0,
    active: 0,
    peakActive: 0,
    started: null,
    completed: null,
    sourceCompleted: null,
    classificationWallMs: 0,
    classifiedRecipients: 0,
    events: [],
  };
  nextSlot = 0;
  const healthPort = await unusedPort();
  let stderr = "",
    pending = "";
  let terminalEvent = false;
  activeContainer = imageId ? `${containerPrefix}-${name}` : null;
  const invocation = nativeInvocation(
    [
      "serve",
      "--telegram-endpoint",
      `${origin}/telegram`,
      "--source-origin",
      origin,
      "--cba-endpoint",
      `${origin}/cba`,
    ],
    { ...env, HEALTH_PORT: String(healthPort) },
    activeContainer,
  );
  child = spawn(invocation.program, invocation.args, {
    env: invocation.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  );
  child.stderr.on("data", (s) => (stderr += s));
  child.stdout.on("data", (s) => {
    pending += s;
    let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      current.events.push(event);
      if (event.event === "crawl.started")
        current.started ??= performance.now();
      if (
        event.event === "source.integrity.checked" &&
        current.started !== null
      )
        current.sourceCompleted = performance.now();
      if (event.event === "private.classification.completed") {
        current.classifiedRecipients =
          event.recipients ??
          event.classifiedRecipients ??
          current.classifiedRecipients + 1;
        current.classificationWallMs =
          performance.now() - (current.started ?? performance.now());
      }
      if (
        event.event === "crawl.succeeded" ||
        (name === "interrupted" && event.event === "runtime.failed")
      ) {
        current.completed = performance.now();
        terminalEvent = true;
      }
    }
  });
  const deadline = Date.now() + 180000;
  while (!terminalEvent && child.exitCode === null && Date.now() < deadline)
    await delay(20);
  assert(
    terminalEvent,
    `${name}: no crawl completion; ${stderr}; ${JSON.stringify(current.events.slice(-8))}`,
  );
  await stopNative(name === "interrupted");
  const exit = await exited;
  if (name === "interrupted") {
    if (imageId) assert.equal(exit.code, 137);
    else assert.equal(exit.signal, "SIGKILL");
  } else assert.equal(exit.code, 0, stderr);
  child = null;
  assert(current.started !== null, "runtime must emit crawl.started");
  verifyPhase(name);
  const first = current.first
    .filter((v) => v !== undefined)
    .map((v) => v - current.started);
  const summary = {
    name,
    wallMs: current.completed - current.started,
    sourceWallMs:
      current.sourceCompleted === null
        ? null
        : current.sourceCompleted - current.started,
    deliveryWallMs:
      current.sourceCompleted === null
        ? null
        : current.completed - current.sourceCompleted,
    attempts: current.attempts,
    peakActive: current.peakActive,
    retries: current.retries,
    announcements: current.announced.size,
    sent: current.sent.reduce((n, v) => n + v.length, 0),
    classificationWallMs: current.classificationWallMs,
    classifiedRecipients: current.classifiedRecipients,
    recipientsWithProgress: first.length,
    firstRecipientProgressMs: { max: first.length ? Math.max(...first) : 0 },
    deliveriesByProfile: current.sent.slice(0, 4),
    recipientsAsserted: users,
    exit,
    events: current.events,
  };
  report.phases.push(summary);
  await writeFile(
    path.join(output, `${name}.json`),
    JSON.stringify(summary, null, 2) + "\n",
  );
  console.error(
    `${name}: ${summary.sent} messages, ${Math.round(summary.wallMs)} ms`,
  );
  return summary;
}
try {
  console.error(
    `Seeding ${users * contract.seed.decisionsPerRecipient} historical decisions`,
  );
  await run(process.execPath, [
    fileURLToPath(new URL("../node-replay/worker.js", import.meta.url)),
    directory,
    "seed",
    String(users),
    "virtual",
    path.join(output, "seed.json"),
  ]);
  report.retainedBefore = historicalDigest();
  report.seedDatabaseBytes = (
    await stat(path.join(directory, "state.sqlite3"))
  ).size;
  {
    const db = database();
    try {
      const repos = repositories(db);
      db.transaction("acceptance_users", () => {
        for (let user = 0; user < users; user++)
          repos.telegram.saveUser(
            {
              chatId: user + 1,
              active: true,
              sendInitialApartments: true,
              filters: normalizeFilters(filtersFor(user % 4)),
              pendingFilterInput: null,
            },
            { transaction: false },
          );
      });
    } finally {
      db.close();
    }
  }
  server = createServer((req, res) => {
    peer(req, res).catch((error) => {
      report.peerError = error.stack;
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  if (values.phases === "all")
    for (const name of ["unchanged", "updated", "fresh"])
      await servicePhase(name, origin);
  fixture = phases.find((p) => p.name === "catchup-store");
  const crawlInvocation = nativeInvocation(
    ["contract"],
    env,
    `${containerPrefix}-crawl`,
  );
  const stored = JSON.parse(
    await run(crawlInvocation.program, crawlInvocation.args, {
      extraEnv: crawlInvocation.env,
      input:
        JSON.stringify({
          op: "crawl",
          directory,
          endpoint: origin,
          env,
          nowMs: Date.now(),
          rates: {
            fetchedAt: new Date().toISOString(),
            effectiveDate: new Date().toISOString().slice(0, 10),
            rates: { USD: { amount: 1, rate: 400 } },
          },
        }) + "\n",
    }),
  );
  assert.equal(stored.error, undefined, JSON.stringify(stored));
  {
    const db = database();
    try {
      const repos = repositories(db);
      db.transaction("acceptance_selection", () => {
        for (let user = 0; user < users; user++)
          repos.privateDeliveries.requestSelection(String(user + 1), {
            transaction: false,
          });
      });
    } finally {
      db.close();
    }
  }
  await servicePhase("catchup", origin);
  if (values.phases === "all")
    for (const name of ["interrupted", "resumed", "drained", "returning"])
      await servicePhase(name, origin);
  report.retainedAfter = historicalDigest();
  assert.deepEqual(
    report.retainedAfter,
    report.retainedBefore,
    "historical decisions changed",
  );
  assert.equal(report.peerError, undefined, report.peerError);
  report.fullWallCapacityOracle = evaluateCapacity({
    users,
    mode: "wall",
    phases: report.phases,
    primaryRamBytes: null,
  });
  report.capacityMeasurement = {
    authorization:
      "User approved separating source pacing from catchup delivery capacity",
    routineOrigin: "crawl.started",
    catchupOrigin: "last source.integrity.checked",
    tolerance: contract.measurement.capacityDrainTolerance,
  };
  report.capacityOracle = evaluateCapacity({
    users,
    mode: "wall",
    phases: report.phases.map((phase) => {
      if (phase.name !== "catchup") return phase;
      assert(phase.sourceWallMs !== null, "catchup source completion required");
      return {
        ...phase,
        wallMs: phase.wallMs - phase.sourceWallMs,
        classificationWallMs: phase.classificationWallMs - phase.sourceWallMs,
        firstRecipientProgressMs: {
          max: phase.firstRecipientProgressMs.max - phase.sourceWallMs,
        },
      };
    }),
    primaryRamBytes: null,
  });
  for (const key of [
    "routineWithinCrawlInterval",
    "classificationWithinCrawlInterval",
    "catchupWithinPermittedRateTarget",
    "allRecipientsProgressed",
    "fairProgress",
  ]) {
    assert.equal(
      report.capacityOracle[key],
      true,
      `independent capacity contract failed: ${key}`,
    );
  }
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error.stack;
  throw error;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    await stopNative(true);
    await exited;
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  report.completedAt = new Date().toISOString();
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  if (report.status === "passed" && !values["keep-state"])
    await rm(directory, { recursive: true, force: true });
  console.error(`Report: ${path.join(output, "report.json")}`);
}

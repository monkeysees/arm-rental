import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

const binary = process.env.RENTAL_APP_BINARY;
const card = (id) =>
  `<a class="category-data-list-card__destination" href="/ru/item/${id}"><div class="pt">Квартира ${id}</div><div class="p">200000 ֏</div><div class="l">Кентрон</div><div class="at">2 ком. · 60 кв.м. · 2/5</div><div class="d">Сегодня, 00:00</div></a>`;

async function startup(t, { history, apartmentCount }) {
  const directory = await mkdtemp(join(tmpdir(), "rust-preflight-history-"));
  t.after(() =>
    rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    }),
  );
  const initialized = spawnSync(
    binary,
    ["state:init", "--data-directory", directory],
    {
      encoding: "utf8",
    },
  );
  assert.equal(initialized.status, 0, initialized.stderr);
  const databasePath = join(directory, "state.sqlite3");
  if (history) {
    const db = new DatabaseSync(databasePath);
    db.prepare(
      "INSERT INTO crawl_state(singleton,checked_at,last_crawl_json,source_integrity_json,sequence,total_count) VALUES(1,?,?,?,?,0)",
    ).run(
      "2026-09-26T00:00:00.000Z",
      JSON.stringify({ initialRun: true, pagesParsed: 0 }),
      JSON.stringify({
        recentFirstPageCounts: { apartment: history },
        lastSuccessfulAt: "2026-09-26T00:00:00.000Z",
      }),
      1,
    );
    db.close();
  }
  let apartmentFetches = 0;
  const server = createServer(async (request, response) => {
    if (request.url.startsWith("/ru/category/")) {
      const apartment = request.url.includes("/56/");
      if (apartment) apartmentFetches++;
      const count = apartment ? apartmentCount : 1;
      response.end(
        `<div id="contentr">${Array.from({ length: count }, (_, i) => card((apartment ? 100 : 200) + i)).join("")}</div>`,
      );
      return;
    }
    if (request.url === "/cba") {
      response.end(
        "<ExchangeRatesLatestResult><CurrentDate>2026-09-26</CurrentDate>" +
          ["USD", "EUR", "RUB"]
            .map(
              (iso) =>
                `<ExchangeRate><ISO>${iso}</ISO><Amount>1</Amount><Rate>400</Rate></ExchangeRate>`,
            )
            .join("") +
          "</ExchangeRatesLatestResult>",
      );
      return;
    }
    request.resume();
    const method = request.url.split("/").at(-1);
    const result =
      method === "getMe"
        ? { id: 10, is_bot: true }
        : method === "getUpdates"
          ? []
          : true;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, result }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const healthPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const child = spawn(
    binary,
    [
      "serve",
      "--telegram-endpoint",
      `${origin}/telegram`,
      "--source-origin",
      origin,
      "--cba-endpoint",
      `${origin}/cba`,
    ],
    {
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "test",
        DATA_DIRECTORY: directory,
        TELEGRAM_BOT_TOKEN: "123:synthetic-token",
        TELEGRAM_OWNER_ID: "123",
        CURL_IMPERSONATE_PATH: "/usr/bin/curl",
        HEALTH_PORT: String(healthPort),
        INITIAL_PAGE_COUNT: "1",
        POLL_INTERVAL_MS: "1000",
        EXTERNAL_RETRY_BASE_MS: "10",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
      await exited;
      clearTimeout(timer);
    }
  });
  const records = () =>
    output
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
  const deadline = Date.now() + 7000;
  while (
    !records().some((row) => row.event === "startup.preflight.completed") &&
    Date.now() < deadline
  )
    await delay(20);
  assert.ok(
    records().some((row) => row.event === "startup.preflight.completed"),
    output,
  );
  return {
    child,
    exited,
    records,
    databasePath,
    apartmentFetches: () => apartmentFetches,
    output: () => output,
  };
}

test(
  "native startup preflight rejects a first page count drop without changing crawl state",
  { skip: !binary, timeout: 12000 },
  async (t) => {
    const app = await startup(t, { history: [20, 20, 20], apartmentCount: 1 });
    const preflight = app
      .records()
      .find((row) => row.event === "startup.preflight.completed");
    assert.equal(preflight.preflight.ready, false, app.output());
    assert.equal(
      preflight.preflight.failure.code,
      "ERR_LIST_AM_SOURCE_INTEGRITY",
    );
    assert.equal(preflight.preflight.failure.reason, "FIRST_PAGE_COUNT_DROP");
    assert.ok(app.apartmentFetches() > 0);
    const db = new DatabaseSync(app.databasePath);
    assert.deepEqual(
      JSON.parse(
        db.prepare("SELECT source_integrity_json FROM crawl_state").get()
          .source_integrity_json,
      ).recentFirstPageCounts.apartment,
      [20, 20, 20],
    );
    assert.equal(
      db.prepare("SELECT total_count FROM crawl_state").get().total_count,
      0,
    );
    assert.equal(db.prepare("SELECT count(*) AS n FROM apartments").get().n, 0);
    db.close();
  },
);

for (const scenario of [
  {
    name: "normal first page with history",
    history: [20, 20, 20],
    apartmentCount: 20,
  },
  { name: "first page without history", history: undefined, apartmentCount: 1 },
]) {
  test(
    `native startup preflight becomes ready for ${scenario.name}`,
    { skip: !binary, timeout: 12000 },
    async (t) => {
      const app = await startup(t, scenario);
      const preflight = app
        .records()
        .find((row) => row.event === "startup.preflight.completed");
      assert.equal(preflight.preflight.ready, true, app.output());
      assert.equal(preflight.preflight.status, "ready");
      assert.ok(app.apartmentFetches() > 0);
    },
  );
}

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { openStateDatabase } from "../src/sqlite-database.js";
import { createSqliteRepositories } from "../src/sqlite-repositories.js";
import { LIST_AM_URL_TEMPLATE } from "../src/target.js";

const binary = process.env.RENTAL_APP_BINARY;
test(
  "native service crawls both categories, serves private controls, and restarts with durable state",
  { skip: !binary, timeout: 30000 },
  async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "rust-service-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const initialized = spawnSync(
      binary,
      ["state:init", "--data-directory", directory],
      { encoding: "utf8" },
    );
    assert.equal(initialized.status, 0, initialized.stderr);
    const messages = [];
    const urls = [];
    let delivered = false;
    const server = createServer(async (request, response) => {
      urls.push(request.url);
      response.setHeader("content-type", "application/json");
      if (request.url.startsWith("/ru/category/")) {
        const house = request.url.includes("/1377/");
        response.setHeader("content-type", "text/html");
        response.end(
          `<div id="contentr"><a class="category-data-list-card__destination" href="/ru/item/${house ? "200" : "100"}"><div class="pt">${house ? "Дом" : "Квартира"}</div><div class="p">200000 ֏</div><div class="l">Кентрон</div><div class="at">2 ком. · 60 кв.м. · 2/5</div><div class="d">Сегодня, 00:00</div></a></div>`,
        );
        return;
      }
      if (request.url === "/cba") {
        response.setHeader("content-type", "text/xml");
        response.end(
          `<ExchangeRatesLatestResult><CurrentDate>2026-09-26</CurrentDate>${["USD", "EUR", "RUB"].map((iso) => `<ExchangeRate><ISO>${iso}</ISO><Amount>1</Amount><Rate>400</Rate></ExchangeRate>`).join("")}</ExchangeRatesLatestResult>`,
        );
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks));
      const method = request.url.split("/").at(-1);
      let result = true;
      if (method === "getMe") result = { id: 99, is_bot: true };
      if (method === "getUpdates") {
        await delay(50);
        result = delivered
          ? []
          : [
              {
                update_id: 1,
                message: {
                  chat: { id: 123, type: "private" },
                  from: { id: 123 },
                  text: "/start",
                },
              },
              {
                update_id: 2,
                callback_query: {
                  id: "choice",
                  from: { id: 123 },
                  message: {
                    message_id: 9,
                    chat: { id: 123, type: "private" },
                  },
                  data: "m:start:initial",
                },
              },
            ];
        delivered = true;
      }
      if (method === "sendMessage" || method === "editMessageText") {
        messages.push(payload);
        result = { message_id: messages.length + 1000 };
      }
      response.end(JSON.stringify({ ok: true, result }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const portServer = createServer();
    await new Promise((resolve) => portServer.listen(0, "127.0.0.1", resolve));
    const healthPort = portServer.address().port;
    await new Promise((resolve) => portServer.close(resolve));
    function start() {
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
            POLL_INTERVAL_MS: "100",
            TELEGRAM_POLL_TIMEOUT_SECONDS: "1",
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
      t.after(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      });
      return { child, output: () => output };
    }
    const first = start();
    const deadline = Date.now() + 16000;
    while (
      !messages.some((message) => message.text.includes("/ru/item/100")) &&
      Date.now() < deadline &&
      first.child.exitCode === null
    )
      await delay(30);
    assert.ok(
      messages.some((message) => message.text.includes("/ru/item/100")),
      first.output(),
    );
    assert.ok(
      !messages.some((message) => message.text.includes("/ru/item/200")),
    );
    assert.ok(urls.some((url) => url.includes("/1377/")));
    const ready = await fetch(`http://127.0.0.1:${healthPort}/ready`);
    assert.equal(ready.status, 200);
    first.child.kill("SIGTERM");
    assert.equal(
      await new Promise((resolve) => first.child.on("exit", resolve)),
      0,
      first.output(),
    );
    const db = openStateDatabase({
      dataDirectory: directory,
      listUrlTemplate: LIST_AM_URL_TEMPLATE,
    });
    const repositories = createSqliteRepositories(db, {
      listUrlTemplate: LIST_AM_URL_TEMPLATE,
    });
    assert.equal(repositories.telegram.load().updateOffset, 3);
    assert.equal(db.logicalCounts().apartments, 2);
    db.close();
    const previousMessages = messages.filter((message) =>
      message.text.includes("/ru/item/100"),
    ).length;
    const second = start();
    await delay(5500);
    second.child.kill("SIGTERM");
    assert.equal(
      await new Promise((resolve) => second.child.on("exit", resolve)),
      0,
      second.output(),
    );
    assert.equal(
      messages.filter((message) => message.text.includes("/ru/item/100"))
        .length,
      previousMessages,
    );
  },
);

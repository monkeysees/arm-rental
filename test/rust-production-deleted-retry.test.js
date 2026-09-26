import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { emptyFilters } from "../src/filters.js";

const binary = process.env.RENTAL_APP_BINARY;

async function waitFor(predicate, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await delay(20);
  assert.ok(predicate(), "condition did not become true before timeout");
}

for (const action of ["delete", "stop"])
  test(
    `${action} during a 60-second retry lets the crawl finish and another recipient continue`,
    { skip: !binary, timeout: 20000 },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "rust-deleted-retry-"));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const initialized = spawnSync(
        binary,
        ["state:init", "--data-directory", directory],
        {
          encoding: "utf8",
        },
      );
      assert.equal(initialized.status, 0, initialized.stderr);
      const db = new DatabaseSync(join(directory, "state.sqlite3"));
      for (const id of [42, 123]) {
        db.prepare(
          "INSERT INTO telegram_users(chat_id,active,send_initial_apartments,filters_json) VALUES(?,1,1,?)",
        ).run(id, JSON.stringify(emptyFilters()));
      }
      db.close();

      const calls = [];
      let retryAt;
      let actionSent = false;
      let secondApartmentPageAt;
      let apartmentPages = 0;
      const server = createServer(async (request, response) => {
        if (request.url.startsWith("/ru/category/")) {
          if (request.url.includes("/56/1")) {
            apartmentPages += 1;
            if (apartmentPages === 3) secondApartmentPageAt = Date.now();
          }
          const base = request.url.includes("/1377/") ? 200 : 100;
          response.end(
            `<div id="contentr">${Array.from({ length: 6 }, (_, index) => `<a class="category-data-list-card__destination" href="/ru/item/${base + index}"><div class="pt">Квартира ${index}</div><div class="p">200000 ֏</div><div class="l">Кентрон</div><div class="at">2 ком. · 60 кв.м. · 2/5</div><div class="d">Сегодня, 00:00</div></a>`).join("")}</div>`,
          );
          return;
        }
        if (request.url === "/cba") {
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
        if (method === "getMe") result = { id: 10, is_bot: true };
        if (method === "getUpdates") {
          await delay(30);
          result = [];
          if (retryAt && !actionSent) {
            actionSent = true;
            const chat = { id: 42, type: "private" };
            const from = { id: 42 };
            result =
              action === "stop"
                ? [{ update_id: 1, message: { chat, from, text: "/stop" } }]
                : [
                    {
                      update_id: 1,
                      message: { chat, from, text: "/delete_my_data" },
                    },
                    {
                      update_id: 2,
                      callback_query: {
                        id: "delete",
                        from,
                        data: "d:confirm",
                        message: { message_id: 9, chat },
                      },
                    },
                  ];
          }
        }
        if (method === "sendMessage") {
          calls.push(payload);
          result = { message_id: 1000 + calls.length };
          if (payload.chat_id === 42 && !retryAt) {
            retryAt = Date.now();
            response.statusCode = 429;
            response.end(
              JSON.stringify({
                ok: false,
                error_code: 429,
                description: "Too Many Requests",
                parameters: { retry_after: 60 },
              }),
            );
            return;
          }
        }
        response.end(JSON.stringify({ ok: true, result }));
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      t.after(() => new Promise((resolve) => server.close(resolve)));
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
            POLL_INTERVAL_MS: "100",
            TELEGRAM_POLL_TIMEOUT_SECONDS: "1",
            TELEGRAM_PRIVATE_DELIVERIES_PER_MINUTE: "30",
            EXTERNAL_RETRY_BASE_MS: "10",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      const exited = new Promise((resolve) => child.on("exit", resolve));
      t.after(async () => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
          await exited;
        }
      });

      await waitFor(() => retryAt && actionSent && secondApartmentPageAt);
      assert.ok(secondApartmentPageAt - retryAt < 12000, output);
      assert.equal(child.exitCode, null, output);
      child.kill("SIGTERM");
      assert.equal(await exited, 0, output);
      assert.equal(
        calls.filter((call) => call.chat_id === 42).length,
        action === "delete" ? 3 : 2,
        "only the failed delivery and requested control response should reach the recipient",
      );
      assert.ok(
        calls
          .filter((call) => call.chat_id === 42)
          .every((call) => !call.text.includes("/ru/item/")),
        "no listing should be sent after the recipient stops",
      );
      assert.ok(
        calls.some(
          (call) => call.chat_id === 123 && call.text.includes("/ru/item/"),
        ),
      );
      const persisted = new DatabaseSync(join(directory, "state.sqlite3"));
      const recipient = persisted
        .prepare("SELECT active FROM telegram_users WHERE chat_id=42")
        .get();
      if (action === "delete") assert.equal(recipient, undefined);
      else assert.equal(recipient.active, 0);
      assert.equal(
        persisted
          .prepare(
            "SELECT count(*) AS n FROM private_delivery_decisions WHERE recipient_id='42' AND status=0",
          )
          .get().n,
        0,
      );
      assert.ok(
        persisted
          .prepare(
            "SELECT count(*) AS n FROM private_delivery_decisions WHERE recipient_id='123' AND status=0",
          )
          .get().n > 0,
      );
      persisted.close();
    },
  );

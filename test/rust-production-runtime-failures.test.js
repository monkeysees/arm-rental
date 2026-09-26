import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { emptyFilters } from "../src/filters.js";

const binary = process.env.RENTAL_APP_BINARY;
async function waitFor(predicate, timeout = 15000) {
  const end = Date.now() + timeout;
  while (!predicate() && Date.now() < end) await delay(20);
  assert.ok(predicate(), "condition did not become true before timeout");
}
async function service(
  t,
  { channel, users = [], telegram, existingDirectory, prepare },
) {
  const directory =
    existingDirectory ??
    (await mkdtemp(join(tmpdir(), "rust-runtime-failures-")));
  if (!existingDirectory)
    t.after(() => rm(directory, { recursive: true, force: true }));
  if (!existingDirectory) {
    const initialized = spawnSync(
      binary,
      [
        "state:init",
        "--data-directory",
        directory,
        ...(channel ? ["--channel", channel] : []),
      ],
      { encoding: "utf8" },
    );
    assert.equal(initialized.status, 0, initialized.stderr);
  }
  const db = new DatabaseSync(join(directory, "state.sqlite3"));
  for (const id of users)
    db.prepare(
      "INSERT INTO telegram_users(chat_id,active,send_initial_apartments,filters_json) VALUES(?,1,1,?)",
    ).run(id, JSON.stringify(emptyFilters()));
  prepare?.(db);
  db.close();
  const server = createServer(async (request, response) => {
    if (request.url.startsWith("/ru/category/")) {
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
    if (method === "getChat") result = { type: "channel" };
    if (method === "getChatMember")
      result = {
        status: "administrator",
        can_post_messages: true,
        can_edit_messages: true,
      };
    if (method === "getUpdates") {
      await delay(30);
      result = [];
    }
    if (method === "sendMessage" || method === "editMessageText")
      result = { message_id: 1000 };
    const override = await telegram(method, payload);
    response.statusCode = override?.status ?? 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(override?.body ?? { ok: true, result }));
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
        ...(channel ? { TELEGRAM_CHANNEL_ID: channel } : {}),
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
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  });
  return {
    child,
    exited,
    directory,
    output: () => output,
    stop: async () => {
      child.kill("SIGTERM");
      return exited;
    },
  };
}

test(
  "native announcement completion advances its first listing before another recipient starts",
  { skip: !binary, timeout: 20000 },
  async (t) => {
    const sends = [];
    const releases = [];
    t.after(() => releases.forEach((release) => release()));
    const app = await service(t, {
      users: Array.from({ length: 10 }, (_, index) => 100 + index),
      telegram: async (method, payload) => {
        if (method !== "sendMessage") return;
        sends.push(payload);
        await new Promise((resolve) => releases.push(resolve));
      },
    });
    await waitFor(() => sends.length === 8, 12000);
    assert.ok(sends.every((payload) => !payload.text.includes("/ru/item/")));
    releases[0]();
    await waitFor(() => sends.length === 9, 2500);
    assert.equal(sends[8].chat_id, sends[0].chat_id);
    assert.ok(
      sends[8].text.includes("/ru/item/"),
      "a completed announcement must give way to its first listing",
    );
    assert.equal(await app.stop(), 0, app.output());
    releases.forEach((release) => release());
  },
);

test(
  "native polling stops with failure when Telegram credentials become unauthorized",
  { skip: !binary, timeout: 10000 },
  async (t) => {
    const app = await service(t, {
      telegram: async (method) =>
        method === "getUpdates"
          ? {
              status: 401,
              body: { ok: false, error_code: 401, description: "Unauthorized" },
            }
          : undefined,
    });
    await waitFor(() => app.child.exitCode !== null, 5000);
    assert.notEqual(await app.exited, 0, app.output());
    assert.match(app.output(), /ERR_TELEGRAM_CREDENTIALS/u);
  },
);

test(
  "native private retries release worker slots, blocked users deactivate, and channel delivery stays independent",
  { skip: !binary, timeout: 25000 },
  async (t) => {
    const privateCalls = [];
    const channelCalls = [];
    const app = await service(t, {
      channel: "@test_channel",
      users: [42, 99, 123],
      telegram: async (method, payload) => {
        if (method !== "sendMessage") return;
        const time = Date.now();
        if (payload.chat_id === "@test_channel") {
          channelCalls.push({ time, text: payload.text });
          return;
        }
        privateCalls.push({ id: payload.chat_id, time, text: payload.text });
        if (payload.chat_id === 42)
          return {
            status: 429,
            body: {
              ok: false,
              error_code: 429,
              description: "Too Many Requests",
              parameters: { retry_after: 60 },
            },
          };
        if (payload.chat_id === 99)
          return {
            status: 403,
            body: {
              ok: false,
              error_code: 403,
              description: "Forbidden: bot was blocked by the user",
            },
          };
      },
    });
    await waitFor(
      () =>
        channelCalls.length === 6 &&
        privateCalls.filter((v) => v.id === 123).length >= 7,
      18000,
    );
    assert.equal(
      privateCalls.filter((v) => v.id === 42).length,
      1,
      "cooldown should defer the recipient without occupying a worker",
    );
    assert.equal(privateCalls.filter((v) => v.id === 99).length, 1);
    const healthy = privateCalls.filter((v) => v.id === 123);
    assert.match(healthy[0].text, /Подходящих объявлений/u);
    assert.ok(
      healthy[5].time - healthy[0].time >= 1800,
      "the announcement must consume one of the five burst tokens",
    );
    assert.ok(
      channelCalls[0].time < healthy[5].time,
      "channel must not wait for private bucket/cooldown completion",
    );
    assert.equal(await app.stop(), 0, app.output());
    assert.doesNotMatch(
      app.output(),
      /"event":"crawl\.succeeded"/u,
      "stopping with a deferred recipient must not report the partial crawl as successful",
    );
    const db = new DatabaseSync(join(app.directory, "state.sqlite3"));
    assert.equal(
      db.prepare("SELECT active FROM telegram_users WHERE chat_id=99").get()
        .active,
      0,
    );
    assert.equal(
      db.prepare("SELECT active FROM telegram_users WHERE chat_id=123").get()
        .active,
      1,
    );
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM private_delivery_decisions WHERE recipient_id='123' AND status=0",
        )
        .get().n,
      6,
    );
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM private_delivery_decisions WHERE recipient_id='42' AND status=0",
        )
        .get().n,
      0,
    );
    db.close();
  },
);

test(
  "native deletion cancels an in-flight private send before removing data and reporting completion",
  { skip: !binary, timeout: 20000 },
  async (t) => {
    let inFlight = false;
    let updatesSent = false;
    let completed = false;
    let releaseSend;
    const heldSend = new Promise((resolve) => {
      releaseSend = resolve;
    });
    t.after(() => releaseSend());
    const app = await service(t, {
      users: [42],
      telegram: async (method, payload) => {
        if (
          method === "sendMessage" &&
          payload.chat_id === 42 &&
          payload.text.includes("/ru/item/") &&
          !inFlight
        ) {
          inFlight = true;
          await heldSend;
        }
        if (method === "sendMessage" && payload.text === "Ваши данные удалены.")
          completed = true;
        if (method === "getUpdates" && inFlight && !updatesSent) {
          updatesSent = true;
          const chat = { id: 42, type: "private" };
          const from = { id: 42 };
          return {
            body: {
              ok: true,
              result: [
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
              ],
            },
          };
        }
      },
    });
    await waitFor(() => inFlight, 12000);
    await waitFor(() => completed, 2500);
    releaseSend();
    assert.equal(await app.stop(), 0, app.output());
    const db = new DatabaseSync(join(app.directory, "state.sqlite3"));
    assert.equal(
      db
        .prepare("SELECT count(*) AS n FROM telegram_users WHERE chat_id=42")
        .get().n,
      0,
    );
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM private_recipients WHERE recipient_id='42'",
        )
        .get().n,
      0,
    );
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM private_delivery_decisions WHERE recipient_id='42'",
        )
        .get().n,
      0,
    );
    assert.equal(
      db.prepare("SELECT update_offset FROM telegram_state").get()
        .update_offset,
      3,
    );
    db.close();
  },
);

test(
  "native restart replays an accepted message whose acknowledgement was interrupted",
  { skip: !binary, timeout: 35000 },
  async (t) => {
    let acceptedItem;
    let releaseSend;
    const held = new Promise((resolve) => {
      releaseSend = resolve;
    });
    t.after(() => releaseSend());
    const first = await service(t, {
      users: [42],
      telegram: async (method, payload) => {
        if (
          method === "sendMessage" &&
          payload.text.includes("/ru/item/") &&
          !acceptedItem
        ) {
          acceptedItem = payload.text.match(/\/ru\/item\/(\d+)/u)[1];
          await held;
        }
      },
    });
    await waitFor(() => acceptedItem, 12000);
    first.child.kill("SIGKILL");
    await first.exited;
    releaseSend();
    const before = new DatabaseSync(join(first.directory, "state.sqlite3"));
    assert.equal(
      before
        .prepare(
          "SELECT count(*) AS n FROM private_delivery_decisions WHERE recipient_id='42' AND status=0",
        )
        .get().n,
      0,
    );
    before.close();
    const replayed = [];
    const second = await service(t, {
      existingDirectory: first.directory,
      telegram: async (method, payload) => {
        if (method === "sendMessage" && payload.text.includes("/ru/item/"))
          replayed.push(payload.text.match(/\/ru\/item\/(\d+)/u)[1]);
      },
    });
    await waitFor(() => replayed.length === 6, 16000);
    assert.equal(replayed[0], acceptedItem);
    assert.equal(new Set(replayed).size, 6);
    assert.equal(await second.stop(), 0, second.output());
    const after = new DatabaseSync(join(first.directory, "state.sqlite3"));
    assert.equal(
      after
        .prepare(
          "SELECT count(*) AS n FROM private_delivery_decisions WHERE recipient_id='42' AND status=0",
        )
        .get().n,
      6,
    );
    after.close();
  },
);

test(
  "native startup SIGTERM cancels delayed getMe, reaps curl, and releases the lease",
  { skip: !binary, timeout: 10000 },
  async (t) => {
    let requested = false;
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    const app = await service(t, {
      telegram: async (method) => {
        if (method === "getMe") {
          requested = true;
          await held;
        }
      },
    });
    await waitFor(() => requested, 3000);
    const children = readFileSync(
      `/proc/${app.child.pid}/task/${app.child.pid}/children`,
      "utf8",
    )
      .trim()
      .split(/\s+/u)
      .filter(Boolean);
    assert.ok(
      children.length > 0,
      "delayed startup request must have an active HTTP child",
    );
    assert.ok(existsSync(join(app.directory, ".singleton.sock")));
    app.child.kill("SIGTERM");
    await waitFor(() => app.child.exitCode !== null, 2500);
    // The Node preflight wraps getMe cancellation as an unavailable credential check.
    assert.equal(await app.exited, 1, app.output());
    assert.equal(app.child.signalCode, null);
    assert.ok(!existsSync(join(app.directory, ".singleton.sock")));
    for (const pid of children)
      assert.ok(
        !existsSync(`/proc/${pid}`),
        `HTTP child ${pid} must be reaped`,
      );
    release();
  },
);

test(
  "native channel permission loss stops promptly while private delivery is deferred",
  { skip: !binary, timeout: 20000 },
  async (t) => {
    let privateCalls = 0;
    let channelFailures = 0;
    const app = await service(t, {
      channel: "@test_channel",
      users: [42],
      telegram: async (method, payload) => {
        if (method !== "sendMessage") return;
        if (payload.chat_id === 42) {
          privateCalls += 1;
          return {
            status: 429,
            body: {
              ok: false,
              error_code: 429,
              description: "Too Many Requests",
              parameters: { retry_after: 60 },
            },
          };
        }
        if (payload.chat_id === "@test_channel") {
          await waitFor(() => privateCalls > 0, 3000);
          channelFailures += 1;
          return {
            status: 403,
            body: {
              ok: false,
              error_code: 403,
              description:
                "Forbidden: not enough rights to send text messages to the chat",
            },
          };
        }
      },
    });
    await waitFor(() => channelFailures > 0, 12000);
    await waitFor(() => app.child.exitCode !== null, 2500);
    assert.equal(await app.exited, 1, app.output());
    assert.equal(
      channelFailures,
      1,
      "terminal channel permission loss must stop publication, not retry each queued listing",
    );
    assert.equal(privateCalls, 1);
    assert.doesNotMatch(app.output(), /"event":"crawl\.succeeded"/u);
    assert.ok(!existsSync(join(app.directory, ".singleton.sock")));
  },
);

test(
  "native channel acknowledgement failure cancels an ongoing private request before further writes",
  { skip: !binary, timeout: 20000 },
  async (t) => {
    let privateInFlight = false;
    let channelAccepted = false;
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    const app = await service(t, {
      channel: "@test_channel",
      users: [42],
      prepare: (db) =>
        db.exec(
          "CREATE TRIGGER fail_channel_ack BEFORE UPDATE OF status ON channel_deliveries WHEN NEW.status='published' BEGIN SELECT RAISE(ABORT,'synthetic channel acknowledgement fault'); END;",
        ),
      telegram: async (method, payload) => {
        if (method !== "sendMessage") return;
        if (payload.chat_id === 42 && payload.text.includes("/ru/item/")) {
          privateInFlight = true;
          await held;
        }
        if (payload.chat_id === "@test_channel") {
          await waitFor(() => privateInFlight, 3000);
          channelAccepted = true;
        }
      },
    });
    await waitFor(() => channelAccepted, 12000);
    await waitFor(() => app.child.exitCode !== null, 2500);
    assert.equal(await app.exited, 1, app.output());
    release();
    assert.doesNotMatch(app.output(), /"event":"crawl\.succeeded"/u);
    const db = new DatabaseSync(join(app.directory, "state.sqlite3"));
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM channel_deliveries WHERE status='published'",
        )
        .get().n,
      0,
    );
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM private_delivery_decisions WHERE status=0",
        )
        .get().n,
      0,
    );
    assert.ok(db.prepare("SELECT count(*) AS n FROM channel_work").get().n > 0);
    db.close();
    assert.ok(!existsSync(join(app.directory, ".singleton.sock")));
  },
);

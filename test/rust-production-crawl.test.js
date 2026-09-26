import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { getConfig } from "../src/config.js";
import { openStateDatabase } from "../src/sqlite-database.js";
import { createSqliteRepositories } from "../src/sqlite-repositories.js";
import { createSqliteStateAccess } from "../src/sqlite-state-access.js";
import { crawlApartments } from "../src/crawler.js";
const binary = process.env.RENTAL_APP_BINARY;
const nowMs = Date.parse("2026-09-26T12:00:00.000Z");
const card = (id, title, date = "Суббота, Сентябрь 26, 2026, 10:00") =>
  `<a class="category-data-list-card__destination" href="/ru/item/${id}"><div class="dltitle">${title}</div><div class="p">150000 AMD</div><div class="l">Кентрон</div><div class="at">2 ком. · 50 кв.м. · 2/4 этаж</div><div class="d">${date}</div></a>`;
async function native(input) {
  const child = spawn(binary, ["contract"]);
  let out = "",
    err = "";
  child.stdout.on("data", (v) => (out += v));
  child.stderr.on("data", (v) => (err += v));
  child.stdin.end(JSON.stringify(input) + "\n");
  assert.equal(
    await new Promise((resolve) => child.on("exit", resolve)),
    0,
    err,
  );
  const result = JSON.parse(out);
  assert.equal(result.error, undefined, JSON.stringify(result));
  return result;
}
test(
  "native local-source crawl preserves Node discovery, restart and atomic failure behavior",
  { skip: !binary },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "rust-crawl-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    let phase = 0;
    const html = (url) => {
      const pathname = new URL(url, "https://www.list.am").pathname;
      const apartment = pathname.includes("/56/");
      const page = Number(pathname.split("/").at(-1));
      if (page > 1) return '<div id="contentr"></div>';
      if (phase === 3 && !apartment)
        return '<div id="contentr"><a class="fav-item-info-container" href="https://evil.test/item/9">broken</a></div>';
      return `<div id="contentr">${apartment ? card("1", phase === 0 ? "Квартира" : "Квартира обновлена") + card("2", "Без даты", "") : card("3", "Дом")}</div>`;
    };
    const server = createServer((req, res) => res.end(html(req.url)));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const dirs = [path.join(root, "node"), path.join(root, "rust")];
    const env = {
      TELEGRAM_BOT_TOKEN: "123:test",
      TELEGRAM_OWNER_ID: "123",
      CURL_IMPERSONATE_PATH: "/usr/bin/curl",
      INITIAL_PAGE_COUNT: "2",
      ADDED_CATEGORY_PAGE_COUNT: "2",
    };
    for (const dir of dirs) {
      const c = getConfig({ ...env, DATA_DIRECTORY: dir });
      const db = openStateDatabase({
        dataDirectory: dir,
        listUrlTemplate: c.listUrlTemplate,
        create: true,
      });
      db.close();
    }
    const config = getConfig({ ...env, DATA_DIRECTORY: dirs[0] });
    const db = openStateDatabase({
      dataDirectory: dirs[0],
      listUrlTemplate: config.listUrlTemplate,
    });
    t.after(() => db.close());
    const repositories = createSqliteRepositories(db, {
      listUrlTemplate: config.listUrlTemplate,
    });
    const access = createSqliteStateAccess(db, repositories);
    const readNative = () => {
      const d = openStateDatabase({
        dataDirectory: dirs[1],
        listUrlTemplate: config.listUrlTemplate,
      });
      try {
        return createSqliteRepositories(d, {
          listUrlTemplate: config.listUrlTemplate,
        }).apartments.load();
      } finally {
        d.close();
      }
    };
    for (phase = 0; phase < 3; phase++) {
      await crawlApartments(config, {
        stateAccess: access,
        fetchPage: async (url) => ({ ok: true, text: async () => html(url) }),
        now: () => new Date(nowMs + phase * 60000),
      });
      await native({
        op: "crawl",
        directory: dirs[1],
        endpoint: `http://127.0.0.1:${server.address().port}`,
        env,
        nowMs: nowMs + phase * 60000,
        rates: {},
      });
      assert.deepEqual(readNative(), repositories.apartments.load());
    }
    const before = readNative();
    const child = spawn(binary, ["contract"]);
    let out = "";
    child.stdout.on("data", (v) => (out += v));
    child.stdin.end(
      JSON.stringify({
        op: "crawl",
        directory: dirs[1],
        endpoint: `http://127.0.0.1:${server.address().port}`,
        env,
        nowMs: nowMs + 180000,
        rates: {},
      }) + "\n",
    );
    await new Promise((resolve) => child.on("exit", resolve));
    assert.match(JSON.parse(out).error, /IDENTITY_REJECTION/);
    assert.deepEqual(readNative(), before);
  },
);

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openStateDatabase } from "../src/sqlite-database.js";
import { createSqliteRepositories } from "../src/sqlite-repositories.js";
import { createSqliteStateAccess } from "../src/sqlite-state-access.js";
import { crawlApartments } from "../src/crawler.js";
import { publishChannelApartments } from "../src/channel.js";
import { emptyFilters } from "../src/filters.js";

const TIME = "2026-08-18T10:11:12.000Z";
function page(price = 100000, title = "Apartment 1") {
  return `<div id="contentr"><a class="fav-item-info-container" href="/ru/item/1"><div class="dltitle"><div class="pt">${title}</div></div><div class="p">${price} ֏ monthly</div><div class="at">Arabkir, 2 rm., 50 sq.m., 3/5 floor</div><div class="d">Вторник, Август 18, 2026, 09:00</div></a></div>`;
}

test("SQLite channel work stays bounded, retains failed edits across restart, and replaces missing messages", async (t) => {
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "arm-channel-incremental-"),
  );
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const config = {
    dataDirectory,
    listUrlTemplate: "https://www.list.am/category/60/{page}",
    telegramChannelId: "@test_channel",
    channelFilters: emptyFilters(),
    initialDeliveryLimit: 10,
    initialPageCount: 1,
  };
  const options = {
    dataDirectory,
    listUrlTemplate: config.listUrlTemplate,
    channelId: config.telegramChannelId,
  };
  let database = openStateDatabase({ ...options, create: true });
  t.after(() => database.close());
  let repositories = createSqliteRepositories(database, options);
  let access = createSqliteStateAccess(database, repositories);
  const sent = [];
  const edited = [];
  let failEdit = false;
  const api = {
    sendMessage: async (_id, text) => {
      sent.push(text);
      return { message_id: sent.length };
    },
    editMessageText: async (_id, messageId, text) => {
      if (failEdit) throw new Error("network failed");
      edited.push({ messageId, text });
    },
  };
  const publish = () =>
    publishChannelApartments(config, null, {
      api,
      stateStore: access.channelDeliveries,
      now: () => new Date(TIME),
    });
  const crawl = (html) =>
    crawlApartments(config, {
      stateAccess: access,
      fetchPage: async () => new Response(html),
      now: () => new Date(TIME),
      afterStateSaved: publish,
    });
  await crawl(page());
  assert.equal(sent.length, 1);
  repositories.apartments.load = () => {
    throw new Error("whole listing history read");
  };
  repositories.channelDeliveries.load = () => {
    throw new Error("whole channel history read");
  };
  let candidates = 0;
  const loadCandidates = repositories.channelDeliveries.loadCandidates.bind(
    repositories.channelDeliveries,
  );
  repositories.channelDeliveries.loadCandidates = (...args) => {
    const rows = loadCandidates(...args);
    candidates += rows.length;
    return rows;
  };
  await crawl(page());
  assert.equal(candidates, 0);
  assert.equal(sent.length, 1);
  assert.equal(edited.length, 0);
  failEdit = true;
  await crawl(page(120000));
  assert.equal(
    database.prepare("SELECT count(*) n FROM channel_work").get().n,
    1,
  );
  database.close();
  database = openStateDatabase(options);
  repositories = createSqliteRepositories(database, options);
  access = createSqliteStateAccess(database, repositories);
  failEdit = false;
  await publish();
  assert.equal(edited.length, 1);
  assert.equal(
    database.prepare("SELECT count(*) n FROM channel_work").get().n,
    0,
  );
  api.editMessageText = async () => {
    throw new Error("message to edit not found");
  };
  await crawl(page(130000));
  assert.equal(sent.length, 2);
  assert.equal(
    repositories.channelDeliveries.load().apartments[1].messageId,
    2,
  );
});

test("SQLite channel initial selection resumes before skipped listings return and retained publications edit", async (t) => {
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "arm-channel-selection-"),
  );
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const config = {
    dataDirectory,
    listUrlTemplate: "https://www.list.am/category/60/{page}",
    telegramChannelId: "@test_channel",
    channelFilters: emptyFilters(),
    initialDeliveryLimit: 1,
    initialPageCount: 1,
  };
  const options = {
    dataDirectory,
    listUrlTemplate: config.listUrlTemplate,
    channelId: config.telegramChannelId,
  };
  let database = openStateDatabase({ ...options, create: true });
  t.after(() => database.close());
  let repositories = createSqliteRepositories(database, options);
  let access = createSqliteStateAccess(database, repositories);
  let now = new Date(TIME);
  let fails = true;
  const sent = [];
  const edits = [];
  const api = {
    sendMessage: async (_id, text) => {
      if (fails) throw new Error("network failed");
      sent.push(text);
      return { message_id: sent.length };
    },
    editMessageText: async (_id, messageId, text) => {
      edits.push({ messageId, text });
    },
  };
  const publish = () =>
    publishChannelApartments(config, null, {
      api,
      stateStore: access.channelDeliveries,
      now: () => now,
    });
  const crawl = (html) =>
    crawlApartments(config, {
      stateAccess: access,
      fetchPage: async () => new Response(html),
      now: () => now,
      afterStateSaved: publish,
    });
  const two = page().replace(
    "</div></a></div>",
    "</div></a>" +
      page(200000, "Apartment 2")
        .replace('<div id="contentr">', "")
        .replace("/item/1", "/item/2"),
  );
  await crawl(two);
  const initial = repositories.channelDeliveries.load();
  assert.equal(
    Object.values(initial.apartments).filter(
      ({ status }) => status === "pending",
    ).length,
    1,
  );
  assert.equal(
    Object.values(initial.apartments).filter(
      ({ status }) => status === "skipped_initial",
    ).length,
    1,
  );
  database.close();
  database = openStateDatabase(options);
  repositories = createSqliteRepositories(database, options);
  access = createSqliteStateAccess(database, repositories);
  fails = false;
  await publish();
  assert.equal(sent.length, 1);
  assert.equal(
    Object.values(repositories.channelDeliveries.load().apartments).filter(
      ({ status }) => status === "skipped_initial",
    ).length,
    1,
  );
  now = new Date("2026-08-18T10:12:12.000Z");
  await crawl(two);
  assert.equal(sent.length, 2);
  const originalMessageId =
    repositories.channelDeliveries.load().apartments[1].messageId;
  now = new Date("2026-08-18T10:13:12.000Z");
  await crawl(page(200000, "Apartment 2").replace("/item/1", "/item/2"));
  assert.equal(sent.length, 2);
  now = new Date("2026-08-18T10:14:12.000Z");
  await crawl(page(130000));
  assert.equal(sent.length, 2);
  assert.equal(edits.at(-1).messageId, originalMessageId);
});

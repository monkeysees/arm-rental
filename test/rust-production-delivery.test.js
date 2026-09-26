import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { emptyFilters } from "../src/filters.js";
import {
  channelFilterFingerprint,
  formatChannelApartmentMessage,
} from "../src/channel.js";
import { selectableHistory } from "../src/delivery-selection.js";
const binary = process.env.RENTAL_APP_BINARY;
const nowMs = Date.parse("2026-09-26T12:00:00.000Z");
const at = new Date(nowMs).toISOString();
function native(input) {
  const result = spawnSync(binary, ["contract"], {
    input: `${JSON.stringify(input)}\n`,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.error, undefined, output.error);
  return output;
}
function fixture(t, channel = undefined) {
  const directory = mkdtempSync(join(tmpdir(), "arm-rust-delivery-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = spawnSync(
    binary,
    [
      "state:init",
      "--data-directory",
      directory,
      ...(channel ? ["--channel", channel] : []),
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const db = new DatabaseSync(join(directory, "state.sqlite3"));
  t.after(() => db.close());
  const apartments = {};
  for (let i = 1; i <= 4; i++) {
    const a = {
      itemId: `${i}`,
      kind: "apartment",
      title: `Квартира ${i}`,
      url: `https://www.list.am/ru/item/${i}`,
      price: { amount: i * 100000, currency: "AMD" },
      rooms: 2,
      location: "Ереван, Арабкир",
      firstSeenAt: at,
      lastSeenAt: at,
    };
    apartments[a.itemId] = a;
    db.prepare(
      "INSERT INTO apartments(item_id,payload_json,kind,encounter_sequence,encounter_position,last_seen_at,changed_sequence) VALUES(?,?,?,1,?,?,1)",
    ).run(a.itemId, JSON.stringify(a), a.kind, i - 1, at);
  }
  return { directory, db, apartments };
}

test(
  "Rust private classification preserves explicit initial selection and skip decisions",
  { skip: !binary },
  (t) => {
    const { directory, db, apartments } = fixture(t);
    const filters = emptyFilters();
    const user = {
      chatId: 42,
      active: true,
      sendInitialApartments: true,
      filters,
    };
    const request = {
      op: "private",
      directory,
      config: { initialDeliveryLimit: 2 },
      user,
      nowMs,
      freshIds: [],
    };
    const expected = selectableHistory(
      Object.keys(apartments),
      apartments,
      { notified: {}, skipped: {}, filtered: {} },
      filters,
      nowMs,
    ).slice(0, 2);
    const batch = native(request);
    assert.equal(batch.count, expected.length);
    assert.equal(batch.announce, true);
    assert.equal(batch.next.apartment.itemId, expected.at(-1));
    assert.deepEqual(
      db
        .prepare(
          "SELECT item_id,status FROM private_delivery_decisions ORDER BY item_id",
        )
        .all()
        .map((v) => ({ ...v })),
      [
        { item_id: "3", status: 1 },
        { item_id: "4", status: 1 },
      ],
    );
    const second = native(request);
    assert.equal(second.count, 2);
    assert.equal(second.next.apartment.itemId, "2");
  },
);

test(
  "Rust no-history answer durably excludes backlog while fresh source changes stay deliverable",
  { skip: !binary },
  (t) => {
    const { directory, db } = fixture(t);
    const request = {
      op: "private",
      directory,
      config: { initialDeliveryLimit: 2 },
      user: {
        chatId: 42,
        active: true,
        sendInitialApartments: false,
        filters: emptyFilters(),
      },
      nowMs,
      freshIds: [],
    };
    assert.equal(native(request).count, 0);
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM private_delivery_decisions WHERE status=1",
        )
        .get().n,
      4,
    );
    assert.equal(native(request).count, 0);
  },
);

test(
  "Rust channel classification and acknowledgement retain retry work and original Node formatting",
  { skip: !binary },
  (t) => {
    const { directory, db, apartments } = fixture(t, "@test_channel");
    const config = {
      telegramChannelId: "@test_channel",
      channelFilters: emptyFilters(),
      initialDeliveryLimit: 2,
    };
    const request = { op: "channel", directory, config, nowMs };
    const prepared = native(request);
    assert.equal(prepared.skippedCount, 2);
    assert.equal(
      prepared.filterFingerprint,
      channelFilterFingerprint(config.channelFilters),
    );
    const operations = native({ ...request, action: "operations" });
    assert.equal(operations.length, 2);
    assert.deepEqual(
      operations.map((op) => op.itemId),
      ["2", "1"],
    );
    for (const op of operations) {
      assert.equal(
        op.payload.text,
        formatChannelApartmentMessage(apartments[op.itemId]),
      );
      assert.equal(op.payload.disable_web_page_preview, true);
    }
    assert.deepEqual(native({ ...request, action: "operations" }), operations);
    native({
      ...request,
      action: "acknowledge",
      operation: operations[0],
      result: { message_id: 50 },
    });
    assert.equal(
      db
        .prepare("SELECT status FROM channel_deliveries WHERE item_id='2'")
        .get().status,
      "published",
    );
    assert.equal(native({ ...request, action: "operations" }).length, 1);
  },
);

test(
  "Rust channel edits retain publication identity and older changed posts repost",
  { skip: !binary },
  (t) => {
    const { directory, db, apartments } = fixture(t, "@test_channel");
    const config = {
      telegramChannelId: "@test_channel",
      channelFilters: emptyFilters(),
      initialDeliveryLimit: 1,
    };
    const request = { op: "channel", directory, config, nowMs };
    native(request);
    const original = native({ ...request, action: "operations" })[0];
    native({
      ...request,
      action: "acknowledge",
      operation: original,
      result: { message_id: 90 },
    });
    apartments["1"].title = "Новая цена";
    db.prepare("UPDATE apartments SET payload_json=? WHERE item_id='1'").run(
      JSON.stringify(apartments["1"]),
    );
    db.prepare("INSERT INTO channel_work(item_id) VALUES('1')").run();
    const edit = native({
      ...request,
      action: "operations",
      nowMs: nowMs + 1000,
    })[0];
    assert.equal(edit.method, "editMessageText");
    assert.equal(edit.payload.message_id, 90);
    assert.equal(edit.payload.disable_web_page_preview, true);
    assert.equal(edit.publishedAt, original.publishedAt);
    native({
      ...request,
      action: "acknowledge",
      operation: edit,
      result: true,
    });
    assert.equal(
      db
        .prepare("SELECT message_id FROM channel_deliveries WHERE item_id='1'")
        .get().message_id,
      90,
    );
    apartments["1"].title = "Ещё одно изменение";
    db.prepare("UPDATE apartments SET payload_json=? WHERE item_id='1'").run(
      JSON.stringify(apartments["1"]),
    );
    db.prepare("INSERT INTO channel_work(item_id) VALUES('1')").run();
    const repost = native({
      ...request,
      action: "operations",
      nowMs: nowMs + 3 * 86400000 + 1,
    })[0];
    assert.equal(repost.method, "sendMessage");
    assert.equal(repost.operation, "repost");
    assert.equal(repost.payload.message_id, undefined);
    assert.equal(repost.payload.disable_web_page_preview, true);
    assert.notEqual(repost.publishedAt, original.publishedAt);
  },
);

test(
  "Rust widened private filters wait for consent but a fresh source update readmits",
  { skip: !binary },
  (t) => {
    const { directory, db, apartments } = fixture(t);
    const user = {
      chatId: 42,
      active: true,
      sendInitialApartments: true,
      filters: { ...emptyFilters(), price: { min: null, max: 50000 } },
    };
    const request = {
      op: "private",
      directory,
      config: { initialDeliveryLimit: 10 },
      user,
      nowMs,
      freshIds: [],
    };
    assert.equal(native(request).count, 0);
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM private_delivery_decisions WHERE status=2",
        )
        .get().n,
      4,
    );
    user.filters = emptyFilters();
    assert.equal(native(request).count, 0);
    apartments["2"].updatedAt = new Date(nowMs + 1000).toISOString();
    db.prepare(
      "UPDATE apartments SET payload_json=?,changed_sequence=2 WHERE item_id='2'",
    ).run(JSON.stringify(apartments["2"]));
    db.prepare(
      "INSERT INTO private_delivery_work(recipient_id,item_id) VALUES('42','2')",
    ).run();
    const readmitted = native({ ...request, nowMs: nowMs + 1000 });
    assert.equal(readmitted.count, 1);
    assert.equal(readmitted.next.apartment.itemId, "2");
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM private_delivery_decisions WHERE item_id='2'",
        )
        .get().n,
      0,
    );
  },
);

test(
  "Rust confirmed deletion removes recipient data atomically and ignores same-batch registration",
  { skip: !binary },
  (t) => {
    const { directory, db } = fixture(t);
    const filters = emptyFilters();
    db.prepare(
      "INSERT INTO telegram_users(chat_id,active,send_initial_apartments,filters_json) VALUES(42,1,1,?)",
    ).run(JSON.stringify(filters));
    db.prepare(
      "INSERT INTO telegram_users(chat_id,active,send_initial_apartments,filters_json) VALUES(99,1,1,?)",
    ).run(JSON.stringify(filters));
    db.prepare(
      "INSERT INTO private_recipients(recipient_id,initial_selection_applied) VALUES('42',1)",
    ).run();
    db.prepare(
      "INSERT INTO private_delivery_decisions VALUES('42','1',0,?)",
    ).run(nowMs);
    db.prepare(
      "INSERT INTO private_delivery_work(recipient_id,item_id) VALUES('42','2')",
    ).run();
    const chat = { id: 42, type: "private" };
    const from = { id: 42 };
    const result = native({
      op: "bot",
      directory,
      config: { telegramAccessMode: "owner", telegramOwnerId: 99 },
      nowMs,
      updates: [
        { update_id: 1, message: { from, chat, text: "/delete_my_data" } },
        {
          update_id: 2,
          callback_query: {
            id: "confirm",
            from,
            data: "d:confirm",
            message: { message_id: 10, chat },
          },
        },
        { update_id: 3, message: { from, chat, text: "/start" } },
      ],
    });
    assert.equal(result.state.updateOffset, 4);
    assert.equal(result.state.users[42], undefined);
    assert.ok(result.state.users[99]);
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
          "SELECT count(*) AS n FROM private_delivery_work WHERE recipient_id='42'",
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
    assert.equal(result.operations.at(-1).payload.text, "Ваши данные удалены.");
  },
);

test(
  "Rust private history answers persist consent before reporting it",
  { skip: !binary },
  (t) => {
    const { directory, db } = fixture(t);
    const filters = emptyFilters();
    db.prepare(
      "INSERT INTO telegram_users(chat_id,active,send_initial_apartments,filters_json) VALUES(42,1,1,?)",
    ).run(JSON.stringify(filters));
    db.prepare(
      "INSERT INTO private_recipients(recipient_id,initial_selection_applied) VALUES('42',1)",
    ).run();
    for (const id of ["1", "2"])
      db.prepare(
        "INSERT INTO private_delivery_decisions VALUES('42',?,2,?)",
      ).run(id, nowMs);
    const chat = { id: 42, type: "private" };
    const from = { id: 42 };
    const base = {
      op: "bot",
      directory,
      config: { initialDeliveryLimit: 1 },
      nowMs,
    };
    const offered = native({
      ...base,
      updates: [{ update_id: 1, message: { from, chat, text: "/menu" } }],
    });
    assert.match(
      offered.operations.at(-1).payload.text,
      /Подходящих объявлений за последние 24 часа: 1/u,
    );
    const declined = native({
      ...base,
      updates: [
        {
          update_id: 2,
          callback_query: {
            id: "skip",
            from,
            data: "m:history:skip",
            message: { chat, message_id: 8 },
          },
        },
      ],
    });
    assert.match(
      declined.operations.at(-1).payload.text,
      /эти объявления отправлены не будут/u,
    );
    assert.equal(
      db
        .prepare(
          "SELECT status FROM private_delivery_decisions WHERE item_id='1'",
        )
        .get().status,
      1,
    );
    const accepted = native({
      ...base,
      updates: [
        {
          update_id: 3,
          callback_query: {
            id: "send",
            from,
            data: "m:history:send",
            message: { chat, message_id: 9 },
          },
        },
      ],
    });
    assert.equal(
      accepted.operations.at(-1).payload.text,
      "Хорошо, отправлю их при следующей проверке. Объявлений: 1.",
    );
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM private_delivery_decisions WHERE item_id='2'",
        )
        .get().n,
      0,
    );
    assert.equal(
      db
        .prepare(
          "SELECT item_id FROM private_delivery_work WHERE recipient_id='42'",
        )
        .get().item_id,
      "2",
    );
  },
);

test(
  "Rust private history redelivers only a recently changed acknowledged listing",
  { skip: !binary },
  (t) => {
    const { directory, db, apartments } = fixture(t);
    const decidedAt = nowMs - 60000;
    apartments["1"].updatedAt = at;
    apartments["2"].updatedAt = null;
    // Listing 3 has no updatedAt; listing 4 predates acknowledgement.
    apartments["4"].updatedAt = new Date(decidedAt - 1000).toISOString();
    for (const apartment of Object.values(apartments)) {
      db.prepare("UPDATE apartments SET payload_json=? WHERE item_id=?").run(
        JSON.stringify(apartment),
        apartment.itemId,
      );
    }
    db.prepare(
      "INSERT INTO private_recipients(recipient_id,initial_selection_applied) VALUES('42',1)",
    ).run();
    for (const itemId of Object.keys(apartments)) {
      db.prepare(
        "INSERT INTO private_delivery_decisions(recipient_id,item_id,status,decided_at) VALUES('42',?,0,?)",
      ).run(itemId, decidedAt);
    }
    const batch = native({
      op: "private",
      directory,
      config: { initialDeliveryLimit: 4 },
      user: { chatId: 42, active: true, filters: emptyFilters() },
      nowMs,
      freshIds: [],
    });
    assert.equal(batch.count, 1);
    assert.equal(batch.next.apartment.itemId, "1");
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM private_delivery_decisions WHERE status=0",
        )
        .get().n,
      4,
    );
  },
);

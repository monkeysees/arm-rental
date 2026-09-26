import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { emptyFilters } from "../src/filters.js";

const binary = process.env.RENTAL_APP_BINARY;
const nowMs = Date.parse("2026-09-26T12:00:00.000Z");
const at = new Date(nowMs).toISOString();

function contract(input) {
  const result = spawnSync(binary, ["contract"], {
    input: `${JSON.stringify(input)}\n`,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "arm-rust-history-offset-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const initialized = spawnSync(
    binary,
    ["state:init", "--data-directory", directory],
    { encoding: "utf8" },
  );
  assert.equal(initialized.status, 0, initialized.stderr);
  const db = new DatabaseSync(join(directory, "state.sqlite3"));
  t.after(() => db.close());
  db.prepare(
    "INSERT INTO telegram_users(chat_id,active,send_initial_apartments,filters_json) VALUES(42,1,1,?)",
  ).run(JSON.stringify(emptyFilters()));
  db.prepare(
    "INSERT INTO private_recipients(recipient_id,initial_selection_applied) VALUES('42',1)",
  ).run();
  const apartment = {
    itemId: "1",
    kind: "apartment",
    title: "Квартира",
    url: "https://www.list.am/ru/item/1",
    price: { amount: 100000, currency: "AMD" },
    rooms: 2,
    location: "Ереван, Арабкир",
    firstSeenAt: at,
    lastSeenAt: at,
  };
  db.prepare(
    "INSERT INTO apartments(item_id,payload_json,kind,encounter_sequence,encounter_position,last_seen_at,changed_sequence) VALUES('1',?,'apartment',1,0,?,1)",
  ).run(JSON.stringify(apartment), at);
  db.prepare("INSERT INTO private_delivery_decisions VALUES('42','1',2,?)").run(
    nowMs,
  );
  return { directory, db };
}

for (const [answer, accepted] of [
  ["send", true],
  ["skip", false],
]) {
  for (const failure of ["decision_write", "before_commit"]) {
    test(
      `Rust ${answer} history and update offset roll back at ${failure} and replay once`,
      { skip: !binary },
      (t) => {
        const { directory, db } = setup(t);
        const update = {
          update_id: 7,
          callback_query: {
            id: `${answer}-callback`,
            from: { id: 42 },
            data: `m:history:${answer}`,
            message: { chat: { id: 42, type: "private" }, message_id: 8 },
          },
        };
        const request = {
          op: "bot",
          directory,
          config: { initialDeliveryLimit: 10 },
          nowMs,
          updates: [update],
        };
        const interrupted = contract({ ...request, failHistoryAt: failure });
        assert.match(interrupted.error, /CHECK constraint failed/u);
        assert.equal(
          db.prepare("SELECT update_offset FROM telegram_state").get()
            .update_offset,
          0,
        );
        assert.deepEqual(
          db
            .prepare("SELECT item_id,status FROM private_delivery_decisions")
            .all()
            .map(({ item_id, status }) => ({ item_id, status })),
          [{ item_id: "1", status: 2 }],
        );
        assert.equal(
          db.prepare("SELECT count(*) AS n FROM private_delivery_work").get().n,
          0,
        );

        const resumed = contract(request);
        assert.equal(resumed.error, undefined);
        assert.equal(resumed.state.updateOffset, 8);
        assert.equal(
          db.prepare("SELECT update_offset FROM telegram_state").get()
            .update_offset,
          8,
        );
        const replayed = contract(request);
        assert.equal(replayed.error, undefined);
        assert.equal(replayed.state.updateOffset, 8);
        assert.equal(
          db.prepare("SELECT count(*) AS n FROM private_delivery_work").get().n,
          accepted ? 1 : 0,
        );
        assert.deepEqual(
          db
            .prepare("SELECT item_id,status FROM private_delivery_decisions")
            .all()
            .map(({ item_id, status }) => ({ item_id, status })),
          accepted ? [] : [{ item_id: "1", status: 1 }],
        );
      },
    );
  }
}

test(
  "Rust invalid filter input keeps its update offset until the Telegram response",
  { skip: !binary },
  (t) => {
    const { directory, db } = setup(t);
    db.prepare(
      "UPDATE telegram_users SET pending_filter_input='price' WHERE chat_id=42",
    ).run();
    const result = contract({
      op: "bot",
      directory,
      config: { initialDeliveryLimit: 10 },
      nowMs,
      updates: [
        {
          update_id: 7,
          message: {
            from: { id: 42 },
            chat: { id: 42, type: "private" },
            text: "invalid range",
          },
        },
      ],
    });
    assert.equal(result.error, undefined);
    assert.equal(result.state.updateOffset, 0);
    assert.equal(result.operations.at(-1).ackOffset, 8);
    assert.equal(
      db.prepare("SELECT update_offset FROM telegram_state").get()
        .update_offset,
      0,
    );
  },
);

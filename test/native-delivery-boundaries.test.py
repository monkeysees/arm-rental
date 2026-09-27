#!/usr/bin/env python3
"""Node-free checks for durable private and channel delivery decisions."""

import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest
from datetime import datetime, timezone


ROOT = Path(__file__).resolve().parents[1]
BINARY = Path(os.environ.get("RENTAL_APP_BINARY", ROOT / "experiments/rust-replay/target/debug/rental-app"))
NOW = 1790424000000  # 2026-09-26T12:00:00Z, fixed historical oracle time.
AT = datetime.fromtimestamp(NOW / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def filters() -> dict:
    return {
        "kinds": ["apartment"], "price": {"min": None, "max": None},
        "rooms": {"min": None, "max": None}, "locations": [],
    }


class DeliveryBoundaries(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="native-delivery-")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "TELEGRAM_BOT_TOKEN": "123:synthetic-native-test",
            "TELEGRAM_OWNER_ID": "123", "DATA_DIRECTORY": str(self.directory),
        }
        init = [str(BINARY), "state:init"]
        if self._testMethodName.startswith("test_channel_"):
            init += ["--channel", "@test_channel"]
        result = subprocess.run(init, env=self.env,
                                text=True, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.db = sqlite3.connect(self.directory / "state.sqlite3", isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.addCleanup(self.db.close)
        self.apartments = {}
        for i in range(1, 5):
            apartment = {
                "itemId": str(i), "kind": "apartment", "title": f"Квартира {i}",
                "url": f"https://www.list.am/ru/item/{i}",
                "price": {"amount": i * 100000, "currency": "AMD"},
                "rooms": 2, "location": "Ереван, Арабкир",
                "firstSeenAt": AT, "lastSeenAt": AT,
            }
            self.apartments[str(i)] = apartment
            self.db.execute(
                "INSERT INTO apartments(item_id,payload_json,kind,encounter_sequence,encounter_position,last_seen_at,changed_sequence) VALUES(?,?,?,1,?,?,1)",
                (str(i), json.dumps(apartment, ensure_ascii=False), "apartment", i - 1, AT),
            )

    def contract(self, request: dict, *, allow_error: bool = False):
        result = subprocess.run(
            [str(BINARY), "contract"], env=self.env,
            input=json.dumps({"directory": str(self.directory), "nowMs": NOW} | request,
                             ensure_ascii=False) + "\n",
            text=True, capture_output=True, timeout=15,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        response = json.loads(result.stdout)
        if not allow_error:
            self.assertNotIn("error", response, response)
        return response

    def scalar(self, sql: str, params=()):
        row = self.db.execute(sql, params).fetchone()
        return row[0] if row else None

    def test_private_initial_limit_is_durable_and_repeatable(self):
        request = {
            "op": "private", "config": {"initialDeliveryLimit": 2},
            "user": {"chatId": 42, "active": True, "sendInitialApartments": True, "filters": filters()},
            "freshIds": [],
        }
        first = self.contract(request)
        self.assertEqual((first["count"], first["announce"], first["next"]["apartment"]["itemId"]),
                         (2, True, "2"))
        self.assertEqual([(row[0], row[1]) for row in self.db.execute(
            "SELECT item_id,status FROM private_delivery_decisions ORDER BY item_id")],
            [("3", 1), ("4", 1)])
        second = self.contract(request)
        self.assertEqual((second["count"], second["next"]["apartment"]["itemId"]), (2, "2"))

    def test_no_history_selection_excludes_backlog(self):
        request = {
            "op": "private", "config": {"initialDeliveryLimit": 2},
            "user": {"chatId": 42, "active": True, "sendInitialApartments": False, "filters": filters()},
            "freshIds": [],
        }
        self.assertEqual(self.contract(request)["count"], 0)
        self.assertEqual(self.scalar("SELECT count(*) FROM private_delivery_decisions WHERE status=1"), 4)
        self.assertEqual(self.contract(request)["count"], 0)

    def test_channel_retry_work_and_acknowledgement(self):
        config = {"telegramChannelId": "@test_channel", "channelFilters": filters(),
                  "initialDeliveryLimit": 2}
        request = {"op": "channel", "config": config}
        prepared = self.contract(request)
        self.assertEqual(prepared["skippedCount"], 2)
        self.assertIsInstance(prepared["filterFingerprint"], str)
        operations = self.contract(request | {"action": "operations"})
        self.assertEqual([op["itemId"] for op in operations], ["2", "1"])
        for operation in operations:
            self.assertEqual(operation["method"], "sendMessage")
            self.assertTrue(operation["payload"]["disable_web_page_preview"])
            self.assertIn(self.apartments[operation["itemId"]]["title"], operation["payload"]["text"])
        self.assertEqual(self.contract(request | {"action": "operations"}), operations)
        self.contract(request | {"action": "acknowledge", "operation": operations[0],
                                 "result": {"message_id": 50}})
        self.assertEqual(self.scalar("SELECT status FROM channel_deliveries WHERE item_id='2'"), "published")
        self.assertEqual(len(self.contract(request | {"action": "operations"})), 1)

    def test_channel_edit_keeps_identity_and_old_edit_reposts(self):
        request = {"op": "channel", "config": {
            "telegramChannelId": "@test_channel", "channelFilters": filters(),
            "initialDeliveryLimit": 1}}
        self.contract(request)
        original = self.contract(request | {"action": "operations"})[0]
        self.contract(request | {"action": "acknowledge", "operation": original,
                                 "result": {"message_id": 90}})
        for title, advance in [("Новая цена", 1000), ("Ещё одно изменение", 3 * 86400000 + 1)]:
            self.apartments["1"]["title"] = title
            self.db.execute("UPDATE apartments SET payload_json=? WHERE item_id='1'",
                            (json.dumps(self.apartments["1"], ensure_ascii=False),))
            self.db.execute("INSERT INTO channel_work(item_id) VALUES('1')")
            operation = self.contract(request | {"action": "operations", "nowMs": NOW + advance})[0]
            if advance == 1000:
                self.assertEqual(operation["method"], "editMessageText")
                self.assertEqual(operation["payload"]["message_id"], 90)
                self.assertEqual(operation["publishedAt"], original["publishedAt"])
                self.contract(request | {"action": "acknowledge", "operation": operation,
                                         "result": True})
                self.assertEqual(self.scalar("SELECT message_id FROM channel_deliveries WHERE item_id='1'"), 90)
            else:
                self.assertEqual((operation["method"], operation["operation"]),
                                 ("sendMessage", "repost"))
                self.assertNotIn("message_id", operation["payload"])
                self.assertNotEqual(operation["publishedAt"], original["publishedAt"])
            self.assertTrue(operation["payload"]["disable_web_page_preview"])

    def test_widened_filter_needs_consent_but_fresh_change_readmits(self):
        user = {"chatId": 42, "active": True, "sendInitialApartments": True,
                "filters": filters() | {"price": {"min": None, "max": 50000}}}
        request = {"op": "private", "config": {"initialDeliveryLimit": 10},
                   "user": user, "freshIds": []}
        self.assertEqual(self.contract(request)["count"], 0)
        self.assertEqual(self.scalar("SELECT count(*) FROM private_delivery_decisions WHERE status=2"), 4)
        user["filters"] = filters()
        self.assertEqual(self.contract(request)["count"], 0)
        self.apartments["2"]["updatedAt"] = datetime.fromtimestamp(
            (NOW + 1000) / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        self.db.execute("UPDATE apartments SET payload_json=?,changed_sequence=2 WHERE item_id='2'",
                        (json.dumps(self.apartments["2"], ensure_ascii=False),))
        self.db.execute("INSERT INTO private_delivery_work(recipient_id,item_id) VALUES('42','2')")
        readmitted = self.contract(request | {"nowMs": NOW + 1000})
        self.assertEqual((readmitted["count"], readmitted["next"]["apartment"]["itemId"]), (1, "2"))
        self.assertEqual(self.scalar("SELECT count(*) FROM private_delivery_decisions WHERE item_id='2'"), 0)

    def test_deletion_ignores_same_batch_registration(self):
        for chat_id in (42, 99):
            self.db.execute("INSERT INTO telegram_users(chat_id,active,send_initial_apartments,filters_json) VALUES(?,1,1,?)",
                            (chat_id, json.dumps(filters())))
        self.db.execute("INSERT INTO private_recipients(recipient_id,initial_selection_applied) VALUES('42',1)")
        self.db.execute("INSERT INTO private_delivery_decisions VALUES('42','1',0,?)", (NOW,))
        self.db.execute("INSERT INTO private_delivery_work(recipient_id,item_id) VALUES('42','2')")
        chat, sender = {"id": 42, "type": "private"}, {"id": 42}
        result = self.contract({
            "op": "bot", "config": {"telegramAccessMode": "owner", "telegramOwnerId": 99},
            "updates": [
                {"update_id": 1, "message": {"from": sender, "chat": chat, "text": "/delete_my_data"}},
                {"update_id": 2, "callback_query": {"id": "confirm", "from": sender,
                    "data": "d:confirm", "message": {"message_id": 10, "chat": chat}}},
                {"update_id": 3, "message": {"from": sender, "chat": chat, "text": "/start"}},
            ],
        })
        self.assertEqual(result["state"]["updateOffset"], 4)
        self.assertNotIn("42", result["state"]["users"])
        self.assertIn("99", result["state"]["users"])
        for table in ("private_recipients", "private_delivery_work", "private_delivery_decisions"):
            self.assertEqual(self.scalar(f"SELECT count(*) FROM {table} WHERE recipient_id='42'"), 0)
        self.assertEqual(result["operations"][-1]["payload"]["text"], "Ваши данные удалены.")

    def test_history_answer_is_persisted_before_response(self):
        self.db.execute("INSERT INTO telegram_users(chat_id,active,send_initial_apartments,filters_json) VALUES(42,1,1,?)",
                        (json.dumps(filters()),))
        self.db.execute("INSERT INTO private_recipients(recipient_id,initial_selection_applied) VALUES('42',1)")
        for item_id in ("1", "2"):
            self.db.execute("INSERT INTO private_delivery_decisions VALUES('42',?,2,?)", (item_id, NOW))
        chat, sender = {"id": 42, "type": "private"}, {"id": 42}
        request = {"op": "bot", "config": {"initialDeliveryLimit": 1}}
        offered = self.contract(request | {"updates": [
            {"update_id": 1, "message": {"from": sender, "chat": chat, "text": "/menu"}}]})
        self.assertIn("Подходящих объявлений за последние 24 часа: 1",
                      offered["operations"][-1]["payload"]["text"])
        declined = self.contract(request | {"updates": [
            {"update_id": 2, "callback_query": {"id": "skip", "from": sender,
                "data": "m:history:skip", "message": {"chat": chat, "message_id": 8}}}]})
        self.assertIn("эти объявления отправлены не будут",
                      declined["operations"][-1]["payload"]["text"])
        self.assertEqual(self.scalar("SELECT status FROM private_delivery_decisions WHERE item_id='1'"), 1)
        accepted = self.contract(request | {"updates": [
            {"update_id": 3, "callback_query": {"id": "send", "from": sender,
                "data": "m:history:send", "message": {"chat": chat, "message_id": 9}}}]})
        self.assertEqual(accepted["operations"][-1]["payload"]["text"],
                         "Хорошо, отправлю их при следующей проверке. Объявлений: 1.")
        self.assertEqual(self.scalar("SELECT count(*) FROM private_delivery_decisions WHERE item_id='2'"), 0)
        self.assertEqual(self.scalar("SELECT item_id FROM private_delivery_work WHERE recipient_id='42'"), "2")

    def test_only_recent_changed_acknowledgement_is_redelivered(self):
        decided = NOW - 60000
        self.apartments["1"]["updatedAt"] = AT
        self.apartments["2"]["updatedAt"] = None
        self.apartments["4"]["updatedAt"] = datetime.fromtimestamp(
            (decided - 1000) / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        for apartment in self.apartments.values():
            self.db.execute("UPDATE apartments SET payload_json=? WHERE item_id=?",
                            (json.dumps(apartment, ensure_ascii=False), apartment["itemId"]))
        self.db.execute("INSERT INTO private_recipients(recipient_id,initial_selection_applied) VALUES('42',1)")
        for item_id in self.apartments:
            self.db.execute(
                "INSERT INTO private_delivery_decisions(recipient_id,item_id,status,decided_at) VALUES('42',?,0,?)",
                (item_id, decided),
            )
        result = self.contract({"op": "private", "config": {"initialDeliveryLimit": 4},
            "user": {"chatId": 42, "active": True, "filters": filters()}, "freshIds": []})
        self.assertEqual((result["count"], result["next"]["apartment"]["itemId"]), (1, "1"))
        self.assertEqual(self.scalar("SELECT count(*) FROM private_delivery_decisions WHERE status=0"), 4)

    def test_history_and_offset_roll_back_together_then_replay_once(self):
        for answer in ("send", "skip"):
            for failure in ("decision_write", "before_commit"):
                with self.subTest(answer=answer, failure=failure):
                    self.db.execute("DELETE FROM private_delivery_work")
                    self.db.execute("DELETE FROM private_delivery_decisions")
                    self.db.execute("DELETE FROM private_recipients")
                    self.db.execute("DELETE FROM telegram_users")
                    self.db.execute("UPDATE telegram_state SET update_offset=0 WHERE singleton=1")
                    self.db.execute(
                        "INSERT INTO telegram_users(chat_id,active,send_initial_apartments,filters_json) VALUES(42,1,1,?)",
                        (json.dumps(filters()),),
                    )
                    self.db.execute("INSERT INTO private_recipients(recipient_id,initial_selection_applied) VALUES('42',1)")
                    self.db.execute("INSERT INTO private_delivery_decisions VALUES('42','1',2,?)", (NOW,))
                    update = {"update_id": 7, "callback_query": {
                        "id": f"{answer}-callback", "from": {"id": 42},
                        "data": f"m:history:{answer}",
                        "message": {"chat": {"id": 42, "type": "private"}, "message_id": 8},
                    }}
                    request = {"op": "bot", "config": {"initialDeliveryLimit": 10},
                               "updates": [update]}
                    interrupted = self.contract(request | {"failHistoryAt": failure}, allow_error=True)
                    self.assertIn("CHECK constraint failed", interrupted["error"])
                    self.assertEqual(self.scalar("SELECT update_offset FROM telegram_state"), 0)
                    self.assertEqual([(row[0], row[1]) for row in self.db.execute(
                        "SELECT item_id,status FROM private_delivery_decisions")], [("1", 2)])
                    self.assertEqual(self.scalar("SELECT count(*) FROM private_delivery_work"), 0)
                    resumed = self.contract(request)
                    self.assertEqual(resumed["state"]["updateOffset"], 8)
                    self.assertEqual(self.scalar("SELECT update_offset FROM telegram_state"), 8)
                    self.assertEqual(self.contract(request)["state"]["updateOffset"], 8)
                    self.assertEqual(self.scalar("SELECT count(*) FROM private_delivery_work"),
                                     1 if answer == "send" else 0)
                    self.assertEqual([(row[0], row[1]) for row in self.db.execute(
                        "SELECT item_id,status FROM private_delivery_decisions")],
                        [] if answer == "send" else [("1", 1)])

    def test_invalid_filter_keeps_offset_until_response(self):
        self.db.execute("INSERT INTO telegram_users(chat_id,active,send_initial_apartments,filters_json,pending_filter_input) VALUES(42,1,1,?,'price')",
                        (json.dumps(filters()),))
        response = self.contract({"op": "bot", "config": {"initialDeliveryLimit": 10},
            "updates": [{"update_id": 7, "message": {"from": {"id": 42},
                "chat": {"id": 42, "type": "private"}, "text": "invalid range"}}]})
        self.assertEqual(response["state"]["updateOffset"], 0)
        self.assertEqual(response["operations"][-1]["ackOffset"], 8)
        self.assertEqual(self.scalar("SELECT update_offset FROM telegram_state"), 0)


if __name__ == "__main__":
    unittest.main()

"""Packaged service acceptance against isolated Python HTTP peers.

The peer is deliberately smaller than the application: it serves fixed source
cards and records Telegram calls. Expected messages and database outcomes come
from a frozen fixture, never from the Rust executable under test.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from socket import socket
from urllib.request import urlopen


APARTMENT = "100000"
HOUSE = "100001"
OWNER = 123
DENIED = 77
POLICY_USER = 42
CONSENT_USER = 43
CHANNEL = "@test_channel"


def _free_port() -> int:
    with socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def _card(item_id: str, title: str, price: str) -> str:
    return (
        '<a class="category-data-list-card__destination" '
        f'href="/ru/item/{item_id}"><div class="pt">{title}</div>'
        f'<div class="p">{price}</div><div class="l">Арабкир</div>'
        '<div class="at">2 ком. · 60 кв.м. · 3/9</div>'
        '<div class="d">Сегодня, 00:00</div></a>'
    )


def _update(update_id: int, chat_id: int, text: str) -> dict:
    return {
        "update_id": update_id,
        "message": {
            "message_id": update_id + 200,
            "from": {"id": chat_id},
            "chat": {"id": chat_id, "type": "private"},
            "text": text,
        },
    }


def _callback(update_id: int, chat_id: int, data: str) -> dict:
    return {
        "update_id": update_id,
        "callback_query": {
            "id": f"query{update_id}",
            "from": {"id": chat_id},
            "message": {"message_id": 201, "chat": {"id": chat_id, "type": "private"}},
            "data": data,
        },
    }


class Peer:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.calls: list[tuple[str, dict]] = []
        self.paths: list[str] = []
        self.updates = [_update(1, DENIED, "/start"), _update(2, POLICY_USER, "/menu")]
        self.updated_title = False
        self.retry_listing_once = True
        self.retry_after_seconds = 1
        self.retry_count = 0
        self.identity_failure = False
        self.challenge_once = False
        self.challenge_count = 0
        self.server: ThreadingHTTPServer | None = None
        self.thread: threading.Thread | None = None

    @property
    def origin(self) -> str:
        assert self.server is not None
        return f"http://127.0.0.1:{self.server.server_port}"

    def queue(self, update: dict) -> None:
        with self.lock:
            self.updates.append(update)

    def snapshot(self) -> list[tuple[str, dict]]:
        with self.lock:
            return list(self.calls)

    def source_paths(self) -> list[str]:
        with self.lock:
            return list(self.paths)

    def __enter__(self) -> "Peer":
        peer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, _format: str, *_args: object) -> None:
                pass

            def _respond(self, status: int, body: str, content_type: str, headers: dict | None = None) -> None:
                encoded = body.encode("utf-8")
                self.send_response(status)
                self.send_header("content-type", content_type)
                self.send_header("content-length", str(len(encoded)))
                for key, value in (headers or {}).items():
                    self.send_header(key, value)
                self.end_headers()
                try:
                    self.wfile.write(encoded)
                except BrokenPipeError:
                    pass

            def do_GET(self) -> None:
                with peer.lock:
                    peer.paths.append(self.path)
                    updated = peer.updated_title
                    challenge = peer.challenge_once
                    if challenge:
                        peer.challenge_once = False
                        peer.challenge_count += 1
                if challenge:
                    self._respond(503, "source challenge", "text/plain", {"cf-mitigated": "challenge"})
                    return
                if not self.path.split("?", 1)[0].endswith("/1"):
                    self._respond(200, '<div id="contentr"></div>', "text/html")
                    return
                if self.path.startswith("/ru/category/56/"):
                    title = "Replay rental 100000 updated" if updated else "Replay rental 100000"
                    card = _card(APARTMENT, title, "100000 ֏")
                    self._respond(200, f'<div id="contentr">{card}</div>', "text/html")
                elif self.path.startswith("/ru/category/1377/"):
                    card = _card(HOUSE, "Replay rental 100001", "$500")
                    self._respond(200, f'<div id="contentr">{card}</div>', "text/html")
                else:
                    self._respond(404, "missing fixture", "text/plain")

            def do_POST(self) -> None:
                if self.path == "/cba":
                    rates = "".join(
                        f"<ExchangeRate><ISO>{iso}</ISO><Amount>1</Amount><Rate>400</Rate></ExchangeRate>"
                        for iso in ("USD", "EUR", "RUB")
                    )
                    xml = (
                        "<ExchangeRatesLatestResult>"
                        f"<CurrentDate>{date.today().isoformat()}</CurrentDate>"
                        f"{rates}</ExchangeRatesLatestResult>"
                    )
                    self._respond(200, xml, "text/xml")
                    return
                raw = self.rfile.read(int(self.headers.get("content-length", "0")))
                try:
                    payload = json.loads(raw or b"{}")
                except json.JSONDecodeError:
                    self._respond(400, "invalid synthetic request", "text/plain")
                    return
                method = self.path.rsplit("/", 1)[-1]
                with peer.lock:
                    peer.calls.append((method, payload))
                    if method == "getUpdates":
                        offset = int(payload.get("offset", 0))
                        result = [u for u in peer.updates if u["update_id"] >= offset]
                    elif method == "getMe":
                        result = {"id": 999, "is_bot": True}
                    elif method == "getChat":
                        result = {"type": "channel"}
                    elif method == "getChatMember":
                        result = {
                            "status": "administrator",
                            "can_post_messages": True,
                            "can_edit_messages": True,
                        }
                    elif method in ("sendMessage", "editMessageText"):
                        result = {"message_id": 1000 + len(peer.calls)}
                    else:
                        result = True
                    retry = (
                        method == "sendMessage"
                        and payload.get("chat_id") == OWNER
                        and f"/ru/item/{APARTMENT}" in payload.get("text", "")
                        and peer.retry_listing_once
                    )
                    if retry:
                        peer.retry_listing_once = False
                        peer.retry_count += 1
                    identity_failure = method == "getMe" and peer.identity_failure
                if identity_failure:
                    self._respond(
                        401,
                        json.dumps({"ok": False, "error_code": 401, "description": "Unauthorized"}),
                        "application/json",
                    )
                    return
                if retry:
                    error = {
                        "ok": False,
                        "error_code": 429,
                        "description": "Too Many Requests",
                        "parameters": {"retry_after": peer.retry_after_seconds},
                    }
                    self._respond(429, json.dumps(error), "application/json")
                else:
                    self._respond(200, json.dumps({"ok": True, "result": result}), "application/json")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        assert self.server is not None and self.thread is not None
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


def _wait(label: str, predicate, *, seconds: float = 25, detail=None) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    suffix = f": {detail()!r}" if detail else ""
    raise AssertionError(f"timed out waiting for {label}{suffix}")


def _messages(calls: list[tuple[str, dict]], method: str, chat_id) -> list[dict]:
    return [p for m, p in calls if m == method and p.get("chat_id") == chat_id]


def _listing_messages(calls: list[tuple[str, dict]], method: str, chat_id, item_id: str) -> list[dict]:
    return [p for p in _messages(calls, method, chat_id) if f"/ru/item/{item_id}" in p.get("text", "")]


def _read_state(harness, volume: str) -> dict:
    with harness.host_access(volume):
        connection = sqlite3.connect(str(Path(volume) / "state.sqlite3"))
        connection.row_factory = sqlite3.Row
        try:
            rows = lambda sql: [dict(row) for row in connection.execute(sql)]
            return {
                "apartments": rows("SELECT item_id,kind,payload_json FROM apartments ORDER BY item_id"),
                "decisions": rows(
                    "SELECT recipient_id,item_id,status FROM private_delivery_decisions ORDER BY recipient_id,item_id"
                ),
                "channel": rows(
                    "SELECT item_id,status,message_id FROM channel_deliveries ORDER BY item_id"
                ),
                "users": rows("SELECT chat_id,active FROM telegram_users ORDER BY chat_id"),
                "offset": connection.execute("SELECT update_offset FROM telegram_state").fetchone()[0],
                "rates": rows("SELECT snapshot_json FROM exchange_rate_state"),
                "pendingWork": rows(
                    "SELECT recipient_id,item_id FROM private_delivery_work ORDER BY recipient_id,item_id"
                ),
            }
        finally:
            connection.close()


def _ready(port: int) -> bool:
    try:
        with urlopen(f"http://127.0.0.1:{port}/ready", timeout=1) as response:
            return response.status == 200
    except OSError:
        return False


def _interrupted_pending(harness, expected: dict) -> dict:
    """A rejected send stays durable when SIGTERM interrupts its retry wait."""
    volume = harness.new_volume()
    harness.run_app(["state:init", "--data-directory", "/app/.data"], data_volume=volume)
    with harness.host_access(volume):
        with sqlite3.connect(str(Path(volume) / "state.sqlite3")) as connection:
            filters = {
                "kinds": ["apartment", "house"],
                "price": {"min": None, "max": None},
                "rooms": {"min": None, "max": None},
                "locations": [],
            }
            connection.execute(
                "INSERT INTO telegram_users(chat_id,active,send_initial_apartments,filters_json) VALUES(?,1,1,?)",
                (OWNER, json.dumps(filters)),
            )
    with Peer() as peer:
        peer.updates = []
        peer.retry_after_seconds = 60
        port = _free_port()
        options = [
            "serve", "--telegram-endpoint", f"{peer.origin}/telegram",
            "--source-origin", peer.origin, "--cba-endpoint", f"{peer.origin}/cba",
        ]
        env = {
            "NODE_ENV": "test", "TELEGRAM_ACCESS_MODE": "owner",
            "HEALTH_PORT": str(port), "INITIAL_PAGE_COUNT": "1",
            "POLL_INTERVAL_MS": "100", "TELEGRAM_POLL_TIMEOUT_SECONDS": "1",
            "EXTERNAL_RETRY_BASE_MS": "10", "EXTERNAL_RETRY_MAX_MS": "100",
            "TELEGRAM_PRIVATE_DELIVERIES_PER_MINUTE": "30",
        }
        interrupted = harness.start_app(options, data_volume=volume, env=env)
        try:
            _wait(
                "rejected private send before interruption",
                lambda: peer.retry_count == 1,
                detail=lambda: (peer.snapshot(), harness.logs(interrupted)),
            )
        finally:
            harness.stop_app(interrupted)
        pending = _read_state(harness, volume)
        assert not any(
            row["item_id"] == APARTMENT and row["status"] == 0
            for row in pending["decisions"]
        ), pending
        assert any(row["item_id"] == APARTMENT for row in pending["pendingWork"]), pending
        before_resume = len(peer.snapshot())
        resumed = harness.start_app(options, data_volume=volume, env=env)
        try:
            _wait(
                "durable private retry after restart",
                lambda: (
                    len(_listing_messages(peer.snapshot()[before_resume:], "sendMessage", OWNER, APARTMENT)) == 1
                    and len(_listing_messages(peer.snapshot(), "sendMessage", OWNER, HOUSE)) == 1
                ),
                seconds=30,
                detail=lambda: (peer.snapshot()[-20:], harness.logs(resumed)[-4000:]),
            )
        finally:
            harness.stop_app(resumed)
        completed = _read_state(harness, volume)
        assert {row["item_id"]: row["status"] for row in completed["decisions"]} == {
            APARTMENT: 0, HOUSE: 0
        }, completed
        for item_id, message in expected["privateMessages"].items():
            sent = _listing_messages(peer.snapshot(), "sendMessage", OWNER, item_id)
            expected_attempts = 2 if item_id == APARTMENT else 1
            assert len(sent) == expected_attempts and all(p["text"] == message for p in sent), sent
        return {"rejectedAttempts": peer.retry_count, "pendingBeforeRestart": True, "completedAfterRestart": True}


def run_service(harness, fixtures_dir: Path) -> dict:
    """Run one isolated packaged-service lifecycle and return its evidence."""
    expected = json.loads((fixtures_dir / "service-expected.json").read_text())
    volume = harness.new_volume()
    initialized = harness.run_app(
        ["state:init", "--data-directory", "/app/.data", "--channel", CHANNEL],
        data_volume=volume,
        env={"TELEGRAM_CHANNEL_ID": CHANNEL},
    )
    assert initialized.returncode == 0, initialized.stderr
    with harness.host_access(volume):
        connection = sqlite3.connect(str(Path(volume) / "state.sqlite3"))
        try:
            filters = {
                "kinds": ["apartment", "house"],
                "price": {"min": None, "max": None},
                "rooms": {"min": None, "max": None},
                "locations": [],
            }
            connection.execute(
                "INSERT INTO telegram_users(chat_id,active,send_initial_apartments,filters_json) VALUES(?,1,1,?)",
                (OWNER, json.dumps(filters)),
            )
            connection.execute(
                "INSERT INTO telegram_users(chat_id,active,send_initial_apartments,filters_json) VALUES(?,1,1,?)",
                (POLICY_USER, json.dumps(filters)),
            )
            connection.execute(
                "INSERT INTO telegram_users(chat_id,active,send_initial_apartments,filters_json) VALUES(?,0,0,?)",
                (CONSENT_USER, json.dumps(filters)),
            )
            connection.commit()
        finally:
            connection.close()

    with Peer() as peer:
        port = _free_port()
        options = [
            "serve",
            "--telegram-endpoint", f"{peer.origin}/telegram",
            "--source-origin", peer.origin,
            "--cba-endpoint", f"{peer.origin}/cba",
        ]
        env = {
            "NODE_ENV": "test",
            "TELEGRAM_ACCESS_MODE": "owner",
            "TELEGRAM_CHANNEL_ID": CHANNEL,
            "HEALTH_PORT": str(port),
            "INITIAL_PAGE_COUNT": "1",
            "POLL_INTERVAL_MS": "100",
            "TELEGRAM_POLL_TIMEOUT_SECONDS": "1",
            "EXTERNAL_RETRY_BASE_MS": "10",
            "EXTERNAL_RETRY_MAX_MS": "100",
            "TELEGRAM_PRIVATE_DELIVERIES_PER_MINUTE": "30",
        }
        first = harness.start_app(options, data_volume=volume, env=env)
        try:
            _wait("ready service", lambda: _ready(port), detail=lambda: harness.logs(first))
            _wait(
                "private apartment and house plus channel apartment",
                lambda: (
                    len(_listing_messages(peer.snapshot(), "sendMessage", OWNER, APARTMENT)) >= 2
                    and len(_listing_messages(peer.snapshot(), "sendMessage", OWNER, HOUSE)) == 1
                    and len(_listing_messages(peer.snapshot(), "sendMessage", CHANNEL, APARTMENT)) == 1
                ),
                detail=lambda: (peer.snapshot(), harness.logs(first)),
            )
            _wait(
                "denied persisted recipient",
                lambda: any(
                    "Доступ к боту ограничен" in payload.get("text", "")
                    for payload in _messages(peer.snapshot(), "sendMessage", POLICY_USER)
                ),
                detail=lambda: peer.snapshot(),
            )
        finally:
            harness.stop_app(first)
        first_calls = peer.snapshot()
        assert peer.retry_count == 1, first_calls
        assert not _listing_messages(first_calls, "sendMessage", CHANNEL, HOUSE)
        assert any("/1377/1" in path for path in peer.source_paths())
        assert any("/56/1" in path for path in peer.source_paths())
        assert _messages(first_calls, "sendMessage", DENIED), "denied user received no policy response"
        first_state = _read_state(harness, volume)
        assert {row["item_id"]: row["kind"] for row in first_state["apartments"]} == {
            APARTMENT: "apartment", HOUSE: "house"
        }, first_state
        assert {row["item_id"]: row["status"] for row in first_state["decisions"]} == {
            APARTMENT: 0, HOUSE: 0
        }, first_state
        assert {row["item_id"]: row["status"] for row in first_state["channel"]} == {
            APARTMENT: "published", HOUSE: "filtered"
        }, first_state
        assert first_state["users"] == [
            {"chat_id": POLICY_USER, "active": 1},
            {"chat_id": CONSENT_USER, "active": 0},
            {"chat_id": OWNER, "active": 1},
        ], first_state
        assert first_state["offset"] == 3, first_state
        payloads = {row["item_id"]: json.loads(row["payload_json"]) for row in first_state["apartments"]}
        assert payloads[HOUSE]["price"]["amountAmd"] == 200000, payloads[HOUSE]
        assert payloads[HOUSE]["price"]["originalCurrency"] == "USD", payloads[HOUSE]
        for item_id, message in expected["privateMessages"].items():
            matching = _listing_messages(first_calls, "sendMessage", OWNER, item_id)
            assert matching and all(call["text"] == message for call in matching), matching
        for item_id, message in expected["channelMessages"].items():
            matching = _listing_messages(first_calls, "sendMessage", CHANNEL, item_id)
            assert len(matching) == 1 and matching[0]["text"] == message, matching

        before_restart = len(peer.snapshot())
        admitted_env = {
            **env,
            "TELEGRAM_ACCESS_MODE": "allowlist",
            "TELEGRAM_ALLOWED_USER_IDS": f"{POLICY_USER},{CONSENT_USER}",
        }
        second = harness.start_app(options, data_volume=volume, env=admitted_env)
        try:
            _wait("ready restarted service", lambda: _ready(port), detail=lambda: harness.logs(second))
            _wait(
                "restart crawl",
                lambda: any(
                    f'"event":"{event}"' in harness.logs(second)
                    for event in ("crawl.completed", "crawl.succeeded")
                ),
                detail=lambda: harness.logs(second),
            )
            duplicate_calls = peer.snapshot()[before_restart:]
            assert not any(
                f"/ru/item/{item_id}" in payload.get("text", "")
                for method, payload in duplicate_calls
                if method == "sendMessage" and payload.get("chat_id") == OWNER
                for item_id in (APARTMENT, HOUSE)
            ), duplicate_calls
            _wait(
                "newly admitted recipient delivery",
                lambda: all(
                    len(_listing_messages(peer.snapshot(), "sendMessage", POLICY_USER, item_id)) == 1
                    for item_id in (APARTMENT, HOUSE)
                ),
                detail=lambda: (peer.snapshot(), harness.logs(second)),
            )
            for item_id, message in expected["privateMessages"].items():
                assert _listing_messages(peer.snapshot(), "sendMessage", POLICY_USER, item_id)[0]["text"] == message
            before_menu = len(peer.snapshot())
            peer.queue(_update(3, POLICY_USER, "/menu"))
            _wait(
                "newly admitted recipient menu",
                lambda: any(
                    "/ru/item/" not in payload.get("text", "")
                    and "Доступ к боту ограничен" not in payload.get("text", "")
                    for payload in _messages(peer.snapshot()[before_menu:], "sendMessage", POLICY_USER)
                ),
                detail=lambda: peer.snapshot(),
            )
            before_start = len(peer.snapshot())
            peer.queue(_update(4, CONSENT_USER, "/start"))
            _wait(
                "inactive recipient start menu",
                lambda: bool(_messages(peer.snapshot()[before_start:], "sendMessage", CONSENT_USER)),
                detail=lambda: peer.snapshot()[-20:],
            )
            assert not _listing_messages(peer.snapshot(), "sendMessage", CONSENT_USER, APARTMENT)
            peer.queue(_callback(5, CONSENT_USER, "m:start"))
            _wait(
                "history consent choice",
                lambda: any(m == "answerCallbackQuery" and p.get("callback_query_id") == "query5" for m, p in peer.snapshot()),
                detail=lambda: peer.snapshot()[-20:],
            )
            peer.queue(_callback(6, CONSENT_USER, "m:start:initial"))
            _wait(
                "historical listings after explicit consent",
                lambda: all(
                    len(_listing_messages(peer.snapshot(), "sendMessage", CONSENT_USER, item_id)) == 1
                    for item_id in (APARTMENT, HOUSE)
                ),
                seconds=30,
                detail=lambda: (peer.snapshot()[-20:], harness.logs(second)[-4000:]),
            )
            for item_id, message in expected["privateMessages"].items():
                assert _listing_messages(peer.snapshot(), "sendMessage", CONSENT_USER, item_id)[0]["text"] == message
            peer.queue(_callback(7, CONSENT_USER, "f:price"))
            _wait(
                "price filter prompt",
                lambda: any(m == "answerCallbackQuery" and p.get("callback_query_id") == "query7" for m, p in peer.snapshot()),
                detail=lambda: peer.snapshot()[-20:],
            )
            before_filter_save = len(peer.snapshot())
            peer.queue(_update(8, CONSENT_USER, "100000-250000"))
            _wait(
                "price filter saved",
                lambda: bool(_messages(peer.snapshot()[before_filter_save:], "sendMessage", CONSENT_USER)),
                detail=lambda: peer.snapshot()[-20:],
            )
            with peer.lock:
                peer.updated_title = True
            _wait(
                "channel edit after source change",
                lambda: bool(_listing_messages(peer.snapshot(), "editMessageText", CHANNEL, APARTMENT)),
                seconds=20,
                detail=lambda: (peer.snapshot(), harness.logs(second)),
            )
            edits = _listing_messages(peer.snapshot(), "editMessageText", CHANNEL, APARTMENT)
            assert edits[-1]["message_id"] == first_state["channel"][0]["message_id"], edits
            assert edits[-1]["text"] == expected["channelEditedMessage"], edits
            peer.queue(_callback(9, OWNER, "m:stop"))
            _wait(
                "private stop acknowledgement",
                lambda: any(m == "answerCallbackQuery" and p.get("callback_query_id") == "query9" for m, p in peer.snapshot()),
                detail=lambda: peer.snapshot(),
            )
            peer.queue(_update(10, POLICY_USER, "/delete_my_data"))
            _wait(
                "deletion cancellation menu",
                lambda: any("d:confirm" in json.dumps(p) for p in _messages(peer.snapshot(), "sendMessage", POLICY_USER)),
                detail=lambda: peer.snapshot(),
            )
            peer.queue(_callback(11, POLICY_USER, "d:cancel"))
            _wait(
                "deletion cancellation acknowledgement",
                lambda: any(
                    "Удаление данных отменено" in p.get("text", "")
                    for p in _messages(peer.snapshot(), "editMessageText", POLICY_USER)
                ),
                detail=lambda: peer.snapshot(),
            )
            peer.queue(_update(12, OWNER, "/delete_my_data"))
            _wait(
                "deletion confirmation menu",
                lambda: any("d:confirm" in json.dumps(p) for p in _messages(peer.snapshot(), "sendMessage", OWNER)),
                detail=lambda: peer.snapshot(),
            )
            peer.queue(_callback(13, OWNER, "d:confirm"))
            _wait(
                "deletion acknowledgement",
                lambda: any(m == "answerCallbackQuery" and p.get("callback_query_id") == "query13" for m, p in peer.snapshot()),
                detail=lambda: peer.snapshot(),
            )
        finally:
            harness.stop_app(second)
        final_state = _read_state(harness, volume)
        assert final_state["users"] == [
            {"chat_id": POLICY_USER, "active": 1},
            {"chat_id": CONSENT_USER, "active": 1},
        ], final_state
        assert {
            (row["recipient_id"], row["item_id"]): row["status"]
            for row in final_state["decisions"]
        } == {
            (str(user), item_id): 0
            for user in (POLICY_USER, CONSENT_USER)
            for item_id in (APARTMENT, HOUSE)
        }, final_state
        with harness.host_access(volume):
            with sqlite3.connect(str(Path(volume) / "state.sqlite3")) as connection:
                filters_json = connection.execute(
                    "SELECT filters_json FROM telegram_users WHERE chat_id=?", (CONSENT_USER,)
                ).fetchone()[0]
        assert json.loads(filters_json)["price"] == {"min": 100000, "max": 250000}
        assert final_state["offset"] == 14, final_state
        assert {row["item_id"]: row["status"] for row in final_state["channel"]} == {
            APARTMENT: "published", HOUSE: "filtered"
        }, final_state
        with peer.lock:
            peer.challenge_once = True
        challenge_calls = len(peer.snapshot())
        challenge = harness.start_app(options, data_volume=volume, env=env)
        try:
            _wait(
                "source challenge diagnosed",
                lambda: "ERR_LIST_AM_CHALLENGE" in harness.logs(challenge),
                seconds=15,
                detail=lambda: harness.logs(challenge),
            )
            _wait(
                "source challenge recovered",
                lambda: _ready(port) and any(
                    f'"event":"{event}"' in harness.logs(challenge)
                    for event in ("crawl.completed", "crawl.succeeded")
                ),
                seconds=25,
                detail=lambda: harness.logs(challenge),
            )
            peer.queue(_update(14, POLICY_USER, "/menu"))
            _wait(
                "access revoked after policy reset",
                lambda: any(
                    "Доступ к боту ограничен" in payload.get("text", "")
                    for payload in _messages(peer.snapshot()[challenge_calls:], "sendMessage", POLICY_USER)
                ),
                detail=lambda: peer.snapshot(),
            )
        finally:
            harness.stop_app(challenge)
        assert peer.challenge_count == 1
        challenged_state = _read_state(harness, volume)
        assert challenged_state["offset"] == 15, challenged_state
        assert challenged_state["decisions"] == final_state["decisions"], challenged_state
        assert challenged_state["users"] == final_state["users"], challenged_state

        failure_volume = harness.new_volume()
        harness.run_app(["state:init", "--data-directory", "/app/.data"], data_volume=failure_volume)
        with peer.lock:
            peer.identity_failure = True
        source_count = len(peer.source_paths())
        failure = harness.start_app(options, data_volume=failure_volume, env={**env, "TELEGRAM_CHANNEL_ID": ""})
        try:
            _wait(
                "credential preflight rejection",
                lambda: not harness.inspect(failure)["State"]["Running"],
                seconds=10,
                detail=lambda: harness.logs(failure),
            )
            assert harness.inspect(failure)["State"]["ExitCode"] != 0
            assert len(peer.source_paths()) == source_count, "failed identity reached source peer"
            assert "synthetic-native-acceptance" not in harness.logs(failure)
        finally:
            harness.stop_app(failure)
        interruption = _interrupted_pending(harness, expected)
        return {
            "status": "passed",
            "sourceCategories": ["apartment", "house"],
            "privateListingIds": [APARTMENT, HOUSE],
            "channelPublishedIds": [APARTMENT],
            "retryAttempts": peer.retry_count,
            "restartNoDuplicate": True,
            "channelEditPreservedMessageId": True,
            "policyDeniedUser": DENIED,
            "policyReactivatedUser": POLICY_USER,
            "policyRevokedUser": POLICY_USER,
            "initialHistoryConsent": CONSENT_USER,
            "priceFilterEdited": CONSENT_USER,
            "privateStopped": OWNER,
            "deletionCancelled": POLICY_USER,
            "confirmedDeletion": OWNER,
            "sourceChallengeRecovered": True,
            "servedPopulatedProductionState": True,
            "interruptedPending": interruption,
            "credentialPreflightRejected": True,
            "durableOffset": challenged_state["offset"],
        }

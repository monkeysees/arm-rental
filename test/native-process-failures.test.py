#!/usr/bin/env python3
"""Production Rust process failures against disposable local HTTP peers."""

from __future__ import annotations

from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import signal
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
import unittest


ROOT = Path(__file__).resolve().parents[1]
BINARY = Path(os.environ.get("RENTAL_APP_BINARY", ROOT / "experiments/rust-replay/target/debug/rental-app"))
CHANNEL = "@test_channel"


def wait_for(label: str, predicate, seconds: float = 15) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.025)
    raise AssertionError(f"timed out waiting for {label}")


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def page(kind: str) -> str:
    base = 100 if kind == "apartment" else 200
    cards = "".join(
        '<a class="category-data-list-card__destination" '
        f'href="/ru/item/{base + index}"><div class="pt">Квартира {index}</div>'
        '<div class="p">200000 ֏</div><div class="l">Кентрон</div>'
        '<div class="at">2 ком. · 60 кв.м. · 2/5</div>'
        '<div class="d">Сегодня, 00:00</div></a>'
        for index in range(6)
    )
    return f'<div id="contentr">{cards}</div>'


class Peer:
    def __init__(self, hook=None, get_hook=None) -> None:
        self.hook = hook or (lambda _method, _payload: None)
        self.get_hook = get_hook or (lambda _path, _headers: None)
        self.calls: list[tuple[str, dict]] = []
        self.get_calls: list[tuple[str, dict, float]] = []
        self.lock = threading.Lock()
        self.errors: list[str] = []
        self.server: ThreadingHTTPServer | None = None
        self.thread: threading.Thread | None = None

    def count(self, method: str, chat_id=None) -> int:
        with self.lock:
            return sum(
                name == method and (chat_id is None or payload.get("chat_id") == chat_id)
                for name, payload in self.calls
            )

    def messages(self, chat_id=None) -> list[dict]:
        with self.lock:
            return [
                payload for method, payload in self.calls
                if method == "sendMessage" and (chat_id is None or payload.get("chat_id") == chat_id)
            ]

    def __enter__(self) -> "Peer":
        peer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, _format: str, *_args: object) -> None:
                pass

            def respond(self, status: int, body: str, content_type: str, headers: dict | None = None) -> None:
                content = body.encode()
                self.send_response(status)
                self.send_header("content-type", content_type)
                self.send_header("content-length", str(len(content)))
                for key, value in (headers or {}).items():
                    self.send_header(key, value)
                self.end_headers()
                try:
                    self.wfile.write(content)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def do_GET(self) -> None:
                headers = dict(self.headers)
                with peer.lock:
                    peer.get_calls.append((self.path, headers, time.monotonic()))
                overridden = peer.get_hook(self.path, headers)
                if overridden is not None:
                    status, body, extra_headers = overridden
                    self.respond(status, body, "text/html", extra_headers)
                    return
                if self.path.startswith("/ru/category/56/"):
                    self.respond(200, page("apartment") if "/1?" in self.path else '<div id="contentr"></div>', "text/html")
                elif self.path.startswith("/ru/category/1377/"):
                    self.respond(200, page("house") if "/1?" in self.path else '<div id="contentr"></div>', "text/html")
                else:
                    self.respond(404, "missing synthetic page", "text/plain")

            def do_POST(self) -> None:
                if self.path == "/cba":
                    rates = "".join(
                        f"<ExchangeRate><ISO>{iso}</ISO><Amount>1</Amount><Rate>400</Rate></ExchangeRate>"
                        for iso in ("USD", "EUR", "RUB")
                    )
                    self.respond(200, f"<ExchangeRatesLatestResult><CurrentDate>{date.today()}</CurrentDate>{rates}</ExchangeRatesLatestResult>", "text/xml")
                    return
                payload = json.loads(self.rfile.read(int(self.headers.get("content-length", "0"))) or b"{}")
                method = self.path.rsplit("/", 1)[-1]
                with peer.lock:
                    peer.calls.append((method, payload))
                try:
                    overridden = peer.hook(method, payload)
                except Exception as error:  # Report peer failures to the test thread.
                    peer.errors.append(repr(error))
                    overridden = (500, {"ok": False, "error_code": 500})
                if overridden is not None:
                    status, body = overridden
                elif method == "getMe":
                    status, body = 200, {"ok": True, "result": {"id": 10, "is_bot": True}}
                elif method == "getChat":
                    status, body = 200, {"ok": True, "result": {"type": "channel"}}
                elif method == "getChatMember":
                    status, body = 200, {"ok": True, "result": {"status": "administrator", "can_post_messages": True, "can_edit_messages": True}}
                elif method == "getUpdates":
                    status, body = 200, {"ok": True, "result": []}
                elif method in ("sendMessage", "editMessageText"):
                    status, body = 200, {"ok": True, "result": {"message_id": 1000}}
                else:
                    status, body = 200, {"ok": True, "result": True}
                self.respond(status, json.dumps(body), "application/json")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return self

    @property
    def origin(self) -> str:
        assert self.server is not None
        return f"http://127.0.0.1:{self.server.server_port}"

    def __exit__(self, *_: object) -> None:
        assert self.server is not None and self.thread is not None
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


class App:
    def __init__(self, directory: Path, peer: Peer, channel: str | None = None) -> None:
        self.directory = directory
        port = free_port()
        env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "NODE_ENV": "test",
            "DATA_DIRECTORY": str(directory),
            "TELEGRAM_BOT_TOKEN": "123:synthetic-native-failure",
            "TELEGRAM_OWNER_ID": "123",
            "CURL_IMPERSONATE_PATH": "/usr/bin/curl",
            "HEALTH_PORT": str(port),
            "INITIAL_PAGE_COUNT": "1",
            "POLL_INTERVAL_MS": "100",
            "TELEGRAM_POLL_TIMEOUT_SECONDS": "1",
            "TELEGRAM_PRIVATE_DELIVERIES_PER_MINUTE": "30",
            "EXTERNAL_RETRY_BASE_MS": "10",
            **({"TELEGRAM_CHANNEL_ID": channel} if channel else {}),
        }
        self.process = subprocess.Popen(
            [str(BINARY), "serve", "--telegram-endpoint", peer.origin + "/telegram",
             "--source-origin", peer.origin, "--cba-endpoint", peer.origin + "/cba"],
            env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        self.lines: list[str] = []
        self.readers = [
            threading.Thread(target=self._read, args=(pipe,), daemon=True)
            for pipe in (self.process.stdout, self.process.stderr)
        ]
        for reader in self.readers:
            reader.start()

    def _read(self, pipe) -> None:
        assert pipe is not None
        for line in pipe:
            self.lines.append(line)

    def logs(self) -> str:
        return "".join(self.lines)

    def stop(self, sig=signal.SIGTERM, timeout=6) -> int:
        if self.process.poll() is None:
            self.process.send_signal(sig)
        try:
            code = self.process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.process.kill()
            code = self.process.wait(timeout=3)
            raise AssertionError(f"native service failed to stop after signal {sig}: {self.logs()[-2000:]}")
        for reader in self.readers:
            reader.join(timeout=1)
        assert self.process.stdout is not None and self.process.stderr is not None
        self.process.stdout.close()
        self.process.stderr.close()
        return code


def initialize(directory: Path, users: list[int], channel: str | None = None, sql: str = "") -> None:
    result = subprocess.run(
        [str(BINARY), "state:init", "--data-directory", str(directory),
         *(["--channel", channel] if channel else [])],
        text=True, capture_output=True,
    )
    assert result.returncode == 0, result.stderr
    with sqlite3.connect(directory / "state.sqlite3") as db:
        filters = json.dumps({"kinds": ["apartment", "house"], "price": {"min": None, "max": None},
                              "rooms": {"min": None, "max": None}, "locations": []})
        db.executemany(
            "INSERT INTO telegram_users(chat_id,active,send_initial_apartments,filters_json) VALUES(?,1,1,?)",
            ((user, filters) for user in users),
        )
        if sql:
            db.executescript(sql)


class NativeProcessFailures(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        assert BINARY.is_file(), f"native production binary is missing: {BINARY}"

    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="native-process-failure-")
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)

    def peer(self, hook=None, get_hook=None) -> Peer:
        peer = Peer(hook, get_hook).__enter__()
        self.addCleanup(peer.__exit__, None, None, None)
        return peer

    def app(self, peer: Peer, users: list[int] | None = None, channel: str | None = None,
            *, initialize_state: bool = True, sql: str = "") -> App:
        if initialize_state:
            initialize(self.directory, users or [], channel, sql)
        app = App(self.directory, peer, channel)
        self.addCleanup(app.stop)
        return app

    def database(self):
        return sqlite3.connect(self.directory / "state.sqlite3")

    def test_announcement_completion_releases_first_listing_before_next_recipient(self) -> None:
        releases: list[threading.Event] = []
        lock = threading.Lock()

        def hook(method, _payload):
            if method == "sendMessage":
                event = threading.Event()
                with lock:
                    releases.append(event)
                event.wait(20)
            return None

        peer = self.peer(hook)
        app = self.app(peer, list(range(100, 110)))
        try:
            wait_for("eight simultaneous announcements", lambda: peer.count("sendMessage") == 8)
            first = peer.messages()
            self.assertTrue(all("/ru/item/" not in payload["text"] for payload in first))
            releases[0].set()
            wait_for("first recipient listing", lambda: peer.count("sendMessage") == 9, 5)
            sent = peer.messages()
            self.assertEqual(sent[8]["chat_id"], sent[0]["chat_id"])
            self.assertIn("/ru/item/", sent[8]["text"])
            self.assertEqual(app.stop(), 0, app.logs()[-2000:])
        finally:
            for event in releases:
                event.set()

    def test_unauthorized_poll_is_terminal(self) -> None:
        def hook(method, _payload):
            if method == "getUpdates":
                return 401, {"ok": False, "error_code": 401, "description": "Unauthorized"}
            return None

        peer = self.peer(hook)
        app = self.app(peer)
        wait_for("credential failure", lambda: app.process.poll() is not None, 7)
        self.assertNotEqual(app.stop(), 0)
        self.assertIn("ERR_TELEGRAM_CREDENTIALS", app.logs())

    def test_private_cooldown_and_blocked_user_do_not_block_channel_or_peer(self) -> None:
        def hook(method, payload):
            if method != "sendMessage":
                return None
            if payload.get("chat_id") == 42:
                return 429, {"ok": False, "error_code": 429, "parameters": {"retry_after": 60}}
            if payload.get("chat_id") == 99:
                return 403, {"ok": False, "error_code": 403,
                             "description": "Forbidden: bot was blocked by the user"}
            return None

        peer = self.peer(hook)
        app = self.app(peer, [42, 99, 123], CHANNEL)
        wait_for("channel and healthy private recipient", lambda: peer.count("sendMessage", CHANNEL) == 6 and peer.count("sendMessage", 123) >= 7, 20)
        self.assertEqual(peer.count("sendMessage", 42), 1)
        self.assertEqual(peer.count("sendMessage", 99), 1)
        healthy = peer.messages(123)
        self.assertIn("Подходящих объявлений", healthy[0]["text"])
        ids = [re.search(r"/ru/item/(\d+)", payload["text"]).group(1) for payload in healthy[1:7]]
        self.assertEqual(len(set(ids)), 6)
        self.assertTrue(all("/ru/item/" in p["text"] for p in peer.messages(CHANNEL)))
        self.assertEqual(app.stop(), 0, app.logs()[-2000:])
        self.assertNotIn('"event":"crawl.succeeded"', app.logs())
        with self.database() as db:
            self.assertEqual(db.execute("SELECT active FROM telegram_users WHERE chat_id=99").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT active FROM telegram_users WHERE chat_id=123").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT count(*) FROM private_delivery_decisions WHERE recipient_id='123' AND status=0").fetchone()[0], 6)
            self.assertEqual(db.execute("SELECT count(*) FROM private_delivery_decisions WHERE recipient_id='42' AND status=0").fetchone()[0], 0)

    def test_deletion_cancels_inflight_private_send(self) -> None:
        in_flight = threading.Event()
        release = threading.Event()
        sent_updates = threading.Event()
        completed = threading.Event()

        def hook(method, payload):
            if method == "sendMessage" and payload.get("chat_id") == 42 and "/ru/item/" in payload.get("text", "") and not in_flight.is_set():
                in_flight.set()
                release.wait(20)
            if method == "sendMessage" and payload.get("text") == "Ваши данные удалены.":
                completed.set()
            if method == "getUpdates" and in_flight.is_set() and not sent_updates.is_set():
                sent_updates.set()
                chat = {"id": 42, "type": "private"}
                sender = {"id": 42}
                return 200, {"ok": True, "result": [
                    {"update_id": 1, "message": {"chat": chat, "from": sender, "text": "/delete_my_data"}},
                    {"update_id": 2, "callback_query": {"id": "delete", "from": sender,
                                                      "data": "d:confirm", "message": {"message_id": 9, "chat": chat}}},
                ]}
            return None

        peer = self.peer(hook)
        app = self.app(peer, [42])
        try:
            wait_for("private send in flight", in_flight.is_set)
            wait_for("deletion completion", completed.is_set, 5)
        finally:
            release.set()
        self.assertEqual(app.stop(), 0, app.logs()[-2000:])
        with self.database() as db:
            for table, key in (("telegram_users", "chat_id"), ("private_recipients", "recipient_id"),
                               ("private_delivery_decisions", "recipient_id")):
                self.assertEqual(db.execute(f"SELECT count(*) FROM {table} WHERE {key}=?", ("42",)).fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT update_offset FROM telegram_state").fetchone()[0], 3)

    def test_kill_after_peer_acceptance_replays_unacknowledged_send(self) -> None:
        accepted = threading.Event()
        release = threading.Event()
        item: list[str] = []

        def first_hook(method, payload):
            if method == "sendMessage" and "/ru/item/" in payload.get("text", "") and not accepted.is_set():
                item.append(re.search(r"/ru/item/(\d+)", payload["text"]).group(1))
                accepted.set()
                release.wait(20)
            return None

        first_peer = self.peer(first_hook)
        first = self.app(first_peer, [42])
        try:
            wait_for("accepted unacknowledged request", accepted.is_set)
            self.assertNotEqual(first.stop(signal.SIGKILL), 0)
        finally:
            release.set()
        with self.database() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM private_delivery_decisions WHERE recipient_id='42' AND status=0").fetchone()[0], 0)
        second_peer = self.peer()
        second = self.app(second_peer, initialize_state=False)
        wait_for("six replayed listings", lambda: sum("/ru/item/" in p.get("text", "") for p in second_peer.messages(42)) == 6, 20)
        replayed = [re.search(r"/ru/item/(\d+)", p["text"]).group(1)
                    for p in second_peer.messages(42) if "/ru/item/" in p.get("text", "")]
        self.assertEqual(replayed[0], item[0])
        self.assertEqual(len(set(replayed)), 6)
        wait_for("six durable acknowledgements", lambda: self._ack_count("42") == 6, 5)
        self.assertEqual(second.stop(), 0, second.logs()[-2000:])

    def _ack_count(self, recipient: str) -> int:
        with self.database() as db:
            return db.execute("SELECT count(*) FROM private_delivery_decisions WHERE recipient_id=? AND status=0", (recipient,)).fetchone()[0]

    def test_startup_sigterm_reaps_http_child_and_releases_lease(self) -> None:
        requested = threading.Event()
        release = threading.Event()

        def hook(method, _payload):
            if method == "getMe":
                requested.set()
                release.wait(20)
            return None

        peer = self.peer(hook)
        app = self.app(peer)
        try:
            wait_for("delayed getMe", requested.is_set, 5)
            children_path = Path(f"/proc/{app.process.pid}/task/{app.process.pid}/children")
            children = children_path.read_text().split()
            self.assertTrue(children, "delayed startup request needs an active HTTP child")
            self.assertTrue((self.directory / ".singleton.sock").exists())
            self.assertEqual(app.stop(), 1, app.logs()[-2000:])
            self.assertFalse((self.directory / ".singleton.sock").exists())
            self.assertTrue(all(not Path(f"/proc/{pid}").exists() for pid in children))
        finally:
            release.set()

    def test_channel_permission_loss_stops_with_private_deferred(self) -> None:
        private = threading.Event()
        failures = 0

        def hook(method, payload):
            nonlocal failures
            if method != "sendMessage":
                return None
            if payload.get("chat_id") == 42:
                private.set()
                return 429, {"ok": False, "error_code": 429, "parameters": {"retry_after": 60}}
            if payload.get("chat_id") == CHANNEL:
                wait_for("private retry", private.is_set, 5)
                failures += 1
                return 403, {"ok": False, "error_code": 403,
                             "description": "Forbidden: not enough rights to send text messages to the chat"}
            return None

        peer = self.peer(hook)
        app = self.app(peer, [42], CHANNEL)
        wait_for("terminal channel permission failure", lambda: app.process.poll() is not None and failures > 0, 15)
        self.assertEqual(app.stop(), 1, app.logs()[-2000:])
        self.assertEqual(failures, 1)
        self.assertEqual(peer.count("sendMessage", 42), 1)
        self.assertNotIn('"event":"crawl.succeeded"', app.logs())
        self.assertFalse((self.directory / ".singleton.sock").exists())

    def test_channel_ack_failure_cancels_inflight_private_send(self) -> None:
        private = threading.Event()
        channel = threading.Event()
        release = threading.Event()

        def hook(method, payload):
            if method != "sendMessage":
                return None
            if payload.get("chat_id") == 42 and "/ru/item/" in payload.get("text", ""):
                private.set()
                release.wait(20)
            if payload.get("chat_id") == CHANNEL:
                wait_for("private send", private.is_set, 5)
                channel.set()
            return None

        trigger = "CREATE TRIGGER fail_channel_ack BEFORE UPDATE OF status ON channel_deliveries WHEN NEW.status='published' BEGIN SELECT RAISE(ABORT,'synthetic channel acknowledgement fault'); END;"
        peer = self.peer(hook)
        app = self.app(peer, [42], CHANNEL, sql=trigger)
        try:
            wait_for("channel accepted", channel.is_set)
            wait_for("channel acknowledgement failure", lambda: app.process.poll() is not None, 5)
            self.assertEqual(app.stop(), 1, app.logs()[-2000:])
        finally:
            release.set()
        self.assertNotIn('"event":"crawl.succeeded"', app.logs())
        with self.database() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM channel_deliveries WHERE status='published'").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT count(*) FROM private_delivery_decisions WHERE status=0").fetchone()[0], 0)
            self.assertGreater(db.execute("SELECT count(*) FROM channel_work").fetchone()[0], 0)
        self.assertFalse((self.directory / ".singleton.sock").exists())
        self.assertFalse(peer.errors, peer.errors)

    def test_source_smoke_cancels_http_child_and_releases_lease(self) -> None:
        requested = threading.Event()
        release = threading.Event()

        def get_hook(_path, _headers):
            requested.set()
            release.wait(10)
            return 200, page("apartment"), {}

        peer = self.peer(get_hook=get_hook)
        data = self.directory / "data"
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "NODE_ENV": "test",
               "TELEGRAM_BOT_TOKEN": "123:synthetic-native-failure", "TELEGRAM_OWNER_ID": "123",
               "DATA_DIRECTORY": str(data), "CURL_IMPERSONATE_PATH": "/usr/bin/curl"}
        process = subprocess.Popen(
            [str(BINARY), "source:smoke", "--source-origin", peer.origin],
            env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        try:
            wait_for("source request", requested.is_set, 5)
            process.send_signal(signal.SIGTERM)
            _stdout, stderr = process.communicate(timeout=5)
            self.assertEqual(process.returncode, 1, stderr)
            self.assertFalse(any(path.name.startswith(".singleton") for path in data.iterdir()))
        finally:
            release.set()
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=3)

    def test_source_transport_keeps_trusted_cookie_and_rejects_challenge_and_redirect(self) -> None:
        mode = ["success"]

        def get_hook(path, _headers):
            if mode[0] == "challenge":
                return 403, "Just a moment /cdn-cgi/challenge-platform/", {"cf-mitigated": "challenge", "set-cookie": "session=poison"}
            if mode[0] == "cross-origin":
                return 302, "", {"location": "https://example.invalid/forbidden"}
            if "/56/" in path:
                return 302, "", {"location": "/apartment-final", "set-cookie": "session=trusted; Path=/"}
            return 200, page("house" if "/1377/" in path else "apartment"), {}

        peer = self.peer(get_hook=get_hook)
        data = self.directory / "data"
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "NODE_ENV": "test",
               "TELEGRAM_BOT_TOKEN": "123:synthetic-native-failure", "TELEGRAM_OWNER_ID": "123",
               "DATA_DIRECTORY": str(data), "CURL_IMPERSONATE_PATH": "/usr/bin/curl"}

        def smoke():
            return subprocess.run([str(BINARY), "source:smoke", "--source-origin", peer.origin],
                                  env=env, text=True, capture_output=True, timeout=12)

        success = smoke()
        self.assertEqual(success.returncode, 0, success.stderr)
        self.assertEqual(len(json.loads(success.stdout)["pages"]), 2)
        self.assertEqual(peer.get_calls[1][1].get("Cookie"), "session=trusted")
        self.assertEqual(peer.get_calls[2][1].get("Cookie"), "session=trusted")
        self.assertGreaterEqual(peer.get_calls[2][2] - peer.get_calls[0][2], 1.9)
        cookie = (data / "list-am-cookies.txt").read_bytes()
        mode[0] = "challenge"
        challenged = smoke()
        self.assertEqual(challenged.returncode, 1)
        self.assertIn("ERR_LIST_AM_CHALLENGE", challenged.stderr)
        self.assertEqual((data / "list-am-cookies.txt").read_bytes(), cookie)
        mode[0] = "cross-origin"
        self.assertIn("crossed origin", smoke().stderr)
        self.assertFalse(any(path.name.startswith((".native-http-", ".source-cookie-")) for path in data.iterdir()))

    def test_startup_rejects_managed_symlink_before_external_requests(self) -> None:
        data = self.directory / "data"
        data.mkdir()
        (data / "apartments.json").symlink_to("/dev/null")
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "NODE_ENV": "test",
               "TELEGRAM_BOT_TOKEN": "123:synthetic-native-failure", "TELEGRAM_OWNER_ID": "123",
               "DATA_DIRECTORY": str(data)}
        result = subprocess.run([str(BINARY), "serve"], env=env, capture_output=True, text=True, timeout=8)
        self.assertEqual(result.returncode, 1)
        self.assertIn("safe regular file", result.stderr)

    def test_preflight_count_drop_preserves_crawl_state(self) -> None:
        def get_hook(path, _headers):
            if path.startswith("/ru/category/56/"):
                return 200, '<div id="contentr">' + page("apartment").split('<div id="contentr">', 1)[1].split('</a>', 1)[0] + '</a></div>', {}
            return None

        peer = self.peer(get_hook=get_hook)
        history = json.dumps({"recentFirstPageCounts": {"apartment": [20, 20, 20]},
                              "lastSuccessfulAt": "2026-09-26T00:00:00.000Z"})
        sql = (
            "INSERT INTO crawl_state(singleton,checked_at,last_crawl_json,source_integrity_json,sequence,total_count) "
            "VALUES(1,'2026-09-26T00:00:00.000Z','{\"initialRun\":true}',"
            + "'" + history + "',1,0);"
        )
        app = self.app(peer, sql=sql)

        def preflight():
            for line in app.logs().splitlines():
                if '"event":"startup.preflight.completed"' in line:
                    return json.loads(line)["preflight"]
            return None

        wait_for("failed source count preflight", lambda: preflight() is not None, 8)
        result = preflight()
        self.assertFalse(result["ready"], app.logs()[-2000:])
        self.assertEqual(result["failure"]["code"], "ERR_LIST_AM_SOURCE_INTEGRITY")
        self.assertEqual(result["failure"]["reason"], "FIRST_PAGE_COUNT_DROP")
        self.assertTrue(any(path.startswith("/ru/category/56/") for path, _, _ in peer.get_calls))
        with self.database() as db:
            stored, total = db.execute("SELECT source_integrity_json,total_count FROM crawl_state").fetchone()
            self.assertEqual(json.loads(stored)["recentFirstPageCounts"]["apartment"], [20, 20, 20])
            self.assertEqual(total, 0)
            self.assertEqual(db.execute("SELECT count(*) FROM apartments").fetchone()[0], 0)
        self.assertEqual(app.stop(), 0, app.logs()[-2000:])

    def _assert_recipient_exit_during_long_retry(self, action: str) -> None:
        retry = threading.Event()
        answered = threading.Event()
        state_lock = threading.Lock()
        apartment_pages = [0]
        later_page = threading.Event()

        def get_hook(path, _headers):
            if path.startswith("/ru/category/56/1"):
                with state_lock:
                    apartment_pages[0] += 1
                    if apartment_pages[0] >= 2 and retry.is_set():
                        later_page.set()
            return None

        def hook(method, payload):
            if method == "getUpdates":
                time.sleep(0.03)
                if retry.is_set() and not answered.is_set():
                    answered.set()
                    chat = {"id": 42, "type": "private"}
                    sender = {"id": 42}
                    updates = (
                        [{"update_id": 1, "message": {"chat": chat, "from": sender, "text": "/stop"}}]
                        if action == "stop" else [
                            {"update_id": 1, "message": {"chat": chat, "from": sender,
                                "text": "/delete_my_data"}},
                            {"update_id": 2, "callback_query": {"id": "delete", "from": sender,
                                "data": "d:confirm", "message": {"message_id": 9, "chat": chat}}},
                        ]
                    )
                    return 200, {"ok": True, "result": updates}
            if method == "sendMessage" and payload.get("chat_id") == 42 and not retry.is_set():
                retry.set()
                return 429, {"ok": False, "error_code": 429,
                             "description": "Too Many Requests", "parameters": {"retry_after": 60}}
            return None

        peer = self.peer(hook=hook, get_hook=get_hook)
        initialize(self.directory, [42, 123])
        with self.database() as db:
            apartment_only = json.dumps({"kinds": ["apartment"],
                                         "price": {"min": None, "max": None},
                                         "rooms": {"min": None, "max": None}, "locations": []})
            db.execute("UPDATE telegram_users SET filters_json=?", (apartment_only,))
        app = self.app(peer, initialize_state=False)
        started = time.monotonic()
        try:
            wait_for(f"{action} during retry and later crawl", lambda: retry.is_set() and answered.is_set()
                     and later_page.is_set(), 14)
        except AssertionError as error:
            raise AssertionError(
                f"{error}; retry={retry.is_set()} answered={answered.is_set()} "
                f"pages={apartment_pages[0]} source={[(p, round(t-started, 2)) for p, _, t in peer.get_calls]} "
                f"crawlEvents={[line for line in app.logs().splitlines() if 'crawl.succeeded' in line][-3:]} "
                f"calls={peer.calls[-12:]} logs={app.logs()[-2000:]}"
            ) from error
        self.assertLess(time.monotonic() - started, 14)
        self.assertIsNone(app.process.poll(), app.logs()[-2000:])
        self.assertEqual(app.stop(), 0, app.logs()[-2000:])
        messages_42 = peer.messages(42)
        self.assertEqual(len(messages_42), 3 if action == "delete" else 2)
        self.assertTrue(all("/ru/item/" not in item.get("text", "") for item in messages_42))
        self.assertTrue(any("/ru/item/" in item.get("text", "") for item in peer.messages(123)))
        with self.database() as db:
            row = db.execute("SELECT active FROM telegram_users WHERE chat_id=42").fetchone()
            if action == "delete":
                self.assertIsNone(row)
            else:
                self.assertEqual(row[0], 0)
            self.assertEqual(db.execute("SELECT count(*) FROM private_delivery_decisions "
                                        "WHERE recipient_id='42' AND status=0").fetchone()[0], 0)
            self.assertGreater(db.execute("SELECT count(*) FROM private_delivery_decisions "
                                          "WHERE recipient_id='123' AND status=0").fetchone()[0], 0)
        self.assertFalse(peer.errors, peer.errors)

    def test_delete_during_long_retry_does_not_block_crawl_or_other_recipient(self) -> None:
        self._assert_recipient_exit_during_long_retry("delete")

    def test_stop_during_long_retry_does_not_block_crawl_or_other_recipient(self) -> None:
        self._assert_recipient_exit_during_long_retry("stop")


if __name__ == "__main__":
    unittest.main()

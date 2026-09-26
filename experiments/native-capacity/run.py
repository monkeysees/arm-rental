#!/usr/bin/env python3
"""Node-free 500-recipient acceptance for the packaged Rust production service."""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "native-acceptance"))
from common import APP_PATH, DATA_PATH, Harness, command  # noqa: E402


ROOT = Path(__file__).resolve().parent
CONTRACT = ROOT / "contract.json"
EXPECTED = ROOT / "expected.json"
CAPACITY_EXPECTED = json.loads(EXPECTED.read_text())
STAMP_MS = 1789466400000  # 2026-09-15T10:00:00.000Z
STAMP = "2026-09-15T10:00:00.000Z"
GROUPS = 4
MONTHS = ("Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь")
WEEKDAYS = ("Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье")
RUN_STAMP = datetime.now(timezone.utc).replace(second=0, microsecond=0)
PHASE_IDS = {
    "seed": list(range(100000, 105442)),
    "unchanged": list(range(100000, 100040)),
    "updated": list(range(100000, 100040)),
    "fresh": list(range(200000, 200008)),
    "catchup-store": list(range(300000, 300040)),
    "catchup": list(range(300000, 300040)),
    "interrupted": list(range(400000, 400032)),
    "resumed": list(range(400000, 400032)),
    "drained": list(range(400000, 400032)),
    "returning": list(range(150000, 150004)),
    "boundary": list(range(500000, 500008)),
}


def frozen_inputs() -> tuple[dict, dict, dict]:
    hashes = {name: sha256((ROOT / name).read_bytes()).hexdigest() for name in ("contract.json", "expected.json")}
    return json.loads(CONTRACT.read_text()), json.loads(EXPECTED.read_text()), hashes


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def source_stamp(when: datetime | None = None) -> str:
    when = when or RUN_STAMP
    return f"{WEEKDAYS[when.weekday()]}, {MONTHS[when.month - 1]} {when.day}, {when.year}, {when.hour:02}:{when.minute:02}"


def expected_ids(name: str, group: int, contract: dict) -> list[str]:
    if name == "boundary":
        return [CAPACITY_EXPECTED["activityBoundary"]["recentIdsByProfile"][group]]
    return contract["expected"][name][group]


def source_page(name: str, kind: str, contract: dict) -> str:
    ids = PHASE_IDS[name]
    ids = sorted(set(ids + PHASE_IDS["seed"][: max(0, 40 - len(ids))]), reverse=True)
    cards = []
    for item in ids:
        if (item % 2 == 1) != (kind == "house"):
            continue
        profile = contract["profiles"][item % GROUPS]
        title = f"Replay rental {item}{' updated' if name not in ('seed', 'unchanged', 'boundary') and item < 100008 else ''}"
        if name == "boundary" and item >= 500000:
            minutes = CAPACITY_EXPECTED["activityBoundary"][
                "recentMinutesAgo" if item < 500004 else "expiredMinutesAgo"
            ]
            offset = timedelta(minutes=minutes)
            date = source_stamp(datetime.now(timezone.utc) - offset)
        else:
            date = "Вторник, Сентябрь 15, 2026, 10:00" if item < 200000 else source_stamp()
        cards.append(
            f'<a class="category-data-list-card__destination" href="/ru/item/{item}">'
            f'<div class="dltitle">{title}</div><div class="p">{profile["originalAmount"]} {profile["currency"]}</div>'
            '<div class="l">Арабкир</div><div class="at">2 ком. · 60 кв.м. · 3/9 этаж</div>'
            f'<div class="d">{date}</div></a>'
        )
    return '<div id="contentr">' + "".join(cards) + "</div>"


def expected_message(item_id: str, contract: dict) -> str:
    item = int(item_id)
    profile = contract["profiles"][item % GROUPS]
    amount = f"{profile['originalAmount']:,}".replace(",", "\u00a0")
    currency = "$" if profile["currency"] == "USD" else "֏"
    title = f"Replay rental {item}{' updated' if item < 100008 else ''}"
    return (
        f"{title}\nЦена: {amount} {currency}\nМестоположение: Арабкир\n"
        f"Количество комнат: 2\nПлощадь: 60 м²\nЭтаж: 3/9\n"
        f"https://www.list.am/ru/item/{item}"
    )


class Phase:
    def __init__(self, name: str, users: int):
        self.name = name
        self.sent = [[] for _ in range(users)]
        self.first: list[float | None] = [None] * users
        self.announced: set[int] = set()
        self.retry_users: set[int] = set()
        self.attempts = self.retries = self.active = self.peak_active = 0
        self.started = self.source_completed = self.completed = None
        self.classification_wall_ms = 0.0
        self.classified_recipients = 0
        self.events: list[dict] = []
        self.error: str | None = None
        self.next_slot = 0.0
        self.token_times: list[list[float]] = [[] for _ in range(users)]
        self.bucket_min_headroom_ms: float | None = None
        self.error_event = threading.Event()
        self.lock = threading.Lock()


class Peer:
    def __init__(self, contract: dict, users: int):
        self.contract = contract
        self.users = users
        self.phase: Phase | None = None
        self.server: ThreadingHTTPServer | None = None
        self.thread: threading.Thread | None = None

    def __enter__(self):
        peer = self

        class Handler(BaseHTTPRequestHandler):

            def log_message(self, *_):
                return

            def reply(self, status: int, body: str, content_type: str):
                data = body.encode()
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                try:
                    self.wfile.write(data)
                except BrokenPipeError:
                    pass  # The app can close an in-flight poll during shutdown.

            def do_GET(self):
                if not self.path.startswith("/ru/category/"):
                    self.reply(404, "missing synthetic page", "text/plain")
                    return
                name = peer.phase.name if peer.phase else "seed"
                path = urlsplit(self.path).path
                if path.rsplit("/", 1)[-1] != "1":
                    body = '<div id="contentr"></div>'
                else:
                    body = source_page(name, "house" if "/1377/" in path else "apartment", peer.contract)
                self.reply(200, body, "text/html")

            def do_POST(self):
                if self.path == "/cba":
                    today = datetime.now(timezone.utc).date().isoformat()
                    rows = "".join(f"<ExchangeRate><ISO>{iso}</ISO><Amount>1</Amount><Rate>400</Rate></ExchangeRate>" for iso in ("USD", "EUR", "RUB"))
                    self.reply(200, f"<ExchangeRatesLatestResult><CurrentDate>{today}</CurrentDate>{rows}</ExchangeRatesLatestResult>", "text/xml")
                    return
                raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                payload = json.loads(raw or b"{}")
                method = self.path.rsplit("/", 1)[-1]
                if method == "getUpdates":
                    time.sleep(0.1)
                    result = []
                elif method == "getMe":
                    result = {"id": 999, "is_bot": True}
                elif method == "sendMessage":
                    status, body = peer.delivery(payload)
                    self.reply(status, json.dumps(body), "application/json")
                    return
                else:
                    result = True
                self.reply(200, json.dumps({"ok": True, "result": result}), "application/json")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return self

    @property
    def origin(self) -> str:
        assert self.server
        return f"http://127.0.0.1:{self.server.server_port}"

    def __exit__(self, *_):
        assert self.server and self.thread
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def delivery(self, payload: dict) -> tuple[int, dict]:
        phase = self.phase
        assert phase is not None, "delivery outside phase"
        user = int(payload["chat_id"]) - 1
        assert 0 <= user < self.users
        match = re.search(r"https://www\.list\.am/ru/item/(\d+)", payload["text"])
        item_id = match.group(1) if match else None
        with phase.lock:
            now = time.monotonic()
            phase.next_slot = max(phase.next_slot, now) + 1 / self.contract["transport"]["globalAttemptsPerSecond"]
            slot = phase.next_slot
            phase.attempts += 1
            phase.active += 1
            phase.peak_active = max(phase.peak_active, phase.active)
            attempt = phase.attempts
        try:
            time.sleep(max(0, slot - time.monotonic()))
            with phase.lock:
                if phase.name == "catchup":
                    retry = item_id is not None and user in phase.retry_users and not phase.sent[user]
                    if not retry:
                        times = phase.token_times[user]
                        times.append(time.monotonic())
                        for index, previous in enumerate(times):
                            required = (
                                max(0, len(times) - index - self.contract["transport"]["recipientBurst"])
                                * 60000 / self.contract["transport"]["recipientMessagesPerMinute"]
                            )
                            headroom = (times[-1] - previous) * 1000 - required
                            if required:
                                phase.bucket_min_headroom_ms = (
                                    headroom if phase.bucket_min_headroom_ms is None
                                    else min(phase.bucket_min_headroom_ms, headroom)
                                )
                            allowance = self.contract["transport"]["recipientBurst"] + math.floor(
                                ((times[-1] - previous) * 1000 + 100) * self.contract["transport"]["recipientMessagesPerMinute"] / 60000
                            )
                            assert len(times) - index <= allowance, (
                                f"recipient {user + 1} exceeded 20/minute bucket: "
                                f"offsetsMs={[round((t - times[0]) * 1000, 3) for t in times]} "
                                f"headroomMs={headroom:.3f}"
                            )
                if item_id and phase.name == "catchup" and user % 10 == 0 and user not in phase.retry_users:
                    phase.retry_users.add(user)
                    phase.retries += 1
                    return 429, {"ok": False, "error_code": 429, "parameters": {"retry_after": 1}}
                if item_id and phase.name == "interrupted" and len(phase.sent[user]) == 2:
                    return 500, {"ok": False, "error_code": 500, "description": "Injected acceptance interruption"}
                if item_id:
                    expected = expected_ids(phase.name, user % GROUPS, self.contract)
                    assert item_id == expected[len(phase.sent[user])], (
                        f"{phase.name} recipient {user + 1} order: got {item_id}, "
                        f"expected {expected[len(phase.sent[user])]}"
                    )
                    assert payload["text"] == expected_message(item_id, self.contract), f"{phase.name} item {item_id} text"
                    if phase.first[user] is None:
                        phase.first[user] = time.monotonic()
                    phase.sent[user].append(item_id)
                else:
                    assert phase.name in ("catchup", "resumed"), "unexpected announcement"
                    assert ("8" if phase.name == "catchup" else "6") in payload["text"]
                    assert user not in phase.announced
                    phase.announced.add(user)
                return 200, {"ok": True, "result": {"message_id": attempt + 1000}}
        except Exception as error:
            phase.error = repr(error)
            phase.error_event.set()
            print(f"{phase.name} peer assertion: {phase.error}", file=sys.stderr, flush=True)
            return 500, {"ok": False, "error_code": 500, "description": "peer assertion failed"}
        finally:
            with phase.lock:
                phase.active -= 1


def connect(harness: Harness, volume: str):
    """Use only while the image is stopped and host_access owns the volume."""
    return sqlite3.connect(str(Path(volume) / "state.sqlite3"))


def historical_digest(db: sqlite3.Connection) -> dict:
    digest = sha256()
    count = 0
    rows = db.execute(
        "SELECT recipient_id,item_id,status,decided_at FROM private_delivery_decisions "
        "WHERE item_id >= '100008' AND item_id < '200000' ORDER BY recipient_id,item_id"
    )
    for row in rows:
        digest.update((json.dumps(list(row), ensure_ascii=False, separators=(",", ":")) + "\n").encode())
        count += 1
    return {"count": count, "sha256": digest.hexdigest()}


def run_contract_crawl(harness: Harness, volume: str, origin: str, env: dict[str, str]) -> dict:
    request = {
        "op": "crawl", "directory": DATA_PATH, "endpoint": origin,
        "env": env, "nowMs": 1789560000000,
        "rates": {
            "fetchedAt": "2026-09-16T10:00:00.000Z", "effectiveDate": "2026-09-15",
            "rates": {"USD": {"amount": 1, "rate": 400}},
        },
    }
    args = [
        "docker", "run", "--rm", "--interactive",
        *harness._runtime_args(data_volume=volume, backup_volume=None, env=env, network="host"),
        harness.image_id, "contract",
    ]
    result = subprocess.run(args, input=json.dumps(request) + "\n", text=True, capture_output=True, timeout=180, check=False)
    assert result.returncode == 0, f"seed crawl failed: {result.stderr}\n{result.stdout}"
    value = json.loads(result.stdout)
    assert "error" not in value, value
    return value


def seed(harness: Harness, volume: str, peer: Peer, contract: dict, users: int, expected: dict, env: dict[str, str]) -> dict:
    harness.run_app(["state:init"], data_volume=volume, env=env)
    seed_crawl = run_contract_crawl(harness, volume, peer.origin, env)
    assert seed_crawl["totalCount"] == contract["seed"]["listingCount"], seed_crawl
    start = time.monotonic()
    with harness.host_access(volume):
        db = connect(harness, volume)
        try:
            assert db.execute("SELECT count(*) FROM apartments").fetchone()[0] == 5442
            db.execute("BEGIN")
            for user in range(users):
                group = user % GROUPS
                recipient = str(user + 1)
                profile = contract["profiles"][group]
                filters = {
                    "kinds": ["apartment", "house"],
                    "price": {"min": profile["price"], "max": profile["price"]},
                    "rooms": {"min": 2 if group == 2 else None, "max": 2 if group == 2 else None},
                    "locations": [],
                }
                db.execute(
                    "INSERT INTO telegram_users(chat_id,active,send_initial_apartments,filters_json,pending_filter_input,deletion_pending_at) "
                    "VALUES(?,1,1,?,NULL,NULL)",
                    (user + 1, json.dumps(filters, ensure_ascii=False, separators=(",", ":"))),
                )
                db.execute("INSERT INTO private_recipients(recipient_id,initial_selection_applied) VALUES(?,1)", (recipient,))
                batch = (
                    (recipient, str(item), 0 if item % GROUPS == group else 2, STAMP_MS)
                    for item in (*PHASE_IDS["seed"], *range(150000, 151121))
                )
                db.executemany(
                    "INSERT INTO private_delivery_decisions(recipient_id,item_id,status,decided_at) VALUES(?,?,?,?)",
                    batch,
                )
            db.commit()
            count = db.execute("SELECT count(*) FROM private_delivery_decisions").fetchone()[0]
            assert count == users * contract["seed"]["decisionsPerRecipient"]
            if users == 500:
                assert count == expected["seedDecisionCount"]
            prior = historical_digest(db)
            if users == 500:
                assert prior == expected["historicalDecisions"], prior
            database_bytes = (Path(volume) / "state.sqlite3").stat().st_size
        finally:
            db.close()
    return {"decisions": count, "historicalDigest": prior, "databaseBytes": database_bytes, "wallMs": (time.monotonic() - start) * 1000}


def clone_seed_volume(harness: Harness, source: str) -> str:
    destination = harness.new_volume()
    with harness.host_access(source), harness.host_access(destination):
        source_root, dest_root = Path(source), Path(destination)
        with sqlite3.connect(source_root / "state.sqlite3") as prior, sqlite3.connect(dest_root / "state.sqlite3") as copy:
            prior.backup(copy)
        (dest_root / "state.sqlite3").chmod(0o600)
        shutil.copy2(source_root / "list-am-cookies.txt", dest_root / "list-am-cookies.txt")
    return destination


def verify_database(harness: Harness, volume: str, phase: Phase, contract: dict, users: int) -> None:
    name = phase.name
    with harness.host_access(volume):
        db = connect(harness, volume)
        try:
            ids = PHASE_IDS[name]
            for user in range(users):
                expected = expected_ids(name, user % GROUPS, contract)
                assert phase.sent[user] == expected, f"{name} recipient {user + 1} complete output"
                statuses = {
                    item: status for item, status in db.execute(
                        f"SELECT item_id,status FROM private_delivery_decisions WHERE recipient_id=? "
                        f"AND item_id IN ({','.join('?' for _ in ids)})",
                        (str(user + 1), *(str(item) for item in ids)),
                    )
                }
                for item in expected:
                    assert statuses.get(item) == 0, f"{name} missing durable acknowledgement {user + 1}:{item}"
                for item in ids:
                    if item % GROUPS != user % GROUPS:
                        assert statuses.get(str(item)) == 2, f"{name} missing filtered decision {user + 1}:{item}"
                if name == "catchup":
                    for item in contract["expected"]["skippedCatchup"][user % GROUPS]:
                        assert statuses.get(item) == 1, f"catchup missing skipped decision {user + 1}:{item}"
                if name == "boundary":
                    expired = CAPACITY_EXPECTED["activityBoundary"]["expiredIdsByProfile"][user % GROUPS]
                    assert statuses.get(expired) != 0, f"expired boundary item delivered to {user + 1}"
            if name == "interrupted":
                assert db.execute("SELECT count(*) FROM private_delivery_work").fetchone()[0] > 0, "interruption lost pending work"
        finally:
            db.close()


def request_selection(harness: Harness, volume: str, users: int) -> None:
    with harness.host_access(volume):
        db = connect(harness, volume)
        try:
            db.execute("UPDATE private_recipients SET initial_selection_applied=0 WHERE recipient_id IN (SELECT CAST(chat_id AS TEXT) FROM telegram_users)")
            assert db.total_changes == users
            db.commit()
        finally:
            db.close()


def verify_interrupted_prefix(harness: Harness, volume: str, contract: dict, users: int) -> None:
    with harness.host_access(volume):
        db = connect(harness, volume)
        try:
            for user in range(users):
                statuses = dict(db.execute(
                    "SELECT item_id,status FROM private_delivery_decisions WHERE recipient_id=? AND item_id BETWEEN '400000' AND '400031'",
                    (str(user + 1),),
                ))
                for item in contract["expected"]["interrupted"][user % GROUPS]:
                    assert statuses.get(item) == 0, f"missing acknowledged prefix {user + 1}:{item}"
                for item in contract["expected"]["resumed"][user % GROUPS]:
                    assert statuses.get(item) != 0, f"replayed suffix already acknowledged {user + 1}:{item}"
        finally:
            db.close()


def boundary_dates(db: sqlite3.Connection) -> dict[str, float]:
    observed = {}
    now = datetime.now(timezone.utc)
    rows = db.execute("SELECT item_id,payload_json FROM apartments WHERE item_id BETWEEN '500000' AND '500007' ORDER BY item_id")
    for item_id, raw in rows:
        payload = json.loads(raw)
        assert payload.get("updatedAt") is None, f"boundary card {item_id} was renewed"
        match = re.fullmatch(r"[^,]+, ([^ ]+) (\d+), (\d+), (\d+):(\d+)", payload["date"])
        assert match, f"unparsed boundary date for {item_id}: {payload['date']}"
        month, day, year, hour, minute = match.groups()
        posted = datetime(int(year), MONTHS.index(month) + 1, int(day), int(hour), int(minute), tzinfo=timezone.utc)
        age_minutes = (now - posted).total_seconds() / 60
        recent = item_id in CAPACITY_EXPECTED["activityBoundary"]["recentIdsByProfile"]
        assert (age_minutes < 1440) if recent else (age_minutes > 1440), f"boundary item {item_id} did not bracket 24 hours"
        observed[item_id] = age_minutes
    assert len(observed) == 8, f"boundary source cards were not stored: {len(observed)}"
    return observed


def run_phase(harness: Harness, volume: str, peer: Peer, contract: dict, env: dict[str, str], name: str, users: int, output: Path) -> dict:
    phase = Phase(name, users)
    peer.phase = phase
    port_probe = __import__("socket").socket()
    port_probe.bind(("127.0.0.1", 0))
    health_port = port_probe.getsockname()[1]
    port_probe.close()
    app_env = {**env, "HEALTH_PORT": str(health_port)}
    container = harness.start_app(
        ["serve", "--telegram-endpoint", f"{peer.origin}/telegram", "--source-origin", peer.origin, "--cba-endpoint", f"{peer.origin}/cba"],
        data_volume=volume, env=app_env, network="host",
    )
    logs = subprocess.Popen(["docker", "logs", "--follow", container], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    complete = threading.Event()
    lines: list[str] = []

    def read_logs() -> None:
        assert logs.stdout
        for line in logs.stdout:
            lines.append(line)
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            now = time.monotonic()
            phase.events.append(event)
            name_of_event = event.get("event")
            if name_of_event == "crawl.started" and phase.started is None:
                phase.started = now
            elif name_of_event == "source.integrity.checked" and phase.started is not None:
                phase.source_completed = now
            elif name_of_event == "private.classification.completed":
                phase.classified_recipients = event.get("recipients", event.get("classifiedRecipients", phase.classified_recipients + 1))
                phase.classification_wall_ms = (now - (phase.started or now)) * 1000
            elif name_of_event == "crawl.succeeded" or (name == "interrupted" and name_of_event == "runtime.failed"):
                phase.completed = now
                complete.set()

    thread = threading.Thread(target=read_logs, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 180
        while not complete.is_set() and not phase.error_event.is_set() and time.monotonic() < deadline:
            complete.wait(0.25)
        assert not phase.error_event.is_set(), f"{name}: {phase.error}"
        assert complete.is_set(), f"{name}: no terminal crawl event; {''.join(lines[-8:])}"
        if name == "interrupted":
            command(["docker", "kill", "--signal", "KILL", container])
        else:
            stopped = harness.stop_app(container)
            assert stopped.returncode == 0, f"{name}: stop failed: {stopped.stderr}"
        info = harness.inspect(container)
        assert info["State"]["ExitCode"] == (137 if name == "interrupted" else 0), (name, info["State"])
        thread.join(timeout=5)
        assert phase.error is None, f"{name}: peer failed: {phase.error}"
        assert phase.started is not None and phase.completed is not None, f"{name}: missing timing events"
        assert phase.source_completed is not None, f"{name}: missing source completion"
        assert phase.peak_active <= 8, f"{name}: {phase.peak_active} simultaneous delivery attempts"
        assert phase.active == 0, f"{name}: unfinished peer requests"
        verify_database(harness, volume, phase, contract, users)
        first = [(value - phase.started) * 1000 for value in phase.first if value is not None]
        summary = {
            "name": name,
            "wallMs": (phase.completed - phase.started) * 1000,
            "sourceWallMs": (phase.source_completed - phase.started) * 1000,
            "deliveryWallMs": (phase.completed - phase.source_completed) * 1000,
            "classificationWallMs": phase.classification_wall_ms,
            "classifiedRecipients": phase.classified_recipients,
            "attempts": phase.attempts,
            "peakActive": phase.peak_active,
            "retries": phase.retries,
            "announcements": len(phase.announced),
            "sent": sum(map(len, phase.sent)),
            "recipientsWithProgress": len(first),
            "firstRecipientProgressMs": {"max": max(first, default=0)},
            "deliveriesByProfile": phase.sent[:GROUPS],
            "recipientsAsserted": users,
            "exitCode": info["State"]["ExitCode"],
            "events": phase.events,
        }
        if name == "catchup":
            summary["recipientRate"] = {
                "limitPerMinute": contract["transport"]["recipientMessagesPerMinute"],
                "burst": contract["transport"]["recipientBurst"],
                "minObservedBucketHeadroomMs": phase.bucket_min_headroom_ms,
                "firstProfilesAttemptOffsetsMs": [
                    [round((t - times[0]) * 1000, 3) for t in times] for times in phase.token_times[:GROUPS]
                ],
            }
        (output / f"{name}.json").write_text(json.dumps(summary, indent=2) + "\n")
        print(f"{name}: {summary['sent']} listings, {summary['wallMs']:.0f} ms", flush=True)
        return summary
    finally:
        if harness.inspect(container)["State"]["Running"]:
            command(["docker", "kill", container], check=False)
        logs.terminate()
        try:
            logs.wait(timeout=5)
        except subprocess.TimeoutExpired:
            logs.kill()
        (output / f"{name}.log").write_text("".join(lines))
        command(["docker", "rm", "--force", container], check=False)


def capacity(phases: list[dict], users: int, contract: dict, *, separate_source: bool) -> dict:
    catchup = next(p for p in phases if p["name"] == "catchup")
    routine = [p for p in phases if p["name"] in ("updated", "fresh")]
    source = catchup["sourceWallMs"] if separate_source else 0
    ideal = max(
        catchup["attempts"] * 1000 / contract["transport"]["globalAttemptsPerSecond"],
        (contract["initialDeliveryLimit"] + 1 - contract["transport"]["recipientBurst"])
        * 60000 / contract["transport"]["recipientMessagesPerMinute"],
    )
    tolerance = contract["measurement"]["capacityDrainTolerance"]
    fair_deadline = (
        catchup["classificationWallMs"] - source
        + 2 * users * 1000 / contract["transport"]["globalAttemptsPerSecond"]
        + contract["transport"]["retryAfterMs"] + contract["transport"]["latencyMs"]
    )
    return {
        "routineWithinCrawlInterval": sum(p["wallMs"] for p in routine) <= contract["crawlIntervalMs"],
        "classificationWithinCrawlInterval": all(p["classifiedRecipients"] == users for p in routine)
        and sum(p["classificationWallMs"] for p in routine) <= contract["crawlIntervalMs"],
        "catchupIdealDrainMs": ideal,
        "catchupWithinPermittedRateTarget": catchup["wallMs"] - source <= ideal * tolerance,
        "tolerance": tolerance,
        "allRecipientsProgressed": catchup["recipientsWithProgress"] == users,
        "fairProgressDeadlineMs": fair_deadline,
        "fairProgress": catchup["firstRecipientProgressMs"]["max"] - source <= fair_deadline * tolerance,
        "withinApplicationMemoryLimit": None,
    }


def ci_summary(report: dict, report_path: Path) -> dict:
    """Keep the evidence needed to review a hosted run after its files expire."""
    boundary = report.get("activityBoundary")
    ages = boundary.get("observedPostingAgeMinutes", {}) if boundary else {}
    recent = CAPACITY_EXPECTED["activityBoundary"]["recentIdsByProfile"]
    expired = CAPACITY_EXPECTED["activityBoundary"]["expiredIdsByProfile"]
    summary = {
        "status": report["status"],
        "error": report.get("error"),
        "users": report["users"],
        "diagnostic": report["diagnostic"],
        "imageId": report.get("imageId"),
        "sourceRevision": report.get("sourceRevision"),
        "sourceDirty": report.get("sourceDirty"),
        "binarySha256": report.get("binarySha256"),
        "sourceInputSha256": report.get("sourceInputSha256"),
        "fixtureSha256": report["fixtureSha256"],
        "historicalBefore": report.get("seed", {}).get("historicalDigest"),
        "historicalAfter": report.get("retainedAfter"),
        "phases": [
            {
                key: phase[key] for key in
                ("name", "sent", "attempts", "retries", "announcements", "peakActive", "wallMs", "sourceWallMs", "deliveryWallMs")
                if key in phase
            }
            for phase in report["phases"]
        ],
        "capacity": report.get("capacityOracle"),
        "fullWallCapacity": report.get("fullWallCapacityOracle"),
        "activityBoundary": None if boundary is None else {
            "sent": boundary["sent"],
            "attempts": boundary["attempts"],
            "recentPostingAgeMinutes": {item: ages[item] for item in recent if item in ages},
            "expiredPostingAgeMinutes": {item: ages[item] for item in expired if item in ages},
            "historicalDigest": boundary.get("historicalDigest"),
        },
        "reportPath": str(report_path),
    }
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--users", type=int, choices=(4, 500), default=500)
    parser.add_argument("--expected-revision")
    parser.add_argument("--require-clean-source", action="store_true")
    args = parser.parse_args()
    if not args.output.is_absolute() or args.output.exists():
        parser.error("--output must be a new absolute directory")
    contract, expected, fixture_hashes = frozen_inputs()
    assert contract["populations"] == [500] and contract["version"] == 1
    assert contract["measurement"]["capacityDrainTolerance"] == 1.1
    assert contract["transport"]["globalAttemptsPerSecond"] == 200
    assert contract["transport"]["recipientMessagesPerMinute"] == 20
    assert contract["transport"]["recipientBurst"] == 5
    assert contract["transport"]["retryAfterMs"] == 1000
    assert expected == CAPACITY_EXPECTED
    assert expected["activityBoundary"]["recentMinutesAgo"] < 1440 < expected["activityBoundary"]["expiredMinutesAgo"]
    args.output.mkdir(mode=0o700)
    report = {"type": "rust-production-native-capacity", "version": 1, "status": "running", "users": args.users,
              "diagnostic": args.users != 500, "startedAt": iso_now(), "fixtureSha256": fixture_hashes, "phases": [],
              "resourceBoundary": "Complete packaged Rust service and local peers; no 1-CPU/512-MiB cgroup or whole-machine memory-fit claim"}
    try:
        with Harness(args.image, args.output) as harness, Peer(contract, args.users) as peer:
            report.update({"imageId": harness.image_id, "binarySha256": harness.binary_sha256,
                           "sourceRevision": harness.source_revision, "sourceDirty": harness.source_dirty,
                           "sourceInputSha256": harness.source_input_sha256, "cargoLockSha256": harness.cargo_lock_sha256})
            if args.expected_revision:
                assert harness.source_revision == args.expected_revision, "image revision differs from accepted source"
            if args.require_clean_source:
                assert harness.source_dirty == "false", "image does not claim clean source"
            volume = harness.new_volume()
            env = {
                "NODE_ENV": "test", "DATA_DIRECTORY": DATA_PATH,
                "TELEGRAM_BOT_TOKEN": "123:synthetic-native-capacity", "TELEGRAM_OWNER_ID": "1",
                "CURL_IMPERSONATE_PATH": "/usr/local/bin/curl-impersonate",
                "INITIAL_PAGE_COUNT": "1", "INITIAL_DELIVERY_LIMIT": "8", "POLL_INTERVAL_MS": "60000",
                "TELEGRAM_POLL_TIMEOUT_SECONDS": "1", "TELEGRAM_PRIVATE_DELIVERIES_PER_MINUTE": "20",
                "EXTERNAL_RETRY_BASE_MS": "10", "EXTERNAL_RETRY_MAX_MS": "100",
            }
            report["seed"] = seed(harness, volume, peer, contract, args.users, expected, env)
            boundary_volume = clone_seed_volume(harness, volume)
            for name in ("unchanged", "updated", "fresh"):
                report["phases"].append(run_phase(harness, volume, peer, contract, env, name, args.users, args.output))
            peer.phase = Phase("catchup-store", args.users)
            stored = run_contract_crawl(harness, volume, peer.origin, env)
            assert stored["totalCount"] >= 5482, stored
            request_selection(harness, volume, args.users)
            report["phases"].append(run_phase(harness, volume, peer, contract, env, "catchup", args.users, args.output))
            report["phases"].append(run_phase(harness, volume, peer, contract, env, "interrupted", args.users, args.output))
            verify_interrupted_prefix(harness, volume, contract, args.users)
            for name in ("resumed", "drained", "returning"):
                report["phases"].append(run_phase(harness, volume, peer, contract, env, name, args.users, args.output))
            report["activityBoundary"] = run_phase(harness, boundary_volume, peer, contract, env, "boundary", args.users, args.output)
            with harness.host_access(boundary_volume):
                db = connect(harness, boundary_volume)
                try:
                    report["activityBoundary"]["observedPostingAgeMinutes"] = boundary_dates(db)
                    report["activityBoundary"]["historicalDigest"] = historical_digest(db)
                finally:
                    db.close()
            assert report["activityBoundary"]["historicalDigest"] == report["seed"]["historicalDigest"]
            with harness.host_access(volume):
                db = connect(harness, volume)
                try:
                    report["retainedAfter"] = historical_digest(db)
                finally:
                    db.close()
            assert report["retainedAfter"] == report["seed"]["historicalDigest"], "historical decisions changed"
            catchup = next(p for p in report["phases"] if p["name"] == "catchup")
            interrupted = next(p for p in report["phases"] if p["name"] == "interrupted")
            resumed = next(p for p in report["phases"] if p["name"] == "resumed")
            assert catchup["retries"] == (args.users + 9) // 10
            assert catchup["announcements"] == args.users
            assert catchup["attempts"] == catchup["sent"] + catchup["announcements"] + catchup["retries"]
            assert interrupted["sent"] == args.users * 2 and resumed["sent"] == args.users * 6
            if args.users == 500:
                assert catchup["sent"] == expected["catchup"]["listings"]
                assert catchup["attempts"] == expected["catchup"]["attempts"]
                assert catchup["retries"] == expected["catchup"]["retryCount"]
                assert interrupted["sent"] == expected["interruption"]["acknowledgedPrefix"]
                assert resumed["sent"] == expected["interruption"]["pendingSuffix"]
            report["fullWallCapacityOracle"] = capacity(report["phases"], args.users, contract, separate_source=False)
            report["capacityOracle"] = capacity(report["phases"], args.users, contract, separate_source=True)
            report["capacityMeasurement"] = {"routineOrigin": "crawl.started", "catchupOrigin": "last source.integrity.checked",
                                             "tolerance": 1.1, "sourcePacingSeparate": True}
            if args.users == 500:
                assert math.isclose(report["capacityOracle"]["catchupIdealDrainMs"] * 1.1, expected["catchup"]["deliveryLimitMs"], abs_tol=0.001)
                for key in ("routineWithinCrawlInterval", "classificationWithinCrawlInterval", "catchupWithinPermittedRateTarget",
                            "allRecipientsProgressed", "fairProgress"):
                    assert report["capacityOracle"][key], f"capacity contract failed: {key}"
            report["status"] = "passed"
    except Exception as error:
        report["status"] = "failed"
        report["error"] = repr(error)
        raise
    finally:
        fixture_failure = None
        try:
            _, _, after_hashes = frozen_inputs()
            assert after_hashes == fixture_hashes, "frozen inputs changed during acceptance"
        except Exception as error:
            fixture_failure = error
            report["status"] = "failed"
            report["error"] = repr(error)
        report["completedAt"] = iso_now()
        report_path = args.output / "report.json"
        report_path.write_text(json.dumps(report, indent=2) + "\n")
        print("CAPACITY_SUMMARY " + json.dumps(ci_summary(report, report_path), sort_keys=True, separators=(",", ":")), flush=True)
        print(f"Report: {report_path}", flush=True)
        if fixture_failure is not None:
            raise fixture_failure


if __name__ == "__main__":
    main()

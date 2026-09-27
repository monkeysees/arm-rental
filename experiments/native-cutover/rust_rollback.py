#!/usr/bin/env python3
"""Disposable Rust service rollback and recovery on one production-shaped SQLite mount."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
import sqlite3
import sys

ACCEPTANCE = Path(__file__).resolve().parents[1] / "native-acceptance"
sys.path.insert(0, str(ACCEPTANCE))

from common import BACKUP_PATH, Harness  # noqa: E402
from lifecycle import _all_rows, _seed, _state  # noqa: E402
from service import OWNER, Peer, _free_port, _listing_messages, _ready, _wait  # noqa: E402


FIXTURE = ACCEPTANCE / "fixtures" / "schema-v5-populated.sql"


def _options(peer: Peer) -> list[str]:
    return [
        "serve", "--telegram-endpoint", f"{peer.origin}/telegram",
        "--source-origin", peer.origin, "--cba-endpoint", f"{peer.origin}/cba",
    ]


def _env(port: int) -> dict[str, str]:
    return {
        "TELEGRAM_ACCESS_MODE": "owner", "HEALTH_PORT": str(port),
        "INITIAL_PAGE_COUNT": "1", "POLL_INTERVAL_MS": "100",
        "TELEGRAM_POLL_TIMEOUT_SECONDS": "1", "EXTERNAL_RETRY_BASE_MS": "10",
        "EXTERNAL_RETRY_MAX_MS": "100",
    }


def _serve(harness: Harness, data: str, backup: str, *, expect_new: int) -> dict:
    with Peer() as peer:
        peer.retry_listing_once = False
        port = _free_port()
        container = harness.start_app(
            _options(peer), data_volume=data, backup_volume=backup, env=_env(port)
        )
        try:
            _wait("Rust readiness", lambda: _ready(port), detail=lambda: harness.logs(container)[-3000:])
            _wait(
                "Rust source crawl and expected delivery",
                lambda: (
                    '"event":"crawl.succeeded"' in harness.logs(container)
                    and len(_listing_messages(peer.snapshot(), "sendMessage", OWNER, "100000"))
                    == expect_new
                ),
                detail=lambda: (peer.snapshot()[-20:], harness.logs(container)[-3000:]),
            )
            assert '"event":"source.integrity.checked"' in harness.logs(container)
        finally:
            harness.stop_app(container)
        calls = peer.snapshot()
        assert not _listing_messages(calls, "sendMessage", OWNER, "100001"), \
            "previously acknowledged listing was resent"
        sends = len(_listing_messages(calls, "sendMessage", OWNER, "100000"))
        assert sends == expect_new, (sends, expect_new)
        offsets = [int(body.get("offset", 0)) for method, body in calls if method == "getUpdates"]
        assert offsets and min(offsets) >= 42, f"Telegram offset regressed: {offsets}"
        return {"newListingSends": sends, "minimumTelegramOffset": min(offsets)}


def run(image: str, output: Path) -> dict:
    assert output.is_absolute() and not output.exists(), "output must be a new absolute directory"
    output.mkdir(mode=0o700)
    fixture_hash = sha256(FIXTURE.read_bytes()).hexdigest()
    manifest = json.loads((FIXTURE.parent / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["sha256"][FIXTURE.name] == fixture_hash
    with Harness(image, output) as harness:
        data, backup = harness.new_volume(), harness.new_volume()
        _seed(harness, data, FIXTURE)
        today = datetime.now(timezone.utc)
        rates = {iso: {"amount": 1, "rate": 400} for iso in ("USD", "EUR", "RUB")}
        with harness.host_access(data) as root:
            with sqlite3.connect(root / "state.sqlite3") as connection:
                connection.execute(
                    "UPDATE exchange_rate_state SET snapshot_json=? WHERE singleton=1",
                    (json.dumps({
                        "version": 1, "type": "cba-exchange-rates", "baseCurrency": "AMD",
                        "fetchedAt": today.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                        "effectiveDate": today.date().isoformat(), "rates": rates,
                    }),),
                )
        assert _state(harness, data)["currentVersion"] == 5
        harness.run_app(["state:validate"], data_volume=data, backup_volume=backup)
        before = _all_rows(harness, data)
        identity = _state(harness, data)
        assert identity["currentVersion"] == 6 and identity["updateOffset"] == 42
        assert any(row["item_id"] == "100001" and row["status"] == 0
                   for row in before["private_delivery_decisions"])

        created = harness.run_app(["backup:create"], data_volume=data, backup_volume=backup)
        snapshot = json.loads(created.stdout)["snapshot"]
        assert snapshot.startswith(BACKUP_PATH + "/daily/")
        harness.run_app(["backup:validate", "--snapshot", snapshot],
                        data_volume=data, backup_volume=backup)

        with Peer() as peer:
            peer.identity_failure = True
            rejected = harness.start_app(
                _options(peer), data_volume=data, backup_volume=backup, env=_env(_free_port())
            )
            try:
                _wait("rejected Rust exit", lambda: not harness.inspect(rejected)["State"]["Running"],
                      seconds=10, detail=lambda: harness.logs(rejected)[-3000:])
                assert harness.inspect(rejected)["State"]["ExitCode"] != 0
                assert not peer.source_paths(), "rejected service crawled source"
            finally:
                harness.stop_app(rejected)
        assert _all_rows(harness, data) == before
        assert _state(harness, data)["updateOffset"] == 42
        # A failed deployment first tries compatible live-state restart.
        after_rejection = _serve(harness, data, backup, expect_new=1)
        assert _state(harness, data)["databaseId"] == identity["databaseId"]
        assert any(row["itemId"] == "100000" and row["status"] == 0
                   for row in _state(harness, data)["decisions"])
        compatible_restart = _serve(harness, data, backup, expect_new=0)

        # An explicit older snapshot restore demonstrates why it cannot be the
        # default rollback once new Telegram work has been acknowledged.
        harness.run_app(["backup:restore", "--snapshot", snapshot],
                        data_volume=data, backup_volume=backup)
        assert _all_rows(harness, data) == before
        assert _state(harness, data)["updateOffset"] == 42
        older_snapshot_restart = _serve(harness, data, backup, expect_new=1)
        return {
            "type": "disposable-rust-rollback-exercise", "version": 1,
            "imageId": harness.image_id, "sourceRevision": harness.source_revision,
            "binarySha256": harness.binary_sha256, "fixtureSha256": fixture_hash,
            "databaseId": identity["databaseId"], "snapshot": snapshot,
            "recoveryAfterRejectedStartup": after_rejection,
            "compatibleLiveRestart": compatible_restart,
            "olderSnapshotRestart": older_snapshot_restart,
            "checks": [
                "frozen-populated-state-upgraded-and-backed-up-by-rust",
                "validated-independent-predeploy-snapshot",
                "rejected-identity-before-source-and-without-state-mutation",
                "live-state-restart-preserved-old-ack-and-offset",
                "new-rust-delivery-durably-acknowledged-once",
                "compatible-rust-restart-did-not-replay-new-ack",
                "older-snapshot-restore-replayed-post-snapshot-work",
            ],
            "remainingHostOnly": [
                "This single-image exercise does not test the host deployment controller, systemd, registry pointer, or operations lock.",
                "It demonstrates snapshot replay risk; the host requires its own retained-image and rollback receipt checks.",
            ],
        }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if not args.output.is_absolute() or args.output.exists():
        parser.error("--output must name a new absolute directory")
    report = run(args.image, args.output)
    (args.output / "report.json").write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    main()

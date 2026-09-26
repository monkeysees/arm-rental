#!/usr/bin/env python3
"""Disposable Node-to-Rust deployment and rollback exercise.

No registry, production host, or external service is contacted. Both packaged
images use one synthetic SQLite bind mount and an independent backup bind mount.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
import re
import sqlite3
import sys
import uuid

ACCEPTANCE = Path(__file__).resolve().parents[1] / "native-acceptance"
sys.path.insert(0, str(ACCEPTANCE))

from common import BACKUP_PATH, Harness, command  # noqa: E402
from lifecycle import _all_rows, _seed, _state  # noqa: E402
from service import OWNER, Peer, _free_port, _listing_messages, _ready, _wait  # noqa: E402
from node_peer import NodePeerProxy  # noqa: E402


FIXTURE = ACCEPTANCE / "fixtures" / "schema-v5-populated.sql"


def _node(harness: Harness, image_id: str, args: list[str], data: str, backup: str):
    return command(
        [
            "docker", "run", "--rm",
            *harness._runtime_args(
                data_volume=data,
                backup_volume=backup,
                env={"TELEGRAM_ACCESS_MODE": "owner"},
                network="none",
            ),
            image_id, "node", *args,
        ],
        timeout=90,
    )


def _node_event(result, event: str) -> dict:
    matches = [
        row for line in result.stdout.splitlines()
        if (row := json.loads(line)).get("event") == event
    ]
    assert len(matches) == 1, f"expected one Node {event} event"
    return matches[0]


def _native_options(peer: Peer) -> list[str]:
    return [
        "serve",
        "--telegram-endpoint", f"{peer.origin}/telegram",
        "--source-origin", peer.origin,
        "--cba-endpoint", f"{peer.origin}/cba",
    ]


def _native_env(port: int) -> dict[str, str]:
    return {
        "TELEGRAM_ACCESS_MODE": "owner",
        "HEALTH_PORT": str(port),
        "INITIAL_PAGE_COUNT": "1",
        "POLL_INTERVAL_MS": "100",
        "TELEGRAM_POLL_TIMEOUT_SECONDS": "1",
        "EXTERNAL_RETRY_BASE_MS": "10",
        "EXTERNAL_RETRY_MAX_MS": "100",
    }


def _inspect_node(image: str) -> dict:
    inspect = json.loads(command(["docker", "image", "inspect", image]).stdout)[0]
    config = inspect["Config"]
    labels = config["Labels"]
    assert config["User"] in ("node", "1000:1000"), "Node rollback image must run as production UID"
    assert labels["com.rental-apartments.state.backend"] == "sqlite"
    assert int(labels["com.rental-apartments.state.schema.minimum"]) <= 6
    assert int(labels["com.rental-apartments.state.schema.maximum"]) >= 6
    assert labels.get("com.rental-apartments.runtime") in (None, "node")
    revision = labels.get("org.opencontainers.image.revision")
    assert revision and re.fullmatch(r"[0-9a-f]{40}", revision), "Node image lacks source revision"
    digests = [reference for reference in inspect.get("RepoDigests", []) if reference.startswith("ghcr.io/")]
    return {"id": inspect["Id"], "revision": revision, "registryDigest": digests[0] if digests else None}


def _node_service(harness: Harness, node_id: str, data: str, backup: str, output: Path) -> dict:
    with Peer() as peer:
        peer.retry_listing_once = False
        with NodePeerProxy(output / f"node-rollback-{uuid.uuid4().hex[:12]}", peer) as proxy:
            port = _free_port()
            name = f"rental-node-cutover-{uuid.uuid4().hex[:12]}"
            arguments = [
                "docker", "run", "--detach", "--name", name,
                *harness._runtime_args(
                    data_volume=data,
                    backup_volume=backup,
                    env={
                        "TELEGRAM_ACCESS_MODE": "owner",
                        "HEALTH_PORT": str(port),
                        "INITIAL_PAGE_COUNT": "1",
                        "POLL_INTERVAL_MS": "100",
                        "TELEGRAM_POLL_TIMEOUT_SECONDS": "1",
                        "EXTERNAL_RETRY_BASE_MS": "10",
                        "EXTERNAL_RETRY_MAX_MS": "100",
                        "NODE_OPTIONS": "--use-env-proxy",
                        "NODE_EXTRA_CA_CERTS": "/local-cutover-ca.pem",
                        "CURL_CA_BUNDLE": "/local-cutover-ca.pem",
                        "HTTPS_PROXY": proxy.origin,
                        "HTTP_PROXY": proxy.origin,
                        "ALL_PROXY": proxy.origin,
                        "NO_PROXY": "127.0.0.1,localhost",
                    },
                    network="host",
                ),
                "--mount", f"type=bind,src={proxy.ca},dst=/local-cutover-ca.pem,readonly",
                *[part for host in sorted(("api.telegram.org", "api.cba.am", "www.list.am"))
                  for part in ("--add-host", f"{host}:127.0.0.2")],
                node_id,
            ]
            container = command(arguments).stdout.strip()
            harness._containers.append(container)
            try:
                _wait("restored Node readiness", lambda: _ready(port), seconds=25,
                      detail=lambda: command(["docker", "logs", container], check=False).stderr[-4000:])
                _wait(
                    "restored Node source crawl",
                    lambda: '"event":"crawl.succeeded"' in harness.logs(container),
                    seconds=30,
                    detail=lambda: (proxy.paths, harness.logs(container)[-4000:]),
                )
                assert any(host == "api.telegram.org" for host, _ in proxy.paths)
                assert any(host == "www.list.am" for host, _ in proxy.paths)
            finally:
                harness.stop_app(container)
            calls = peer.snapshot()
            assert not _listing_messages(calls, "sendMessage", OWNER, "100001"), "Node resent its acknowledged listing"
            offsets = [int(payload.get("offset", 0)) for method, payload in calls if method == "getUpdates"]
            assert offsets and min(offsets) >= 42, f"Node Telegram offset regressed: {offsets}"
            return {"sourceCrawled": True, "telegramOffsetMinimum": min(offsets),
                    "previouslyAcknowledgedRedeliveries": 0,
                    "newListingSends": len(_listing_messages(calls, "sendMessage", OWNER, "100000"))}


def run(node_image: str, native_image: str, output: Path) -> dict:
    assert output.is_absolute() and not output.exists(), "output must be a new absolute directory"
    output.mkdir(mode=0o700)
    node = _inspect_node(node_image)
    node_id = node["id"]
    fixture_hash = sha256(FIXTURE.read_bytes()).hexdigest()
    manifest = json.loads((FIXTURE.parent / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["sha256"][FIXTURE.name] == fixture_hash, "frozen Node fixture digest changed"
    with Harness(native_image, output) as harness:
        data = harness.new_volume()
        backup = harness.new_volume()
        _seed(harness, data, FIXTURE)
        # The frozen schema fixture predates the drill. Its historic USD-only
        # exchange snapshot is stale for service startup, so provide a current
        # synthetic three-currency snapshot before Node takes the backup.
        today = datetime.now(timezone.utc)
        rates = {iso: {"amount": 1, "rate": 400} for iso in ("USD", "EUR", "RUB")}
        exchange_snapshot = {
            "version": 1,
            "type": "cba-exchange-rates",
            "baseCurrency": "AMD",
            "fetchedAt": today.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "effectiveDate": today.date().isoformat(),
            "rates": rates,
        }
        with harness.host_access(data) as root:
            with sqlite3.connect(root / "state.sqlite3") as connection:
                connection.execute(
                    "UPDATE exchange_rate_state SET snapshot_json=? WHERE singleton=1",
                    (json.dumps(exchange_snapshot),),
                )
        seeded = _state(harness, data)
        assert seeded["currentVersion"] == 5 and seeded["updateOffset"] == 42

        # The retained Node image creates the same pre-deploy recovery point
        # that the host takes after stopping its old service.
        backup_result = _node(harness, node_id, ["src/recovery-cli.js", "backup"], data, backup)
        snapshot = _node_event(backup_result, "backup.completed")["snapshot"]
        assert snapshot.startswith(BACKUP_PATH + "/daily/")
        _node(harness, node_id, ["src/recovery-cli.js", "validate", snapshot], data, backup)
        predeploy = _all_rows(harness, data)
        predeploy_state = _state(harness, data)
        assert predeploy_state["currentVersion"] == 6
        assert predeploy_state["updateOffset"] == 42
        assert any(
            row["item_id"] == "100001" and row["status"] == 0
            for row in predeploy["private_delivery_decisions"]
        ), "frozen Node acknowledgement was not preserved"

        # Fail the Telegram identity preflight after candidate launch. The
        # native service must not become ready or crawl; rollback restores the
        # stopped Node image's exact snapshot before another launch.
        with Peer() as rejected_peer:
            rejected_peer.identity_failure = True
            rejected = harness.start_app(
                _native_options(rejected_peer), data_volume=data,
                backup_volume=backup, env=_native_env(_free_port()),
            )
            try:
                _wait(
                    "candidate exit after identity rejection",
                    lambda: not harness.inspect(rejected)["State"]["Running"],
                    seconds=10,
                    detail=lambda: harness.logs(rejected)[-2000:],
                )
                assert harness.inspect(rejected)["State"]["ExitCode"] != 0
                assert any(method == "getMe" for method, _ in rejected_peer.snapshot())
                assert not rejected_peer.source_paths(), "rejected candidate reached source peer"
                rejected_logs = harness.logs(rejected)
                assert "crawl.succeeded" not in rejected_logs
            finally:
                harness.stop_app(rejected)
        after_rejection = _all_rows(harness, data)
        assert after_rejection == predeploy, "failed native startup changed protected Node rows"
        assert _state(harness, data)["updateOffset"] == 42
        _node(harness, node_id, ["src/recovery-cli.js", "restore", snapshot], data, backup)
        assert _all_rows(harness, data) == predeploy, "Node rollback did not restore the exact predeploy rows"
        _node(harness, node_id, ["src/maintenance-cli.js", "report"], data, backup)
        first_node_recovery = _node_service(harness, node_id, data, backup, output)
        _node(harness, node_id, ["src/recovery-cli.js", "restore", snapshot], data, backup)
        assert _all_rows(harness, data) == predeploy

        # The normal cutover starts the accepted Rust image on that same data
        # mount. Node had already acknowledged 100001 and stored offset 42;
        # only the newly discovered 100000 may be delivered.
        with Peer() as peer:
            peer.retry_listing_once = False
            port = _free_port()
            candidate = harness.start_app(
                _native_options(peer), data_volume=data,
                backup_volume=backup, env=_native_env(port),
            )
            try:
                _wait("native readiness", lambda: _ready(port), detail=lambda: harness.logs(candidate)[-4000:])
                _wait(
                    "native source crawl and new private delivery",
                    lambda: (
                        '"event":"crawl.succeeded"' in harness.logs(candidate)
                        and len(_listing_messages(peer.snapshot(), "sendMessage", OWNER, "100000")) == 1
                    ),
                    detail=lambda: (peer.snapshot()[-20:], harness.logs(candidate)[-4000:]),
                )
                assert '"event":"source.integrity.checked"' in harness.logs(candidate)
            finally:
                harness.stop_app(candidate)
            calls = peer.snapshot()
            assert len(_listing_messages(calls, "sendMessage", OWNER, "100000")) == 1
            assert not _listing_messages(calls, "sendMessage", OWNER, "100001"), "acknowledged Node item was resent"
            offsets = [int(payload.get("offset", 0)) for method, payload in calls if method == "getUpdates"]
            assert offsets and min(offsets) >= 42, f"Telegram offset regressed: {offsets}"
        native_state = _state(harness, data)
        assert native_state["databaseId"] == predeploy_state["databaseId"]
        assert native_state["updateOffset"] >= 42
        assert any(
            row["itemId"] == "100000" and row["status"] == 0
            for row in native_state["decisions"]
        ), "new native delivery was not durably acknowledged"

        # Both images serve schema 6. A compatible live-state Node restart
        # preserves the native acknowledgement and avoids replay.
        compatible_node_recovery = _node_service(harness, node_id, data, backup, output)
        assert compatible_node_recovery["newListingSends"] == 0, "compatible Node restart replayed native acknowledgement"

        # Deliberately exercise the older snapshot recovery path to expose
        # replay of deliveries acknowledged after that snapshot.
        _node(harness, node_id, ["src/recovery-cli.js", "restore", snapshot], data, backup)
        assert _all_rows(harness, data) == predeploy, "post-cutover rollback changed Node snapshot rows"
        _node(harness, node_id, ["src/maintenance-cli.js", "report"], data, backup)
        assert _state(harness, data)["updateOffset"] == 42
        second_node_recovery = _node_service(harness, node_id, data, backup, output)
        assert second_node_recovery["newListingSends"] == 1, "snapshot age no longer exposes replay risk"

        return {
            "type": "disposable-rust-cutover-exercise",
            "version": 1,
            "nodeImageId": node_id,
            "nodeSourceRevision": node["revision"],
            "nodeRegistryDigest": node["registryDigest"],
            "nativeImageId": harness.image_id,
            "nativeSourceRevision": harness.source_revision,
            "nativeBinarySha256": harness.binary_sha256,
            "nodeFixtureSha256": fixture_hash,
            "snapshot": snapshot,
            "databaseId": predeploy_state["databaseId"],
            "nodeRecoveryAfterRejection": first_node_recovery,
            "nodeRecoveryWithLiveNativeState": compatible_node_recovery,
            "nodeRecoveryAfterPredeploySnapshotRestore": second_node_recovery,
            "postNativeSnapshotRestoreRedeliveryObserved": True,
            "checks": [
                "frozen-node-state-upgraded-and-backed-up-by-node-image",
                "independent-predeploy-snapshot-validated-by-node-image",
                "native-identity-rejection-before-crawl",
                "rejected-native-startup-left-node-rows-and-offset-unchanged",
                "node-snapshot-restored-after-rejection",
                "node-service-ready-crawled-and-preserved-prior-acks-after-rejection",
                "native-ready-source-integrity-and-crawl-on-same-data-mount",
                "new-private-delivery-acknowledged-once",
                "node-acknowledged-delivery-and-telegram-offset-not-replayed",
                "node-compatible-restart-preserved-new-native-acknowledgement",
                "node-snapshot-restored-after-native-mutation",
                "node-service-ready-crawled-and-preserved-prior-acks-after-native-mutation",
            ],
            "remainingHostOnly": [
                "This drill does not execute systemd, the GHCR discovery pointer, or the host operations lock.",
                "This drill observed replay after an explicit predeploy snapshot restore. The updated unattended deployer checks compatible live state before restarting Node after a failed Rust rollout; the complete host controller still requires its own rollback receipt.",
                "The production host must confirm its deployed bridge revision, independent backup mount, retained Node image, and matching snapshot before promotion.",
                "The live cutover still needs operator authorization and host readiness, crawl, delivery, and rollback receipts.",
            ],
        }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node-image", required=True)
    parser.add_argument("--native-image", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if not args.output.is_absolute() or args.output.exists():
        parser.error("--output must name a new absolute directory")
    report = run(args.node_image, args.native_image, args.output)
    (args.output / "report.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    main()

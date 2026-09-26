#!/usr/bin/env python3
"""Exercise the real deploy rollback helper with disposable local Compose services.

This uses packaged images and synthetic peers, but replaces systemd, GHCR
discovery, and production paths. It does not produce a host deployment receipt.
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
sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import Harness, command
from lifecycle import _all_rows, _seed, _state
from node_peer import NodePeerProxy
from run import FIXTURE, _inspect_node, _node, _node_event
from service import OWNER, Peer, _free_port, _listing_messages, _ready, _wait


REPOSITORY = Path(__file__).resolve().parents[2]
DEPLOYMENT_LIBRARY = REPOSITORY / "ops/lib/deployment.sh"
NATIVE_OVERRIDE = REPOSITORY / "ops/compose.native.yaml"


def _image_reference(image: str) -> tuple[str, str, bool]:
    info = json.loads(command(["docker", "image", "inspect", image]).stdout)[0]
    references = [
        reference for reference in info["RepoDigests"]
        if re.fullmatch(r"[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}", reference)
    ]
    if "@sha256:" in image:
        assert image in references, "requested digest is not installed"
        return image, info["Id"], True
    if references:
        return references[0], info["Id"], True
    assert image == info["Id"], "image without a RepoDigest must be supplied by exact image ID"
    return info["Id"], info["Id"], False


def _compose_file(
    release: Path, image: str, container: str, data: str, backup: str,
    health_port: int, proxy: NodePeerProxy | None,
) -> None:
    release.mkdir(parents=True, exist_ok=True)
    environment = {
        "NODE_ENV": "test",
        "DATA_DIRECTORY": "/app/.data",
        "BACKUP_DIRECTORY": "/app-backups",
        "SQLITE_TMPDIR": "/sqlite-tmp",
        "CURL_IMPERSONATE_PATH": "/usr/local/bin/curl-impersonate",
        "TELEGRAM_BOT_TOKEN": "123:synthetic-host-recovery",
        "TELEGRAM_OWNER_ID": "123",
        "TELEGRAM_ACCESS_MODE": "owner",
        "HEALTH_PORT": str(health_port),
        "INITIAL_PAGE_COUNT": "1",
        "POLL_INTERVAL_MS": "100",
        "TELEGRAM_POLL_TIMEOUT_SECONDS": "1",
        "EXTERNAL_RETRY_BASE_MS": "10",
        "EXTERNAL_RETRY_MAX_MS": "100",
    }
    mounts = [f"{data}:/app/.data", f"{backup}:/app-backups"]
    service = {
        "image": "${RENTAL_APARTMENTS_IMAGE}",
        "container_name": container,
        "network_mode": "host",
        "user": "1000:1000",
        "read_only": True,
        "cap_drop": ["ALL"],
        "security_opt": ["no-new-privileges:true"],
        "tmpfs": ["/tmp:mode=1777,nosuid,nodev,noexec", "/sqlite-tmp:mode=0700,uid=1000,gid=1000,nosuid,nodev,noexec"],
        "volumes": mounts,
        "environment": environment,
        "restart": "no",
        "deploy": {"replicas": 1, "update_config": {"order": "stop-first"}},
    }
    if proxy:
        service["command"] = ["node", "src/index.js"]
        environment.update({
            "NODE_OPTIONS": "--use-env-proxy",
            "NODE_EXTRA_CA_CERTS": "/local-cutover-ca.pem",
            "CURL_CA_BUNDLE": "/local-cutover-ca.pem",
            "HTTPS_PROXY": proxy.origin,
            "HTTP_PROXY": proxy.origin,
            "ALL_PROXY": proxy.origin,
            "NO_PROXY": "127.0.0.1,localhost",
        })
        service["volumes"].append(f"{proxy.ca}:/local-cutover-ca.pem:ro")
        service["extra_hosts"] = [
            f"{host}:127.0.0.2"
            for host in ("api.telegram.org", "api.cba.am", "www.list.am")
        ]
        service["healthcheck"] = {
            "test": ["CMD", "node", "src/health-check.js", "--restart-unresponsive"],
            "interval": "2s", "timeout": "2s", "retries": 10, "start_period": "2s",
        }
    (release / "compose.production.yaml").write_text(
        json.dumps({"services": {"bot": service}}, indent=2) + "\n", encoding="utf-8"
    )


def _candidate_override(release: Path, peer: Peer) -> None:
    options = [
        "serve", "--telegram-endpoint", f"{peer.origin}/telegram",
        "--source-origin", peer.origin, "--cba-endpoint", f"{peer.origin}/cba",
    ]
    source = NATIVE_OVERRIDE.read_text(encoding="utf-8")
    assert source.count('command: ["serve"]') == 1
    native = release / "ops/compose.native.yaml"
    native.parent.mkdir(exist_ok=True)
    native.write_text(
        source.replace('command: ["serve"]', f"command: {json.dumps(options)}"),
        encoding="utf-8",
    )


def _compose(project: str, release: Path, image_env: Path, synthetic_env: Path, *arguments: str):
    options = [
        "docker", "compose", "--project-name", project,
        "--project-directory", str(release),
        "--env-file", str(image_env), "--env-file", str(synthetic_env),
        "--file", str(release / "compose.production.yaml"),
    ]
    if release.joinpath("ops/compose.native.yaml").exists():
        options += ["--file", str(release / "ops/compose.native.yaml")]
    return command(options + list(arguments), timeout=100)


def _recover(
    root: Path, candidate_release: Path, candidate_env: Path,
    previous_release: Path, previous_env: Path, metadata: Path,
    previous_image: str, container: str, project: str,
) -> None:
    script = r'''
set -Eeuo pipefail
RENTAL_OPS_STATE_DIR=$1
RENTAL_RELEASES_ROOT=$2
RENTAL_CURRENT_LINK=$3
RENTAL_IMAGE_ENV_FILE=$4
RENTAL_ENV_FILE=$5
RENTAL_CONTAINER_NAME=$6
candidate_release=$7
candidate_env=$8
previous_release=$9
previous_env=${10}
previous_metadata=${11}
previous_image=${12}
project=${13}
source "${14}"
# Keep the real deployment_compose and recovery functions. Redirect only their
# fixed Compose project name into this drill's otherwise unused project.
docker() {
  if [[ ${1-} == compose && ${2-} == --project-name && ${3-} == rental-apartments ]]; then
    shift 3
    command docker compose --project-name "$project" "$@"
  else
    command docker "$@"
  fi
}
# Docker save/load preserves the image ID but not its registry RepoDigest. In
# that case only, adapt the temporary Compose pointer to this exact local ID.
if [[ "$previous_image" == sha256:* ]]; then
  ops_image_file_reference() {
    local reference
    reference=$(sed -n 's/^RENTAL_APARTMENTS_IMAGE=//p' "$1")
    [[ $reference =~ ^sha256:[0-9a-f]{64}$ || $reference =~ ^[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$ ]] || return 65
    printf '%s\n' "$reference"
  }
  deployment_write_image_environment() {
    [[ $2 == "$previous_image" ]] || return 65
    printf 'RENTAL_APARTMENTS_IMAGE=%s\n' "$2" >"$1"
  }
fi
ops_start_application() {
  deployment_compose "$previous_release" "$previous_env" \
    up --detach --force-recreate --wait --wait-timeout 60 bot
}
ops_stop_application() {
  deployment_compose "$previous_release" "$previous_env" stop bot
}
deployment_recover_node_from_live_state \
  "$candidate_release" "$candidate_env" "$previous_release" \
  "$previous_env" "$previous_metadata" "$previous_image"
'''
    command([
        "bash", "-c", script, "host-recovery-helper",
        str(root / "ops-state"), str(root / "releases"), str(root / "current"),
        str(root / "ops-state/current-image.env"), str(root / "synthetic.env"),
        container, str(candidate_release), str(candidate_env),
        str(previous_release), str(previous_env), str(metadata),
        previous_image, project, str(DEPLOYMENT_LIBRARY),
    ], timeout=100)


def _snapshot(harness: Harness, node_id: str, data: str, backup: str) -> str:
    now = datetime.now(timezone.utc)
    snapshot = {
        "version": 1, "type": "cba-exchange-rates", "baseCurrency": "AMD",
        "fetchedAt": now.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "effectiveDate": now.date().isoformat(),
        "rates": {iso: {"amount": 1, "rate": 400} for iso in ("USD", "EUR", "RUB")},
    }
    with harness.host_access(data) as volume:
        with sqlite3.connect(volume / "state.sqlite3") as database:
            database.execute(
                "UPDATE exchange_rate_state SET snapshot_json=? WHERE singleton=1",
                (json.dumps(snapshot),),
            )
    backup_result = _node(harness, node_id, ["src/recovery-cli.js", "backup"], data, backup)
    point = _node_event(backup_result, "backup.completed")["snapshot"]
    _node(harness, node_id, ["src/recovery-cli.js", "validate", point], data, backup)
    return point


def _node_result(
    peer: Peer, container: str, data: str, harness: Harness, port: int,
    expected_acknowledgement: dict | None,
) -> dict:
    _wait("recovered Node readiness", lambda: _ready(port), seconds=35)
    _wait(
        "recovered Node delivery cycles",
        lambda: command(["docker", "logs", container], check=False).stdout.count(
            '"event":"crawl.succeeded"'
        ) >= 2,
        seconds=40,
        detail=lambda: command(["docker", "logs", container], check=False).stdout[-3000:],
    )
    if expected_acknowledgement is None:
        _wait(
            "Node delivery after rejected native startup",
            lambda: len(_listing_messages(peer.snapshot(), "sendMessage", OWNER, "100000")) == 1,
            seconds=20,
        )
    calls = peer.snapshot()
    assert not _listing_messages(calls, "sendMessage", OWNER, "100001")
    offsets = [int(payload.get("offset", 0)) for method, payload in calls if method == "getUpdates"]
    assert offsets and min(offsets) >= 42
    state = _state(harness, data)
    if expected_acknowledgement is not None:
        assert expected_acknowledgement in state["decisions"], (
            "Node recovery changed the Rust acknowledgement", expected_acknowledgement,
            state["decisions"],
        )
    return {
        "nodeReady": True, "nodeCrawled": True,
        "previousAcknowledgementRedeliveries": 0,
        "newListingRedeliveries": len(_listing_messages(calls, "sendMessage", OWNER, "100000")),
        "telegramOffsetMinimum": min(offsets),
        "databaseId": state["databaseId"],
        "preservedRustAcknowledgement": expected_acknowledgement,
    }


def run(
    node_image: str, native_image: str, output: Path,
    expected_node_revision: str | None, node_published_digest: str | None,
) -> dict:
    assert output.is_absolute() and not output.exists(), "output must be a new absolute directory"
    output.mkdir(mode=0o700)
    node_reference, node_id, node_digest_resolved = _image_reference(node_image)
    native_reference, native_id, native_digest_resolved = _image_reference(native_image)
    node = _inspect_node(node_image)
    if expected_node_revision:
        assert re.fullmatch(r"[0-9a-f]{40}", expected_node_revision)
        assert node["revision"] == expected_node_revision
    if node_published_digest:
        assert re.fullmatch(
            r"[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}", node_published_digest
        )
        if node_digest_resolved:
            assert node_published_digest == node_reference
        # For docker-loaded images this is the operator's host-transfer record,
        # not an independently resolved local registry reference.
    project = f"rental-host-recovery-{uuid.uuid4().hex[:12]}"
    existing = json.loads(command(["docker", "compose", "ls", "--all", "--format", "json"]).stdout)
    assert not any(entry["Name"] == project for entry in existing), "generated Compose project already exists"
    root = output / "controller"
    releases = root / "releases"
    previous_release = releases / "previous"
    candidate_release = releases / "candidate"
    releases.mkdir(parents=True)
    previous_release.mkdir()
    (root / "ops-state").mkdir()
    synthetic_env = root / "synthetic.env"
    synthetic_env.write_text("NODE_ENV=test\n", encoding="utf-8")
    candidate_env = root / "candidate-image.env"
    candidate_env.write_text(f"RENTAL_APARTMENTS_IMAGE={native_reference}\n", encoding="utf-8")
    previous_env = root / "previous-image.env"
    previous_env.write_text(f"RENTAL_APARTMENTS_IMAGE={node_reference}\n", encoding="utf-8")
    metadata = previous_release / "release-metadata.json"
    container = f"rental-host-recovery-{uuid.uuid4().hex[:10]}"

    with Harness(native_image, output) as harness:
        data = harness.new_volume()
        backup = harness.new_volume()
        _seed(harness, data, FIXTURE)
        point = _snapshot(harness, node_id, data, backup)
        predeploy = _all_rows(harness, data)
        initial = _state(harness, data)
        assert initial["currentVersion"] == 6 and initial["updateOffset"] == 42
        labels = json.loads(command([
            "docker", "image", "inspect", "--format", "{{json .Config.Labels}}", node_reference,
        ]).stdout)
        metadata.write_text(json.dumps({
            "imageReference": node_reference, "stateBackend": "sqlite",
            "minimumStateSchema": int(labels["com.rental-apartments.state.schema.minimum"]),
            "maximumStateSchema": int(labels["com.rental-apartments.state.schema.maximum"]),
        }) + "\n", encoding="utf-8")
        assert labels["com.rental-apartments.state.backend"] == "sqlite"
        rejection_result = None
        accepted_result = None
        accepted_acknowledgement = None
        try:
            for accepted in (False, True):
                with Peer() as native_peer, Peer() as node_peer:
                    native_peer.retry_listing_once = False
                    native_peer.identity_failure = not accepted
                    node_peer.retry_listing_once = False
                    with NodePeerProxy(output / f"node-helper-{'accepted' if accepted else 'rejected'}", node_peer) as proxy:
                        native_port = _free_port()
                        node_port = _free_port()
                        _compose_file(candidate_release, native_reference, container, data, backup, native_port, None)
                        _candidate_override(candidate_release, native_peer)
                        _compose_file(previous_release, node_reference, container, data, backup, node_port, proxy)
                        (root / "current").unlink(missing_ok=True)
                        (root / "current").symlink_to(candidate_release)
                        (root / "ops-state/current-image.env").write_text(
                            f"RENTAL_APARTMENTS_IMAGE={native_reference}\n", encoding="utf-8"
                        )
                        _compose(project, candidate_release, candidate_env, synthetic_env, "up", "--detach", "--force-recreate", "bot")
                        if accepted:
                            _wait("native readiness", lambda: _ready(native_port), seconds=30)
                            _wait(
                                "native acknowledgement",
                                lambda: any(
                                    row["itemId"] == "100000" and row["status"] == 0
                                    for row in _state(harness, data)["decisions"]
                                ),
                                seconds=40,
                            )
                            accepted_acknowledgement = next(
                                row for row in _state(harness, data)["decisions"]
                                if row["itemId"] == "100000" and row["status"] == 0
                            )
                        else:
                            _wait(
                                "native identity rejection", lambda: not json.loads(
                                    command(["docker", "inspect", container]).stdout
                                )[0]["State"]["Running"], seconds=15,
                            )
                            assert _all_rows(harness, data) == predeploy
                        _recover(
                            root, candidate_release, candidate_env, previous_release,
                            previous_env, metadata, node_reference, container, project,
                        )
                        assert (root / "current").resolve() == previous_release
                        assert (root / "ops-state/current-image.env").read_text().strip() == f"RENTAL_APARTMENTS_IMAGE={node_reference}"
                        result = _node_result(
                            node_peer, container, data, harness, node_port,
                            accepted_acknowledgement if accepted else None,
                        )
                        assert result["databaseId"] == initial["databaseId"]
                        if accepted:
                            assert result["newListingRedeliveries"] == 0
                            accepted_result = result
                        else:
                            rejection_result = result
                        _compose(project, previous_release, previous_env, synthetic_env, "stop", "bot")
                        if not accepted:
                            _node(harness, node_id, ["src/recovery-cli.js", "restore", point], data, backup)
                            assert _all_rows(harness, data) == predeploy
        finally:
            command([
                "docker", "compose", "--project-name", project,
                "--project-directory", str(candidate_release),
                "--env-file", str(candidate_env), "--env-file", str(synthetic_env),
                "--file", str(candidate_release / "compose.production.yaml"),
                "--file", str(candidate_release / "ops/compose.native.yaml"),
                "down",
            ], check=False)
        assert rejection_result and accepted_result
        return {
            "type": "disposable-controller-helper-recovery",
            "version": 1,
            "composeProject": project,
            "deploymentLibrarySha256": sha256(DEPLOYMENT_LIBRARY.read_bytes()).hexdigest(),
            "nativeComposeTemplateSha256": sha256(NATIVE_OVERRIDE.read_bytes()).hexdigest(),
            "nodeImageId": node_id, "nodeImageReference": node_reference,
            "nodeSourceRevision": node["revision"],
            "nodeRepoDigestAvailableLocally": node_digest_resolved,
            "nodePublishedDigestAssertion": node_published_digest,
            "nativeImageId": native_id, "nativeImageReference": native_reference,
            "nativeSourceRevision": harness.source_revision,
            "nativeRepoDigestAvailableLocally": native_digest_resolved,
            "snapshot": point, "databaseId": initial["databaseId"],
            "rejectionRecovery": rejection_result,
            "postAcknowledgementRecovery": accepted_result,
            "checks": [
                "real-deployment-helper-stopped-and-confirmed-native-candidate",
                "native-state-inspected-read-only-through-candidate-compose",
                "retained-node-metadata-and-image-labels-checked",
                "temporary-current-pointer-and-image-reference-restored",
                "node-compose-restarted-ready-and-crawled",
                "rust-acknowledgement-not-replayed-by-node",
            ],
            "remainingHostOnly": [
                "Systemd start, GHCR discovery, production paths, and the host operations lock are replaced by disposable adapters.",
                "A docker-loaded image ID does not prove its asserted registry digest; compare the transfer and host image ID records separately.",
                "This invokes the deployment recovery helper, not the full ops/deploy controller; it does not produce a deployment rollback receipt.",
                "Live promotion and host rollback/readiness receipts remain operator-gated.",
            ],
        }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node-image", required=True)
    parser.add_argument("--native-image", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--expected-node-revision")
    parser.add_argument("--node-published-digest")
    args = parser.parse_args()
    report = run(
        args.node_image, args.native_image, args.output,
        args.expected_node_revision, args.node_published_digest,
    )
    (args.output / "report.json").write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Manual release contract, ordering, and guarded recovery failure boundaries."""
import importlib.util
import io
import json
import os
from pathlib import Path
import pwd
import signal
import subprocess
import sys
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("manual_release", ROOT / "scripts/release-operations.py")
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)
IMAGE = "ghcr.io/example/bot@sha256:" + "a" * 64
PREVIOUS = "ghcr.io/example/bot@sha256:" + "b" * 64
REVISION = "c" * 40


def raw():
    return {"operation": "deploy", "environment": "production", "actor": "agent:fixture-123",
            "image": IMAGE, "previous-image": PREVIOUS, "snapshot": "/app-backups/daily/2026-09-27T00-00-00Z",
            "poll-interval-ms": "60000", "observation-minutes": "6", "delivery": "both"}


def logs():
    return "\n".join(map(json.dumps, [
        {"event": "startup.preflight.completed", "preflight": {"status": "ready", "checks": {"telegram": "passed", "channel": "passed"}}},
        {"event": "crawl.succeeded", "crawlId": "synthetic-crawl", "durationMs": 100, "notified": 0,
         "channelSent": 0, "channelEdited": 0, "privateSecret": "must-not-be-in-receipt"}]))


class DockerPeer:
    def __init__(self):
        self.calls = []
        self.image = PREVIOUS
        self.running = True
        self.present = True
        self.live_schema = 6
        self.target_schema = 6
        self.runtime = "rust"
        self.bad_metadata = False
        self.bad_compose = False
        self.bad_snapshot = False
        self.bad_volume = False
        self.candidate_failure = False
        self.recreate_failure = False
        self.recovery_failure = False
        self.overlap = False
        self.after_candidate_schema = 6
        self.rendered_image_wrong = False
        self.started_image_wrong = False
        self.stop_failure = False
        self.bad_archive = False
        self.security_override = {}
        self.now = 0

    def sleep(self, seconds):
        self.now += seconds

    def run(self, command, env=None):
        self.calls.append((command, (env or {}).get("RENTAL_APARTMENTS_IMAGE")))
        def response(value=""):
            return subprocess.CompletedProcess(command, 0, value if isinstance(value, str) else json.dumps(value), "")
        if command[0] == "bash":
            if self.bad_metadata:
                raise ValueError("unverified release")
            bundle = Path(command[6])
            (bundle / "compose.production.yaml").write_text("services: {}\n")
            with tarfile.open(bundle / "operations.tar", "w") as archive:
                member = tarfile.TarInfo("ops/compose.native.yaml")
                content = b"services: {}\n"
                member.size = len(content)
                if self.bad_archive:
                    member.type = tarfile.SYMTYPE
                    member.linkname = "/tmp/untrusted"
                    member.size = 0
                archive.addfile(member, io.BytesIO(content))
            return response()
        args = command[1:]
        if args[:2] == ["image", "inspect"]:
            image = args[-1]
            return response({"com.rental-apartments.runtime": self.runtime,
                             "org.opencontainers.image.revision": REVISION,
                             "com.rental-apartments.state.backend": "sqlite",
                             "com.rental-apartments.state.schema.minimum": "1",
                             "com.rental-apartments.state.schema.maximum": str(self.target_schema if image == IMAGE else 6)})
        if args[0] == "compose":
            action = args[7:]
            image = env["RENTAL_APARTMENTS_IMAGE"]
            if action[:1] == ["config"]:
                return response({"services": {"bot": {
                    "image": "wrong-image:latest" if self.rendered_image_wrong else image,
                    "container_name": "rental-apartments-bot", "labels": {"com.rental-apartments.environment": "production"},
                    "environment": {"NODE_ENV": "production"}, "read_only": not self.bad_compose,
                    "cap_drop": ["ALL"], "security_opt": ["no-new-privileges:true"], **self.security_override,
                    "deploy": {"replicas": 1, "update_config": {"order": "stop-first"}},
                    "volumes": [{"target": "/app/.data", "type": "volume", "source": "data"},
                                {"target": "/app-backups", "type": "volume", "source": "backup", "read_only": True}]}},
                    "volumes": {"data": {"name": "other" if self.bad_volume and image == IMAGE else "persisted-data"}}})
            if action == ["stop", "bot"]:
                self.running = self.overlap
                if self.stop_failure:
                    self.stop_failure = False
                    raise ValueError("stop failed after stopping")
                return response()
            if action[0] == "up":
                if image == IMAGE:
                    self.live_schema = self.after_candidate_schema
                    if self.recreate_failure:
                        self.present = False
                        raise ValueError("failed recreate")
                self.image, self.running, self.present = image, True, True
                if image == IMAGE and self.started_image_wrong:
                    self.image = "wrong-image:latest"
                return response()
            if "backup:validate" in action and self.bad_snapshot:
                raise ValueError("invalid snapshot")
            if "state:inspect" in action:
                return response({"stateBackend": "sqlite", "stateSchema": self.live_schema})
            return response()
        if args[0] == "inspect":
            if args[2] == "{{.State.Running}}":
                if not self.present:
                    raise ValueError("missing recreated container")
                return response("true" if self.running else "false")
            return response({"Config": {"Image": self.image, "Labels": {"com.rental-apartments.environment": "production"}},
                             "State": {"Running": self.running}, "Mounts": [{"Type": "volume", "Destination": "/app/.data", "Name": "persisted-data"}]})
        if args[0] == "ps":
            return response("rental-apartments-bot" if self.overlap else "")
        if args[0] == "exec":
            if args[-1] == "state:inspect":
                return response({"stateBackend": "sqlite", "stateSchema": self.live_schema})
            if (self.image == IMAGE and self.candidate_failure) or (self.image == PREVIOUS and self.recovery_failure):
                raise ValueError("unready")
            return response({"status": "ready"})
        if args[0] == "logs":
            return response(logs())
        raise AssertionError(command)


class ManualRelease(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="manual-release-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        (self.root / "ops").mkdir()
        (self.root / "ops/compose.native.yaml").write_text("services: {}\n")
        (self.root / "compose.production.yaml").write_text("services: {}\n")
        self.values = raw() | {"compose-file": str(self.root / "compose.production.yaml"), "evidence-file": str(self.root / "receipt.json")}
        self.peer = DockerPeer()

    def engine(self, **changes):
        contract = release.create_release_contract(self.values | changes)
        return release.Release(contract, runner=self.peer.run, sleep=self.peer.sleep, clock=lambda: self.peer.now)

    def mutated(self):
        return [args for args, _ in self.peer.calls if "stop" in args or "up" in args or "backup:restore" in args]

    def test_complete_contract_and_rejected_inputs(self):
        self.assertEqual(self.engine().contract["observationMs"], 360000)
        for changes in ({"image": "latest"}, {"image": PREVIOUS}, {"actor": "unknown"}, {"environment": "staging"},
                        {"snapshot": "/app-backups/.snapshot-temporary"}, {"observation-minutes": "5"},
                        {"poll-interval-ms": "0"}, {"poll-interval-ms": "1e3"}, {"delivery": "bad"},
                        {"state-strategy": "bad"}, {"target-release": "/tmp/untrusted"},
                        {"target-release": "/var/lib/rental-apartments/releases/one/two"}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.engine(**changes)
        for args in (["deploy", "--actor", "one", "--actor", "two"], ["deploy", "--unknown", "x"], ["rehearse"]):
            with self.assertRaises(ValueError):
                release.parse_arguments(args)

    def test_dry_run_is_a_process_without_docker(self):
        binary = self.root / "bin"
        binary.mkdir()
        marker = self.root / "docker-called"
        docker = binary / "docker"
        docker.write_text('#!/bin/sh\ntouch "$DOCKER_MARKER"\nexit 99\n')
        docker.chmod(0o755)
        args = [sys.executable, str(ROOT / "scripts/release-operations.py"), "validate"]
        for name, value in raw().items():
            if name != "operation":
                args += ["--" + name, value]
        result = subprocess.run(args, env={"PATH": str(binary), "DOCKER_MARKER": str(marker)}, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["mutation"], "none")
        self.assertFalse(marker.exists())

    def test_evidence_requires_ready_preflight_crawl_and_matching_channel(self):
        self.assertTrue(release.find_release_evidence(logs(), "both")["ready"])
        self.assertFalse(release.find_release_evidence(logs(), "private")["channelVerified"])
        self.assertFalse(release.find_release_evidence(logs().replace("crawl.succeeded", "crawl.failed"), "both")["ready"])

    def test_success_verifies_before_stop_and_writes_private_receipt(self):
        receipt = self.engine().execute()
        actions = [args for args, _ in self.peer.calls]
        first_stop = next(index for index, args in enumerate(actions) if "stop" in args)
        self.assertEqual(sum(args[0] == "bash" for args in actions[:first_stop]), 2)
        self.assertTrue(any("backup:validate" in args for args in actions[:first_stop]))
        self.assertEqual(receipt["dataVolume"], "persisted-data")
        self.assertTrue(receipt["retainedPreviousArtifact"])
        self.assertEqual(self.peer.image, IMAGE)
        self.assertTrue(self.peer.running)
        self.assertNotIn("must-not-be-in-receipt", json.dumps(receipt))
        self.assertEqual((self.root / "receipt.json").stat().st_mode & 0o777, 0o600)
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.engine().execute()

    def test_bad_runtime_metadata_schema_compose_snapshot_and_volume_fail_before_stop(self):
        for attribute, value in [("runtime", "node"), ("runtime", "unknown"), ("runtime", ""),
                                 ("bad_metadata", True), ("target_schema", 5), ("bad_compose", True),
                                 ("bad_snapshot", True), ("bad_volume", True),
                                 ("rendered_image_wrong", True), ("bad_archive", True)]:
            with self.subTest(attribute=attribute, value=value):
                self.peer = DockerPeer()
                setattr(self.peer, attribute, value)
                with self.assertRaises(ValueError):
                    self.engine().execute()
                self.assertEqual(self.mutated(), [])

    def test_unverified_local_compose_fails_before_stop(self):
        (self.root / "compose.production.yaml").write_text("services: {bot: {image: unexpected}}\n")
        with self.assertRaisesRegex(ValueError, "differs from the verified"):
            self.engine().execute()
        self.assertEqual(self.mutated(), [])

    def test_retained_security_contract_cannot_be_weakened(self):
        for change in ({"ports": [8787]}, {"cap_add": ["SYS_ADMIN"]}, {"cap_drop": []}, {"security_opt": []}):
            with self.subTest(change=change):
                self.peer = DockerPeer()
                self.peer.security_override = change
                with self.assertRaises(ValueError):
                    self.engine().execute()
                self.assertEqual(self.mutated(), [])

    def test_interrupt_during_observation_recovers_previous(self):
        engine = self.engine()
        def interrupt(_started):
            os.kill(os.getpid(), signal.SIGTERM)
        engine.observe = interrupt
        with release.cancellation(), self.assertRaisesRegex(ValueError, "previous image restarted"):
            engine.execute()
        self.assertEqual(self.peer.image, PREVIOUS)
        self.assertTrue(self.peer.running)
        self.assertFalse(any("backup:restore" in args for args, _ in self.peer.calls))

    def test_actual_started_image_mismatch_recovers_previous(self):
        self.peer.started_image_wrong = True
        with self.assertRaisesRegex(ValueError, "previous image restarted"):
            self.engine().execute()
        self.assertEqual(self.peer.image, PREVIOUS)
        self.assertTrue(self.peer.running)

    def test_stop_error_after_stopping_recovers_verified_previous(self):
        self.peer.stop_failure = True
        with self.assertRaisesRegex(ValueError, "verified previous image was restarted"):
            self.engine().execute()
        self.assertEqual(self.peer.image, PREVIOUS)
        self.assertTrue(self.peer.running)
        self.assertFalse(any("backup:restore" in args for args, _ in self.peer.calls))

    def test_failed_candidate_preserves_compatible_live_state(self):
        self.peer.candidate_failure = True
        with self.assertRaisesRegex(ValueError, "compatible live SQLite without snapshot restore"):
            self.engine().execute()
        self.assertEqual(self.peer.image, PREVIOUS)
        self.assertTrue(self.peer.running)
        self.assertFalse(any("backup:restore" in args for args, _ in self.peer.calls))

    def test_incompatible_live_recovery_refuses_snapshot_and_leaves_candidate_stopped(self):
        self.peer.candidate_failure = True
        self.peer.after_candidate_schema = 7
        with self.assertRaisesRegex(ValueError, "recovery failed"):
            self.engine().execute()
        self.assertFalse(self.peer.running)
        self.assertFalse(any("backup:restore" in args for args, _ in self.peer.calls))

    def test_explicit_restore_uses_verified_target_then_previous_on_failure(self):
        self.peer.candidate_failure = True
        with self.assertRaisesRegex(ValueError, "verified snapshot"):
            self.engine(operation="rollback", **{"state-strategy": "restore"}).execute()
        restores = [image for args, image in self.peer.calls if "backup:restore" in args]
        self.assertEqual(restores, [IMAGE, PREVIOUS])
        self.assertEqual(self.peer.image, PREVIOUS)

    def test_missing_recreated_container_is_checked_before_recovery(self):
        self.peer.recreate_failure = True
        with self.assertRaisesRegex(ValueError, "previous image restarted"):
            self.engine().execute()
        self.assertTrue(any(args[:2] == ["docker", "ps"] for args, _ in self.peer.calls))
        self.assertEqual(self.peer.image, PREVIOUS)

    def test_failed_stop_refuses_overlap(self):
        self.peer.overlap = True
        with self.assertRaisesRegex(ValueError, "still running"):
            self.engine().execute()
        self.assertFalse(any("up" in args for args, _ in self.peer.calls))

    def test_unready_previous_image_is_stopped(self):
        self.peer.candidate_failure = self.peer.recovery_failure = True
        with self.assertRaisesRegex(ValueError, "recovery failed"):
            self.engine().execute()
        self.assertEqual(self.peer.image, PREVIOUS)
        self.assertFalse(self.peer.running)

    def test_operations_lock_excludes_another_operation_and_symlink(self):
        path = self.root / "operations.lock"
        with release.operations_lock(path):
            with self.assertRaisesRegex(ValueError, "another operation"):
                with release.operations_lock(path):
                    self.fail("lock overlap")
        link = self.root / "lock-link"
        link.symlink_to(path)
        with self.assertRaises(OSError):
            with release.operations_lock(link):
                self.fail("followed symlink")

    def test_retained_bundle_requires_canonical_owned_unwritable_path(self):
        base = self.root / "releases"
        base.mkdir(mode=0o700)
        target = base / (REVISION + "-" + "a" * 16)
        target.mkdir(mode=0o700)
        trust = {"root": str(base), "ancestors": [], "rootOwnerAccount": pwd.getpwuid(os.getuid()).pw_name,
                 "releaseOwnerUid": os.getuid()}
        contract = release.create_release_contract(self.values | {"target-release": str(target)}, trust=trust)
        release.verify_trusted_target(contract, {"sourceRevision": REVISION}, IMAGE)
        target.chmod(0o777)
        with self.assertRaisesRegex(ValueError, "ownership boundary"):
            release.verify_trusted_target(contract, {"sourceRevision": REVISION}, IMAGE)
        target.chmod(0o700)
        with self.assertRaisesRegex(ValueError, "identity mismatch"):
            release.verify_trusted_target(contract, {"sourceRevision": "d" * 40}, IMAGE)


if __name__ == "__main__":
    unittest.main()

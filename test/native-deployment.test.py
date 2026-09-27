"""Host deployment boundaries that do not require a running production host."""

from __future__ import annotations

import json
import hashlib
import io
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class NativeDeploymentTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="native-deployment-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.environment = {**os.environ, "RENTAL_OPS_STATE_DIR": str(self.root / "state"),
                            "RENTAL_CONTAINER_NAME": "rental-apartments-bot"}

    def bash(self, script: str, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["bash", "-c", "set -Eeuo pipefail; source ops/lib/deployment.sh; " + script,
             "native-deployment-test", *args], cwd=ROOT, env=self.environment,
            text=True, capture_output=True, check=False,
        )

    def test_runtime_rejects_absent_node_and_unknown_labels(self) -> None:
        fake = self.root / "docker"
        fake.write_text("#!/bin/sh\nprintf '%s\\n' \"$RENTAL_TEST_RUNTIME\"\n")
        fake.chmod(0o755)
        self.environment["DOCKER_BIN"] = str(fake)
        for label in ("", "node", "unknown", "<no value>"):
            self.environment["RENTAL_TEST_RUNTIME"] = label
            result = self.bash('ops_runtime "$1"', "fixture-image")
            self.assertNotEqual(result.returncode, 0, label)
        self.environment["RENTAL_TEST_RUNTIME"] = "rust"
        result = self.bash('ops_app_command "$1" backup; declare -p OPS_APP_COMMAND', "fixture-image")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("backup:create", result.stdout)

    def test_transition_accepts_rust_only_and_rejects_capability_expansion(self) -> None:
        image_old = "fixture.local/app@sha256:" + "a" * 64
        image_new = "fixture.local/app@sha256:" + "b" * 64
        base = {
            "schemaVersion": 3, "provenanceKind": "cargo-source-v1",
            "runtime": "rust", "sourceRevision": "c" * 40,
            "stateBackend": "sqlite", "minimumStateSchema": 1,
            "maximumStateSchema": 6, "deployableStateBackends": ["sqlite"],
            "deployableProvenanceContracts": ["legacy-package-lock-v2", "cargo-source-v3"],
        }
        old = {**base, "imageReference": image_old, "deployableRuntimes": ["node", "rust"]}
        new = {**base, "imageReference": image_new, "deployableRuntimes": ["rust"]}
        old_path, new_path = self.root / "old.json", self.root / "new.json"
        old_path.write_text(json.dumps(old))
        new_path.write_text(json.dumps(new))
        command = 'deployment_state_transition "$1" "$2" "$3" "$4"'
        accepted = self.bash(command, str(old_path), str(new_path), image_old, image_new)
        self.assertEqual(accepted.returncode, 0, accepted.stderr)
        refused = self.bash(command, str(new_path), str(old_path), image_new, image_old)
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("reintroduces retired Node runtime capability", refused.stderr)
        new["maximumStateSchema"] = 5
        new_path.write_text(json.dumps(new))
        incompatible = self.bash(command, str(old_path), str(new_path), image_old, image_new)
        self.assertNotEqual(incompatible.returncode, 0)
        self.assertIn("does not support the previous SQLite schema range", incompatible.stderr)

    def test_live_recovery_preserves_state_and_fails_closed_if_incompatible(self) -> None:
        previous_metadata = self.root / "previous.json"
        previous_image = "fixture.local/app@sha256:" + "a" * 64
        previous_metadata.write_text(json.dumps({
            "imageReference": previous_image, "stateBackend": "sqlite",
            "minimumStateSchema": 1, "maximumStateSchema": 6,
        }))
        script = r'''
          deployment_compose() {
            printf '%s\n' "$*" >> "$RENTAL_TEST_TRACE"
            if [[ " $* " == *' state:inspect '* ]]; then
              printf '{"stateBackend":"sqlite","stateSchema":%s}\n' "$RENTAL_TEST_SCHEMA"
            fi
          }
          deployment_confirm_application_stopped() { return 0; }
          deployment_restore_current() { printf 'restore-current\n' >> "$RENTAL_TEST_TRACE"; }
          ops_start_application() { printf 'start-previous\n' >> "$RENTAL_TEST_TRACE"; }
          docker() {
            if [[ $1 == image && $2 == inspect ]]; then
              printf '%s\n' '{"com.rental-apartments.state.backend":"sqlite","com.rental-apartments.state.schema.minimum":"1","com.rental-apartments.state.schema.maximum":"6"}'
            else
              return 97
            fi
          }
          deployment_recover_previous_live_state candidate candidate.env previous previous.env "$1" "$2"
        '''
        trace = self.root / "trace"
        self.environment["RENTAL_TEST_TRACE"] = str(trace)
        self.environment["RENTAL_TEST_SCHEMA"] = "6"
        compatible = self.bash(script, str(previous_metadata), previous_image)
        self.assertEqual(compatible.returncode, 0, compatible.stderr)
        events = trace.read_text()
        self.assertIn(" state:inspect", events)
        self.assertIn("start-previous", events)
        self.assertNotIn("backup:restore", events)
        self.assertLess(events.index("stop bot"), events.index("restore-current"))
        self.assertLess(events.index("restore-current"), events.index(" state:inspect"))
        self.assertLess(events.index(" state:inspect"), events.index("start-previous"))
        trace.unlink()
        self.environment["RENTAL_TEST_SCHEMA"] = "7"
        incompatible = self.bash(script, str(previous_metadata), previous_image)
        self.assertNotEqual(incompatible.returncode, 0)
        self.assertIn("restore-current", trace.read_text())
        self.assertNotIn("start-previous", trace.read_text())

    def test_interrupted_candidate_uses_guarded_live_recovery(self) -> None:
        deploy = (ROOT / "ops/deploy").read_text()
        functions = []
        for name in ("deployment_recover_candidate", "ops_cleanup"):
            match = re.search(rf"(?ms)^{name}\(\) \{{.*?^\}}", deploy)
            self.assertIsNotNone(match, name)
            functions.append(match.group())
        temporary = self.root / "temporary"
        temporary.mkdir()
        (temporary / "compose.env").write_text("candidate=image\n")
        trace = self.root / "recovery-trace"
        self.environment["RENTAL_TEST_TRACE"] = str(trace)
        self.environment["RENTAL_TEST_TEMPORARY"] = str(temporary)
        script = r'''
          set -Eeuo pipefail
          source ops/lib/common.sh
          ops_emit_record() { :; }
          deployment_emit() { :; }
          deployment_emit_alert() { :; }
          deployment_recover_previous_live_state() {
            [[ -f $DEPLOYMENT_TEMPORARY_DIR/compose.env ]] || return 91
            printf 'guarded-live-recovery\n' >> "$RENTAL_TEST_TRACE"
          }
          deployment_recover_previous_snapshot() {
            printf 'snapshot-restore\n' >> "$RENTAL_TEST_TRACE"
          }
          ops_start_application() { printf 'blind-start\n' >> "$RENTAL_TEST_TRACE"; }
          DEPLOYMENT_RESTART_REQUIRED=1
          DEPLOYMENT_CANDIDATE_MAY_RUN=1
          DEPLOYMENT_LIVE_ROLLBACK_REQUIRED=1
          DEPLOYMENT_RELEASE=candidate-release
          DEPLOYMENT_CANDIDATE_ENV=candidate-env
          DEPLOYMENT_PREVIOUS_RELEASE=previous-release
          DEPLOYMENT_PREVIOUS_ENV=previous-env
          DEPLOYMENT_CANDIDATE=candidate
          DEPLOYMENT_PREVIOUS=previous
          DEPLOYMENT_TEMPORARY_DIR=$RENTAL_TEST_TEMPORARY
        ''' + "\n".join(functions) + r'''
          ops_begin deployment test-deploy
          exit 19
        '''
        result = subprocess.run(["bash", "-c", script], cwd=ROOT,
                                env=self.environment, text=True,
                                capture_output=True, check=False)
        self.assertEqual(result.returncode, 19, result.stderr)
        self.assertEqual(trace.read_text().strip(), "guarded-live-recovery")
        self.assertFalse(temporary.exists())

    def test_retained_v2_rust_bundle_verifies_lock_and_rejects_node(self) -> None:
        bundle = self.root / "retained-v2"
        bundle.mkdir()
        (bundle / "package-lock.json").write_bytes(b'{"lockfileVersion":3}\n')
        (bundle / "compose.production.yaml").write_bytes(b"services:\n  bot: {}\n")
        (bundle / "operations.tar").write_bytes(b"retained operations")

        def sha(path: str) -> str:
            return hashlib.sha256((bundle / path).read_bytes()).hexdigest()

        revision = "c" * 40
        image = "fixture.local/app@sha256:" + "d" * 64
        metadata = {
            "schemaVersion": 2, "runtime": "rust",
            "sourceRevision": revision, "imageReference": image,
            "imageDigest": "sha256:" + "d" * 64,
            "stateBackend": "sqlite", "minimumStateSchema": 1,
            "maximumStateSchema": 6,
            "packageLockSha256": sha("package-lock.json"),
            "composeSha256": sha("compose.production.yaml"),
            "operationsBundleSha256": sha("operations.tar"),
        }
        metadata_path = bundle / "release-metadata.json"
        metadata_path.write_text(json.dumps(metadata))
        script = r'''
          DEPLOYMENT_SOURCE_REVISION=$1
          docker() {
            if [[ $1 == inspect ]]; then printf '%s\n' "$RENTAL_TEST_RUNTIME"; return; fi
            if [[ $1 == image && $2 == inspect ]]; then printf '%s\n' "$RENTAL_TEST_LOCK_SHA"; return; fi
            return 97
          }
          deployment_verify_release "$2" "$3" "$2/release-metadata.json"
        '''
        self.environment["RENTAL_TEST_RUNTIME"] = "rust"
        self.environment["RENTAL_TEST_LOCK_SHA"] = metadata["packageLockSha256"]

        def verify(source: str = revision, candidate: str = image) -> subprocess.CompletedProcess[str]:
            return self.bash(script, source, str(bundle), candidate)

        verified = verify()
        self.assertEqual(verified.returncode, 0, verified.stderr)
        (bundle / "package-lock.json").write_bytes(b"tampered\n")
        self.assertNotEqual(verify().returncode, 0, "tampered retained lock was accepted")
        (bundle / "package-lock.json").write_bytes(b'{"lockfileVersion":3}\n')
        for runtime in ("", "node", "unknown"):
            self.environment["RENTAL_TEST_RUNTIME"] = runtime
            self.assertNotEqual(verify().returncode, 0, f"{runtime!r} image was accepted")
        self.environment["RENTAL_TEST_RUNTIME"] = "rust"
        metadata["runtime"] = "node"
        metadata_path.write_text(json.dumps(metadata))
        self.assertNotEqual(verify().returncode, 0, "Node metadata was accepted")
        metadata["runtime"] = "rust"
        archive = subprocess.run(
            ["git", "archive", "--format=tar", "HEAD", "ops", "infra/systemd"],
            cwd=ROOT, capture_output=True, check=True,
        ).stdout
        (bundle / "operations.tar").write_bytes(archive)
        metadata["operationsBundleSha256"] = sha("operations.tar")
        metadata["deployableProvenanceContracts"] = ["legacy-package-lock-v2", "cargo-source-v3"]
        metadata_path.write_text(json.dumps(metadata))
        supported = verify()
        self.assertEqual(supported.returncode, 0, supported.stderr)
        historical_revision = "9c95f8f3efb161f507cc26c33312a64dcfa3c6e0"
        historical_image = ("ghcr.io/monkeysees/arm-rental@sha256:"
                            "6d2808e1fee2f85c6cca7c7447b01e92b136c242d4b529784a82fafc7e163ad7")
        historical_helper = (ROOT / "test/fixtures/retained-cargo-provenance.sh").read_bytes()
        self.assertEqual(hashlib.sha256(historical_helper).hexdigest(),
                         "e284842cb85729987336dd8c6274d4a04ed5e161cdd9fbfc054c59e53d83102a")
        with tarfile.open(bundle / "operations.tar", "w") as historical_archive:
            member = tarfile.TarInfo("ops/lib/provenance.sh")
            member.size = len(historical_helper)
            member.mode = 0o644
            historical_archive.addfile(member, io.BytesIO(historical_helper))
        metadata.update({"sourceRevision": historical_revision,
                         "imageReference": historical_image,
                         "imageDigest": historical_image.split("@", 1)[1],
                         "operationsBundleSha256": sha("operations.tar")})
        metadata_path.write_text(json.dumps(metadata))
        retained = verify(historical_revision, historical_image)
        self.assertEqual(retained.returncode, 0, retained.stderr)
        forged_image = "ghcr.io/monkeysees/arm-rental@sha256:" + "e" * 64
        metadata["imageReference"] = forged_image
        metadata["imageDigest"] = forged_image.split("@", 1)[1]
        metadata_path.write_text(json.dumps(metadata))
        self.assertNotEqual(verify(historical_revision, forged_image).returncode, 0,
                            "unlisted legacy verifier image was accepted")
        metadata["imageReference"] = historical_image
        metadata["imageDigest"] = historical_image.split("@", 1)[1]
        metadata["sourceRevision"] = "f" * 40
        metadata_path.write_text(json.dumps(metadata))
        self.assertNotEqual(verify("f" * 40, historical_image).returncode, 0,
                            "unlisted legacy verifier source was accepted")
        metadata["sourceRevision"] = historical_revision
        with tarfile.open(bundle / "operations.tar", "w") as damaged_archive:
            tampered = historical_helper + b"\n# tampered\n"
            member = tarfile.TarInfo("ops/lib/provenance.sh")
            member.size = len(tampered)
            member.mode = 0o644
            damaged_archive.addfile(member, io.BytesIO(tampered))
        metadata["operationsBundleSha256"] = sha("operations.tar")
        metadata_path.write_text(json.dumps(metadata))
        self.assertNotEqual(verify(historical_revision, historical_image).returncode, 0,
                            "unlisted legacy verifier bytes were accepted")

    def test_cached_release_rejects_tampered_bytes_modes_and_extra_files(self) -> None:
        bundle = self.root / "bundle"
        final = self.root / "installed"
        bundle.mkdir()
        final.mkdir()
        archive = subprocess.run(
            ["git", "archive", "--format=tar", "HEAD", "ops", "infra/systemd"],
            cwd=ROOT, capture_output=True, check=True,
        ).stdout
        (bundle / "operations.tar").write_bytes(archive)
        subprocess.run(["tar", "--extract", "--file", str(bundle / "operations.tar"),
                        "--directory", str(final)], check=True)
        for name in ("compose.production.yaml", "release-metadata.json",
                     "source-inputs.json", "transport-files.json"):
            content = name.encode() + b"\n"
            (bundle / name).write_bytes(content)
            (final / name).write_bytes(content)

        def verify() -> subprocess.CompletedProcess[str]:
            return self.bash('deployment_verify_existing_release_contents "$1" "$2" 3',
                             str(final), str(bundle))

        accepted = verify()
        self.assertEqual(accepted.returncode, 0, accepted.stderr)
        service = final / "ops/service"
        original = service.read_bytes()
        service.write_bytes(original + b"\n# tampered\n")
        self.assertNotEqual(verify().returncode, 0, "modified installed service was accepted")
        service.write_bytes(original)
        original_mode = service.stat().st_mode & 0o777
        service.chmod(original_mode & ~0o100)
        self.assertNotEqual(verify().returncode, 0, "nonexecutable installed service was accepted")
        service.chmod(original_mode)
        (final / "unexpected").write_bytes(b"extra\n")
        self.assertNotEqual(verify().returncode, 0, "unexpected cached artifact was accepted")

    def test_retired_protected_index_cannot_be_silently_rewritten(self) -> None:
        state = self.root / "state"
        state.mkdir()
        index = state / "deployment-retention.json"
        evidence = self.root / "evidence.json"
        evidence.write_text(json.dumps({
            "candidateImage": "fixture.local/app@sha256:" + "a" * 64,
            "sourceRevision": "b" * 40,
            "completedAt": "2026-09-27T21:00:00Z",
        }))
        document = {"schemaVersion": 2, "minimumRetainedReleases": 3,
                    "retainedReleases": [],
                    "protectedReleases": [{"candidateImage": "fixture.local/app@sha256:" + "c" * 64}]}
        index.write_text(json.dumps(document))
        original = index.read_bytes()
        result = self.bash('deployment_update_retention_index "$1"', str(evidence))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(index.read_bytes(), original)
        document["protectedReleases"] = []
        index.write_text(json.dumps(document))
        accepted = self.bash('deployment_update_retention_index "$1"', str(evidence))
        self.assertEqual(accepted.returncode, 0, accepted.stderr)
        self.assertEqual(json.loads(index.read_text())["retainedReleases"][0]["candidateImage"],
                         json.loads(evidence.read_text())["candidateImage"])

    def test_receipts_are_private_and_retention_keeps_three_complete_releases(self) -> None:
        state = self.root / "state"
        state.mkdir()
        self.environment["RENTAL_DEPLOYMENTS_DIR"] = str(state / "deployments")
        revision = "e" * 40
        receipts = []
        for character in "abcd":
            image = "ghcr.io/example/app@sha256:" + character * 64
            receipt = self.bash(
                'deployment_write_evidence success systemd:rental-deploy "$1" "" "$2" '
                '"$3" false not-applicable "$4"',
                image, revision, "/mnt/backups/daily/2026-07-25T00:00:00Z",
                "/var/lib/rental-apartments/releases/" + revision + "-" + character,
            )
            self.assertEqual(receipt.returncode, 0, receipt.stderr)
            path = Path(receipt.stdout.strip())
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            document = json.loads(path.read_text())
            self.assertEqual(document["candidateImage"], image)
            self.assertEqual(document["sourceRevision"], revision)
            self.assertEqual(document["rollback"], {"attempted": False,
                                                     "result": "not-applicable",
                                                     "stateStrategy": "not-applicable"})
            receipts.append(path)
            updated = self.bash('deployment_update_retention_index "$1"', str(path))
            self.assertEqual(updated.returncode, 0, updated.stderr)
        index = json.loads((state / "deployment-retention.json").read_text())
        self.assertEqual(index["schemaVersion"], 2)
        self.assertEqual(index["minimumRetainedReleases"], 3)
        self.assertEqual(index["protectedReleases"], [])
        self.assertEqual([entry["candidateImage"] for entry in index["retainedReleases"]],
                         [json.loads(path.read_text())["candidateImage"]
                          for path in reversed(receipts[-3:])])
        self.assertTrue(all(entry["releaseDirectory"] and entry["snapshot"]
                            for entry in index["retainedReleases"]))

        for strategy in ("compatible-live", "snapshot-restore"):
            receipt = self.bash(
                'deployment_write_evidence failed operator:test "$1" "$2" "$3" '
                '"$4" false completed "$5" "$6"',
                "ghcr.io/example/app@sha256:" + "f" * 64,
                "ghcr.io/example/app@sha256:" + "a" * 64,
                revision, "/mnt/backups/daily/2026-07-26T00:00:00Z",
                "/var/lib/rental-apartments/releases/candidate", strategy,
            )
            self.assertEqual(receipt.returncode, 0, receipt.stderr)
            self.assertEqual(json.loads(Path(receipt.stdout.strip()).read_text())["rollback"],
                             {"attempted": True, "result": "completed",
                              "stateStrategy": strategy})

    def test_only_daily_snapshots_can_enter_the_runtime(self) -> None:
        backups = self.root / "backups"
        daily = backups / "daily/2026-09-27T21-00-00Z"
        retired = backups / "protected/pre-sqlite-bridge"
        daily.mkdir(parents=True)
        retired.mkdir(parents=True)
        self.environment["RENTAL_BACKUP_ROOT"] = str(backups)
        script = 'source ops/lib/operations.sh; ops_snapshot_container_path "$1"'
        accepted = self.bash(script, str(daily))
        self.assertEqual(accepted.returncode, 0, accepted.stderr)
        self.assertEqual(accepted.stdout.strip(), "/app-backups/daily/2026-09-27T21-00-00Z")
        rejected = self.bash(script, str(retired))
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("outside the supported backup directories", rejected.stderr)

    def test_quarantine_is_digest_keyed_and_clear_requires_exact_reference(self) -> None:
        candidate = "fixture.local/app@sha256:" + "a" * 64
        script = '''
          deployment_write_quarantine "$1" "$2" candidate-verification-failed
          deployment_is_quarantined "$1"
          deployment_quarantine_file "$1"
        '''
        written = self.bash(script, candidate, "b" * 40)
        self.assertEqual(written.returncode, 0, written.stderr)
        record = json.loads(Path(written.stdout.strip()).read_text())
        self.assertEqual(record["candidateImage"], candidate)
        self.assertEqual(record["reason"], "candidate-verification-failed")
        self.assertEqual(record["sourceRevision"], "b" * 40)
        wrong = self.bash('deployment_clear_quarantine "$1"', "fixture.local/app:production")
        self.assertNotEqual(wrong.returncode, 0)
        self.assertTrue(Path(written.stdout.strip()).exists())
        cleared = self.bash('deployment_clear_quarantine "$1"', candidate)
        self.assertEqual(cleared.returncode, 0, cleared.stderr)
        self.assertFalse(Path(written.stdout.strip()).exists())

    def test_discovery_accepts_only_digest_of_requested_repository(self) -> None:
        repository = "ghcr.io/example/app"
        expected = repository + "@sha256:" + "c" * 64
        script = '''
          docker() {
            if [[ $1 == pull ]]; then return 0; fi
            if [[ $1 == image && $2 == inspect ]]; then
              printf '%s\\n' "$RENTAL_TEST_DISCOVERY"
              return 0
            fi
            return 97
          }
          deployment_resolve_discovery "$1"
        '''
        self.environment["RENTAL_TEST_DISCOVERY"] = (
            "ghcr.io/other/app@sha256:" + "f" * 64 + "\n" + expected
        )
        resolved = self.bash(script, repository)
        self.assertEqual(resolved.returncode, 0, resolved.stderr)
        self.assertEqual(resolved.stdout.strip(), expected)
        self.environment["RENTAL_TEST_DISCOVERY"] = "ghcr.io/other/app@sha256:" + "f" * 64
        refused = self.bash(script, repository)
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("did not resolve", refused.stderr)

    def test_previous_digest_is_pulled_and_bound_to_running_image_before_stop(self) -> None:
        previous = "ghcr.io/example/arm-rental@sha256:" + "a" * 64
        running_id = "sha256:" + "b" * 64
        metadata = self.root / "previous.json"
        metadata.write_text(json.dumps({"runtime": "rust"}))
        trace = self.root / "retain-trace"
        self.environment["RENTAL_TEST_TRACE"] = str(trace)
        self.environment["RENTAL_TEST_PREVIOUS"] = previous
        self.environment["RENTAL_TEST_RUNNING_ID"] = running_id
        script = r'''
          docker() {
            printf '%s:%s\n' "$1" "$2" >> "$RENTAL_TEST_TRACE"
            if [[ $1 == inspect ]]; then
              printf '%s\n' "$RENTAL_TEST_RUNNING_ID"
            elif [[ $1 == pull ]]; then
              : >"$RENTAL_TEST_TRACE.pulled"
            elif [[ $1 == image && $2 == inspect ]]; then
              [[ -f $RENTAL_TEST_TRACE.pulled ]] || return 91
              if [[ $3 == --format && $4 == '{{.Id}}' ]]; then
                if [[ ${RENTAL_TEST_MISMATCH:-0} == 1 ]]; then
                  printf 'sha256:%064d\n' 0
                else
                  printf '%s\n' "$RENTAL_TEST_RUNNING_ID"
                fi
              else
                printf '["%s"]\n' "$RENTAL_TEST_PREVIOUS"
              fi
            else
              return 97
            fi
          }
          ops_runtime() { printf 'rust\n'; }
          deployment_retain_previous_image "$1" "$2"
        '''
        accepted = self.bash(script, previous, str(metadata))
        self.assertEqual(accepted.returncode, 0, accepted.stderr)
        calls = trace.read_text().splitlines()
        self.assertEqual(calls[:4], ["inspect:--format", "pull:" + previous,
                                     "image:inspect", "image:inspect"])
        (self.root / "retain-trace.pulled").unlink()
        self.environment["RENTAL_TEST_MISMATCH"] = "1"
        refused = self.bash(script, previous, str(metadata))
        self.assertEqual(refused.returncode, 65, refused.stderr)
        self.assertIn("does not match", refused.stderr)
        deploy = (ROOT / "ops/deploy").read_text()
        self.assertLess(deploy.index("retain-previous-image"),
                        deploy.index("ops_stop_application"))

    def test_reconciliation_attempts_are_bounded_by_time_window(self) -> None:
        state = self.root / "state"
        state.mkdir()
        script = '''
          deployment_record_reconcile_attempt 100
          deployment_record_reconcile_attempt 200
          deployment_record_reconcile_attempt 3900
          deployment_reconcile_attempts 4000
        '''
        result = self.bash(script)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "1")
        index = json.loads((state / "reconcile.json").read_text())
        self.assertEqual(index["attempts"], [3900])
        (state / "reconcile.json").write_text("{not json")
        corrupt = self.bash("deployment_reconcile_attempts 4000")
        self.assertEqual(corrupt.returncode, 0, corrupt.stderr)
        self.assertEqual(corrupt.stdout.strip(), "0")

    def test_reconciliation_distinguishes_starting_from_dead_service(self) -> None:
        script = '''
          docker() {
            [[ $1 == inspect ]] || return 97
            [[ $RENTAL_TEST_STATE != missing ]] || return 1
            printf '%s\\n' "$RENTAL_TEST_STATE"
          }
          if deployment_service_is_live; then printf live; else printf dead; fi
        '''
        for state in ("healthy", "running", "starting", "unhealthy", "stopped", "missing"):
            self.environment["RENTAL_TEST_STATE"] = state
            result = self.bash(script)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(),
                             "live" if state in ("healthy", "running", "starting") else "dead")
        deploy = (ROOT / "ops/deploy").read_text()
        self.assertLess(deploy.index("deployment_service_is_live"),
                        deploy.index("deployment_reconcile_attempts"))
        self.assertIn("deployment_emit_reconcile_alert", deploy)

    def test_first_install_volume_allows_only_source_cookie_before_state_creation(self) -> None:
        mount = self.root / "volume-data"
        mount.mkdir()
        marker = self.root / "volume-created"
        self.environment["RENTAL_TEST_VOLUME_MOUNT"] = str(mount)
        self.environment["RENTAL_TEST_VOLUME_MARKER"] = str(marker)
        script = r'''
          source ops/lib/common.sh
          docker() {
            if [[ $1 == volume && $2 == inspect && $3 == rental-apartments-data ]]; then
              [[ -f $RENTAL_TEST_VOLUME_MARKER ]]
              return
            fi
            if [[ $1 == volume && $2 == create ]]; then
              touch "$RENTAL_TEST_VOLUME_MARKER"
              return
            fi
            if [[ $1 == volume && $2 == inspect && $3 == --format ]]; then
              if [[ $4 == *Mountpoint* ]]; then
                printf '%s\n' "$RENTAL_TEST_VOLUME_MOUNT"
              else
                printf '%s\n' 'rental-apartments-data|local|rental-apartments|rental-apartments-data'
              fi
              return
            fi
            return 97
          }
          deployment_validate_first_install_storage
        '''
        empty = self.bash(script)
        self.assertEqual(empty.returncode, 0, empty.stderr)
        self.assertTrue(marker.exists())
        (mount / "list-am-cookies.txt").write_text("source identity\n")
        cookies = self.bash(script)
        self.assertEqual(cookies.returncode, 0, cookies.stderr)
        (mount / "unexpected-state").write_text("must fail\n")
        unexpected = self.bash(script)
        self.assertNotEqual(unexpected.returncode, 0)
        self.assertIn("source-cookie-only", unexpected.stderr)
        (mount / "unexpected-state").unlink()
        (mount / "list-am-cookies.txt").unlink()
        (mount / "list-am-cookies.txt").symlink_to("elsewhere")
        linked = self.bash(script)
        self.assertNotEqual(linked.returncode, 0)


if __name__ == "__main__":
    unittest.main()

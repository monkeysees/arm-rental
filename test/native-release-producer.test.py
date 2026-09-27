"""Integration checks for the Cargo-only production release producer.

Fixtures use an isolated Git repository and synthetic image references. The
positive path uses real Docker files and labels; it never contacts production.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from unittest import mock
import uuid


PROJECT = Path(__file__).resolve().parents[1]
PRODUCER = PROJECT / "scripts/native-release.py"
SOURCE_FILES = (
    "Dockerfile.native",
    "compose.production.yaml",
    "ops/compose.native.yaml",
    "experiments/rust-replay/Cargo.toml",
    "experiments/rust-replay/Cargo.lock",
    "scripts/install-curl-impersonate",
    "scripts/curl-impersonate-version",
    "experiments/production-image/assemble",
    "experiments/production-image/licenses",
)


def run(*args: str | Path, cwd: Path, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(argument) for argument in args],
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        check=False,
        timeout=1200,
    )


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class NativeReleaseProducerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="native-release-producer-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repository = self.root / "source"
        self.repository.mkdir()
        paths = list(SOURCE_FILES)
        paths.extend(
            str(path.relative_to(PROJECT))
            for path in (PROJECT / "experiments/rust-replay/src").rglob("*")
            if path.is_file()
        )
        for relative in paths:
            destination = self.repository / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(PROJECT / relative, destination)
        shutil.copytree(PROJECT / "ops", self.repository / "ops", dirs_exist_ok=True)
        shutil.copytree(PROJECT / "infra/systemd", self.repository / "infra/systemd")
        self.source_paths = set(paths)
        self.assertEqual(run("git", "init", "--quiet", cwd=self.repository).returncode, 0)
        self.assertEqual(run("git", "add", ".", cwd=self.repository).returncode, 0)
        self.identity = {
            **os.environ,
            "GIT_AUTHOR_NAME": "Release fixture",
            "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
            "GIT_COMMITTER_NAME": "Release fixture",
            "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
        }
        committed = run("git", "commit", "--quiet", "-m", "fixture", cwd=self.repository, env=self.identity)
        self.assertEqual(committed.returncode, 0, committed.stderr)
        revision = run("git", "rev-parse", "HEAD", cwd=self.repository)
        self.assertEqual(revision.returncode, 0, revision.stderr)
        self.revision = revision.stdout.strip()
        self.work = self.root / "work"
        self.tag = f"arm-rental-native-producer-test:{uuid.uuid4().hex[:12]}"

    def producer(self, *args: str | Path, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        return run("python3", PRODUCER, *args, cwd=self.repository, env=env)

    def build(
        self,
        revision: str | None = None,
        work: Path | None = None,
        env: dict[str, str] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        return self.producer(
            "build",
            "--source-revision", revision or self.revision,
            "--work-dir", work or self.work,
            "--image-tag", self.tag,
            env=env,
        )

    def no_docker_environment(self) -> tuple[dict[str, str], Path]:
        executable = self.root / "reject-bin/docker"
        executable.parent.mkdir(exist_ok=True)
        executable.write_text(
            "#!/usr/bin/env python3\n"
            "import os\n"
            "from pathlib import Path\n"
            "Path(os.environ['DOCKER_MARKER']).touch()\n"
            "raise SystemExit(99)\n"
        )
        executable.chmod(0o755)
        marker = self.root / "docker-called"
        return {**os.environ, "PATH": f"{executable.parent}:{os.environ['PATH']}", "DOCKER_MARKER": str(marker)}, marker

    def assert_preflight_rejected(self, result: subprocess.CompletedProcess[str], marker: Path) -> None:
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertFalse(marker.exists(), f"invalid source reached Docker: {result.stderr}")

    def test_build_rejects_revision_mismatch_before_docker(self) -> None:
        environment, marker = self.no_docker_environment()
        result = self.build(revision="0" * 40, env=environment)
        self.assert_preflight_rejected(result, marker)

    def test_build_stages_committed_bytes_even_when_worktree_is_dirty(self) -> None:
        source = self.repository / "experiments/rust-replay/src/lib.rs"
        source.write_bytes(source.read_bytes() + b"\n// uncommitted fixture edit\n")
        untracked = self.repository / "package-lock.json"
        untracked.write_text('{"synthetic":true}\n')
        environment, marker = self.no_docker_environment()
        result = self.build(env=environment)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertTrue(marker.exists(), "valid committed source should reach Docker")
        staged = self.work / "context/experiments/rust-replay/src/lib.rs"
        committed = run("git", "show", "HEAD:experiments/rust-replay/src/lib.rs", cwd=self.repository)
        self.assertEqual(staged.read_bytes(), committed.stdout.encode())
        self.assertNotEqual(staged.read_bytes(), source.read_bytes())
        self.assertFalse((self.work / "context/package-lock.json").exists())
        self.assertNotIn("package-lock.json", (self.work / "source-inputs.json").read_text())

    def test_build_rejects_missing_required_source(self) -> None:
        (self.repository / "scripts/curl-impersonate-version").unlink()
        removed = run("git", "add", "-u", cwd=self.repository, env=self.identity)
        self.assertEqual(removed.returncode, 0, removed.stderr)
        committed = run("git", "commit", "--quiet", "-m", "remove required source", cwd=self.repository, env=self.identity)
        self.assertEqual(committed.returncode, 0, committed.stderr)
        self.revision = run("git", "rev-parse", "HEAD", cwd=self.repository).stdout.strip()
        environment, marker = self.no_docker_environment()
        result = self.build(env=environment)
        self.assert_preflight_rejected(result, marker)

    def test_build_rejects_tracked_cargo_build_script_before_docker(self) -> None:
        build_script = self.repository / "experiments/rust-replay/build.rs"
        build_script.write_text("fn main() {}\n")
        staged = run("git", "add", "experiments/rust-replay/build.rs", cwd=self.repository, env=self.identity)
        self.assertEqual(staged.returncode, 0, staged.stderr)
        committed = run("git", "commit", "--quiet", "-m", "add Cargo build script", cwd=self.repository, env=self.identity)
        self.assertEqual(committed.returncode, 0, committed.stderr)
        self.revision = run("git", "rev-parse", "HEAD", cwd=self.repository).stdout.strip()
        environment, marker = self.no_docker_environment()
        result = self.build(env=environment)
        self.assert_preflight_rejected(result, marker)

    def test_transport_rejects_library_outside_host_contract_before_docker(self) -> None:
        specification = importlib.util.spec_from_file_location("native_release_producer", PRODUCER)
        self.assertIsNotNone(specification)
        self.assertIsNotNone(specification.loader)
        producer = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(producer)
        libraries = b"/lib64/ld-linux-x86-64.so.2\n/usr/local/lib/libbad.so\n"
        with mock.patch.object(producer, "call", side_effect=AssertionError("Docker was called")) as docker_call:
            with self.assertRaisesRegex(producer.ReleaseError, "outside the host transport contract"):
                producer.closure_paths("synthetic-rust-image", libraries)
            docker_call.assert_not_called()

    def no_node_environment(self) -> tuple[dict[str, str], Path]:
        directory = self.root / "reject-node-bin"
        directory.mkdir()
        marker = self.root / "node-or-npm-called"
        for name in ("node", "npm"):
            executable = directory / name
            executable.write_text(
                "#!/usr/bin/env python3\n"
                "import os\n"
                "from pathlib import Path\n"
                "Path(os.environ['NODE_MARKER']).touch()\n"
                "raise SystemExit(99)\n"
            )
            executable.chmod(0o755)
        return {**os.environ, "PATH": f"{directory}:{os.environ['PATH']}", "NODE_MARKER": str(marker)}, marker

    def digest_environment(
        self, reference: str, image_id: str, base_environment: dict[str, str]
    ) -> dict[str, str]:
        real_docker = shutil.which("docker")
        self.assertIsNotNone(real_docker, "real Docker is required for producer integration")
        executable = self.root / "digest-bin/docker"
        executable.parent.mkdir(exist_ok=True)
        executable.write_text(
            "#!/usr/bin/env python3\n"
            "import json\n"
            "import os\n"
            "import subprocess\n"
            "import sys\n"
            "arguments = sys.argv[1:]\n"
            "current = os.environ.get('GATE_IMAGE_REF')\n"
            "if current and current in arguments:\n"
            "    if arguments[:2] == ['image', 'inspect'] and '{{json .}}' in arguments:\n"
            "        print(json.dumps({'Id': os.environ['GATE_IMAGE_ID'], 'RepoDigests': [current], 'Config': {'Labels': {'org.opencontainers.image.revision': os.environ['GATE_REVISION'], 'com.rental-apartments.runtime': 'rust'}}}))\n"
            "    elif arguments[:2] == ['image', 'inspect']:\n"
            "        print(os.environ['GATE_PACKAGE_SHA'])\n"
            "    elif arguments[0] == 'inspect':\n"
            "        print('rust')\n"
            "    else:\n"
            "        raise SystemExit(90)\n"
            "    raise SystemExit(0)\n"
            "reference = os.environ['FIXTURE_DIGEST_REF']\n"
            "mapped = [os.environ['FIXTURE_IMAGE_ID'] if arg == reference else arg for arg in arguments]\n"
            "result = subprocess.run([os.environ['REAL_DOCKER'], *mapped], capture_output=True)\n"
            "if arguments[:2] == ['image', 'inspect'] and '{{json .}}' in arguments and reference in arguments and result.returncode == 0:\n"
            "    document = json.loads(result.stdout)\n"
            "    document['RepoDigests'] = sorted(set(document.get('RepoDigests') or []) | {reference})\n"
            "    result.stdout = (json.dumps(document) + '\\n').encode()\n"
            "sys.stdout.buffer.write(result.stdout)\n"
            "sys.stderr.buffer.write(result.stderr)\n"
            "raise SystemExit(result.returncode)\n"
        )
        executable.chmod(0o755)
        return {
            **base_environment,
            "PATH": f"{executable.parent}:{base_environment['PATH']}",
            "REAL_DOCKER": real_docker,
            "FIXTURE_DIGEST_REF": reference,
            "FIXTURE_IMAGE_ID": image_id,
        }

    def operations_archive(self) -> Path:
        archive = self.root / "operations.tar"
        with archive.open("wb") as output:
            result = subprocess.run(
                ["git", "archive", "--format=tar", self.revision, "ops", "infra/systemd"],
                cwd=self.repository,
                stdout=output,
                stderr=subprocess.PIPE,
                check=False,
            )
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        return archive

    def exercise_v2_gate(self, candidate_summary: Path, environment: dict[str, str]) -> None:
        """A retained v2 Rust image can roll back manually, but cannot publish Rust-only."""
        image_id = "sha256:" + "d" * 64
        reference = f"fixture.local/arm-rental@{image_id}"
        bundle = self.root / "current-v2"
        bundle.mkdir()
        (bundle / "package-lock.json").write_text('{"lockfileVersion":3}\n')
        shutil.copy2(self.repository / "compose.production.yaml", bundle / "compose.production.yaml")
        shutil.copy2(self.operations_archive(), bundle / "operations.tar")
        metadata = {
            "schemaVersion": 2,
            "runtime": "rust",
            "sourceRevision": self.revision,
            "imageReference": reference,
            "imageDigest": image_id,
            "stateBackend": "sqlite",
            "minimumStateSchema": 1,
            "maximumStateSchema": 6,
            "deployableStateBackends": ["sqlite"],
            "deployableRuntimes": ["node", "rust"],
            "deployableProvenanceContracts": ["legacy-package-lock-v2", "cargo-source-v3"],
            "packageLockSha256": sha256(bundle / "package-lock.json"),
            "composeSha256": sha256(bundle / "compose.production.yaml"),
            "operationsBundleSha256": sha256(bundle / "operations.tar"),
        }
        (bundle / "release-metadata.json").write_text(json.dumps(metadata) + "\n")
        environment.update({
            "GATE_IMAGE_ID": image_id,
            "GATE_IMAGE_REF": reference,
            "GATE_REVISION": self.revision,
            "GATE_PACKAGE_SHA": metadata["packageLockSha256"],
        })
        rejected = self.producer(
            "gate", "--current-image", reference,
            "--current-bundle", bundle,
            "--retirement-receipt-record", self.root / "absent-bridge-receipt.json",
            "--candidate-summary", candidate_summary,
            env=environment,
        )
        self.assertNotEqual(rejected.returncode, 0, "v2 host cannot verify Rust-only metadata")
        self.assertIn("requires the deployed Cargo verifier bridge", rejected.stderr)

    def test_real_docker_build_metadata_and_verify_bind_exact_payload(self) -> None:
        if not shutil.which("docker"):
            self.skipTest("Docker is unavailable")
        available = run("docker", "info", "--format", "{{.ServerVersion}}", cwd=self.repository)
        if available.returncode:
            self.skipTest("Docker daemon is unavailable")
        self.addCleanup(
            lambda: run("docker", "image", "rm", "--force", self.tag, f"{self.tag}-payload", cwd=self.repository)
        )
        # Neither an untracked Node lockfile nor a dirty Rust source file may
        # enter the Git-object build context.
        (self.repository / "package-lock.json").write_text('{"synthetic":true}\n')
        dirty_source = self.repository / "experiments/rust-replay/src/lib.rs"
        dirty_source.write_bytes(dirty_source.read_bytes() + b"\n// worktree only\n")
        node_free_environment, node_marker = self.no_node_environment()
        built = self.build(env=node_free_environment)
        self.assertEqual(built.returncode, 0, built.stderr[-5000:])
        summary = json.loads((self.work / "build-summary.json").read_text())
        self.assertEqual(summary["sourceRevision"], self.revision)
        self.assertEqual(summary["imageTag"], self.tag)
        self.assertEqual(sha256(self.work / "source-inputs.json"), summary["sourceInputsSha256"])
        self.assertEqual(sha256(self.work / "transport-files.json"), summary["transportClosureSha256"])
        source_manifest = json.loads((self.work / "source-inputs.json").read_text())
        self.assertEqual([entry["path"] for entry in source_manifest["files"]], sorted(self.source_paths))
        self.assertFalse((self.work / "context/package-lock.json").exists())
        self.assertEqual(
            (self.work / "context/experiments/rust-replay/src/lib.rs").read_bytes(),
            run("git", "show", "HEAD:experiments/rust-replay/src/lib.rs", cwd=self.repository).stdout.encode(),
        )
        with tarfile.open(self.work / "source-inputs.tar") as archive:
            self.assertEqual(archive.getnames(), sorted(self.source_paths))
            self.assertTrue(all(member.isfile() for member in archive.getmembers()))
            for entry in source_manifest["files"]:
                self.assertEqual(
                    hashlib.sha256(archive.extractfile(entry["path"]).read()).hexdigest(),
                    entry["sha256"],
                )
        image_id = summary["imageId"]
        reference = f"fixture.local/arm-rental@{image_id}"
        environment = self.digest_environment(reference, image_id, node_free_environment)
        archive = self.operations_archive()

        source_manifest_path = self.work / "source-inputs.json"
        original_source_manifest = source_manifest_path.read_bytes()
        altered = dict(source_manifest)
        altered["files"] = [*source_manifest["files"], {"path": "package-lock.json", "sha256": "0" * 64}]
        source_manifest_path.write_text(json.dumps(altered, sort_keys=True, separators=(",", ":")) + "\n")
        rejected_extra = self.producer(
            "metadata", "--source-revision", self.revision,
            "--work-dir", self.work, "--image-reference", reference,
            "--operations-bundle", archive, "--output-dir", self.root / "rejected-extra",
            env=environment,
        )
        self.assertNotEqual(rejected_extra.returncode, 0, "extra source manifest entry was accepted")
        source_manifest_path.write_bytes(original_source_manifest)

        transport_path = self.work / "transport-files.json"
        original_transport = transport_path.read_bytes()
        transport = json.loads(original_transport)
        transport["files"][0]["sha256"] = "0" * 64
        transport_path.write_text(json.dumps(transport, sort_keys=True, separators=(",", ":")) + "\n")
        rejected_transport = self.producer(
            "metadata", "--source-revision", self.revision,
            "--work-dir", self.work, "--image-reference", reference,
            "--operations-bundle", archive, "--output-dir", self.root / "rejected-transport",
            env=environment,
        )
        self.assertNotEqual(rejected_transport.returncode, 0, "transport digest mismatch was accepted")
        transport_path.write_bytes(original_transport)

        bundle = self.root / "bundle"
        published = self.producer(
            "metadata", "--source-revision", self.revision,
            "--work-dir", self.work, "--image-reference", reference,
            "--operations-bundle", archive, "--output-dir", bundle,
            env=environment,
        )
        self.assertEqual(published.returncode, 0, published.stderr[-5000:])
        verified = self.producer("verify", "--image-reference", reference, "--bundle", bundle, env=environment)
        self.assertEqual(verified.returncode, 0, verified.stderr[-5000:])
        self.exercise_v2_gate(self.work / "build-summary.json", environment)
        v3_gate = self.producer(
            "gate", "--current-image", reference, "--current-bundle", bundle,
            "--retirement-receipt-record", self.root / "absent-bridge-receipt.json",
            "--candidate-summary", self.work / "build-summary.json", env=environment,
        )
        self.assertEqual(v3_gate.returncode, 0, v3_gate.stderr[-5000:])
        self.assertEqual(v3_gate.stdout.strip(), "cutover=false")
        metadata = json.loads((bundle / "release-metadata.json").read_text())
        self.assertEqual(metadata["imageReference"], reference)
        self.assertEqual(metadata["deployableRuntimes"], ["rust"])
        self.assertNotIn("packageLockSha256", metadata)

        # Exercise the first capability contraction with real image inspection,
        # archived host verifier bytes, and the same release verification path.
        transitional = self.root / "transitional-current"
        shutil.copytree(bundle, transitional)
        transitional_metadata = {**metadata, "deployableRuntimes": ["node", "rust"]}
        (transitional / "release-metadata.json").write_text(json.dumps(transitional_metadata) + "\n")
        with tarfile.open(archive) as operations:
            helper_hashes = {
                name: hashlib.sha256(operations.extractfile(f"ops/lib/{name}").read()).hexdigest()
                for name in ("deployment.sh", "provenance.sh")
            }
        accepted_bridge = self.root / "accepted-bridge.json"
        accepted_bridge.write_text(json.dumps({
            "schemaVersion": 1, "sourceRevision": self.revision,
            "imageReference": reference,
            "host": {"sourceRevision": self.revision, "imageReference": reference,
                     "observedAt": "2026-09-27T21:03:00Z"},
            "receipt": {"name": f"20260927T210000Z-success-{image_id.split(':')[1][:16]}.json",
                        "sha256": "c" * 64, "outcome": "success",
                        "completedAt": "2026-09-27T21:00:00Z",
                        "snapshot": "daily/2026-09-27T20-59-00Z",
                        "sourceRevision": self.revision, "candidateImage": reference},
            "acceptedAt": "2026-09-27T21:04:00Z",
            "archivedVerifierSha256": helper_hashes,
        }) + "\n")
        held = self.producer(
            "gate", "--current-image", reference, "--current-bundle", transitional,
            "--retirement-receipt-record", accepted_bridge,
            "--candidate-summary", self.work / "build-summary.json", env=environment,
        )
        self.assertEqual(held.returncode, 0, held.stderr[-5000:])
        self.assertEqual(held.stdout.strip(), "cutover=true")
        self.assertEqual((bundle / "operations.tar").read_bytes(), archive.read_bytes())
        self.assertEqual((bundle / "source-inputs.json").read_bytes(), original_source_manifest)
        self.assertEqual((bundle / "transport-files.json").read_bytes(), original_transport)

        forged = self.root / "forged-bundle"
        shutil.copytree(bundle, forged)
        forged_metadata_path = forged / "release-metadata.json"
        forged_metadata = json.loads(forged_metadata_path.read_text())
        forged_metadata["binarySha256"] = "0" * 64
        forged_metadata_path.write_text(json.dumps(forged_metadata) + "\n")
        rejected_digest = self.producer("verify", "--image-reference", reference, "--bundle", forged, env=environment)
        self.assertNotEqual(rejected_digest.returncode, 0, "forged image digest was accepted")
        self.assertFalse(node_marker.exists(), "native release producer invoked host Node or npm")


if __name__ == "__main__":
    unittest.main()

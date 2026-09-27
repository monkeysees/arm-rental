"""Fast host-verifier rejection checks for the Cargo/source-input contract."""

from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
IMAGE = "ghcr.io/example/arm-rental@sha256:" + "a" * 64
REVISION = "b" * 40


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(document: dict) -> bytes:
    return (json.dumps(document, sort_keys=True, separators=(",", ":")) + "\n").encode()


def archive(files: dict[str, bytes], path: Path) -> None:
    with tarfile.open(path, "w") as output:
        for name, content in sorted(files.items()):
            member = tarfile.TarInfo(name)
            member.size = len(content)
            member.mode = 0o755 if name == "ops/service" else 0o644
            output.addfile(member, io.BytesIO(content))


class NativeProvenanceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="native-provenance-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.bundle = self.root / "bundle"
        self.image_root = self.root / "image"
        self.bin = self.root / "bin"
        for directory in (self.bundle, self.image_root, self.bin, self.root / "state"):
            directory.mkdir()
        self.sources = {
            "Dockerfile.native": b"FROM rust:1.94.0-bookworm@sha256:" + b"f" * 64 + b" AS build\n",
            "compose.production.yaml": b"services: {bot: {}}\n",
            "experiments/rust-replay/Cargo.toml": b"[package]\nname='example'\n",
            "experiments/rust-replay/Cargo.lock": b"# locked crates\n",
            "experiments/rust-replay/src/main.rs": b"fn main() {}\n",
            "experiments/rust-replay/src/production/configuration.json": b"{}\n",
            "experiments/rust-replay/src/production/storage/001.sql": b"CREATE TABLE example (id INTEGER);\n",
            "experiments/production-image/assemble": b"#!/bin/bash\n",
            "experiments/production-image/licenses": b"#!/bin/bash\n",
            "ops/compose.native.yaml": b"services: {bot: {user: '1000:1000'}}\n",
            "scripts/install-curl-impersonate": b"#!/bin/bash\n",
            "scripts/curl-impersonate-version": b"# pinned\nCURL_IMPERSONATE_VERSION=2.2.2\n",
        }
        self.transport = {
            "etc/nsswitch.conf": b"hosts: files dns\n",
            "etc/ssl/certs/ca-certificates.crt": b"certificate\n",
            "lib/x86_64-linux-gnu/libssl.so.3": b"library\n",
            "lib64/ld-linux-x86-64.so.2": b"dynamic loader\n",
            "usr/local/bin/curl-impersonate": b"curl executable\n",
        }
        self.source_manifest = self.manifest("source-inputs", self.sources)
        self.transport_manifest = self.manifest("transport-files", self.transport)
        (self.bundle / "source-inputs.json").write_bytes(self.source_manifest)
        (self.bundle / "transport-files.json").write_bytes(self.transport_manifest)
        (self.bundle / "compose.production.yaml").write_bytes(self.sources["compose.production.yaml"])
        archive(self.sources, self.image_root / "usr.local.source.tar")
        self.put_image("usr/local/share/native-image/source-inputs.tar",
                       (self.image_root / "usr.local.source.tar").read_bytes())
        self.put_image("usr/local/share/licenses/rental-app/Cargo.lock",
                       self.sources["experiments/rust-replay/Cargo.lock"])
        self.put_image("usr/local/bin/rental-app", b"Rust executable\n")
        self.put_image("usr/local/share/native-image/libraries.txt",
                       b"/lib/x86_64-linux-gnu/libssl.so.3\n/lib64/ld-linux-x86-64.so.2\n")
        for name, content in self.transport.items():
            self.put_image(name, content)
        operations = {
            "ops/compose.native.yaml": self.sources["ops/compose.native.yaml"],
            "ops/service": b"#!/bin/bash\n",
            "ops/lib/provenance.sh": (ROOT / "ops/lib/provenance.sh").read_bytes(),
            "infra/systemd/bot.service": b"[Unit]\n",
        }
        archive(operations, self.bundle / "operations.tar")
        self.metadata = {
            "schemaVersion": 3, "provenanceKind": "cargo-source-v1",
            "runtime": "rust", "sourceDirty": False, "rustVersion": "1.94.0",
            "curlImpersonateVersion": "2.2.2",
            "deployableStateBackends": ["sqlite"], "deployableRuntimes": ["rust"],
            "cutoverRollbackContract": "preserve-live-state-v1",
            "deployableProvenanceContracts": ["legacy-package-lock-v2", "cargo-source-v3"],
            "imageReference": IMAGE, "imageDigest": IMAGE.split("@", 1)[1],
            "sourceRevision": REVISION, "stateBackend": "sqlite",
            "minimumStateSchema": 1, "maximumStateSchema": 6,
            "cargoLockSha256": digest(self.sources["experiments/rust-replay/Cargo.lock"]),
            "sourceInputsSha256": digest(self.source_manifest),
            "binarySha256": digest(b"Rust executable\n"),
            "curlSha256": digest(self.transport["usr/local/bin/curl-impersonate"]),
            "transportClosureSha256": digest(self.transport_manifest),
            "composeSha256": digest(self.sources["compose.production.yaml"]),
            "operationsBundleSha256": digest((self.bundle / "operations.tar").read_bytes()),
        }
        self.metadata_path = self.bundle / "release-metadata.json"
        self.write_metadata()
        self.put_image("usr/local/share/native-image/components.json", canonical({
            "binarySha256": self.metadata["binarySha256"],
            "cargoLockSha256": self.metadata["cargoLockSha256"],
            "curlImpersonateVersion": self.metadata["curlImpersonateVersion"],
            "curlSha256": self.metadata["curlSha256"], "runtime": "rust",
            "sourceDirty": False, "sourceInputsSha256": self.metadata["sourceInputsSha256"],
            "sourceRevision": REVISION, "toolchain": self.metadata["rustVersion"],
            "transportClosureSha256": self.metadata["transportClosureSha256"],
        }))
        self.labels = {
            "org.opencontainers.image.revision": REVISION,
            "com.rental-apartments.runtime": "rust",
            "com.rental-apartments.source.dirty": "false",
            "com.rental-apartments.rust-version": "1.94.0",
            "com.rental-apartments.curl-version": "2.2.2",
            "com.rental-apartments.state.backend": "sqlite",
            "com.rental-apartments.state.schema.minimum": "1",
            "com.rental-apartments.state.schema.maximum": "6",
            "com.rental-apartments.cargo-lock.sha256": self.metadata["cargoLockSha256"],
            "com.rental-apartments.source-inputs.sha256": self.metadata["sourceInputsSha256"],
            "com.rental-apartments.binary.sha256": self.metadata["binarySha256"],
            "com.rental-apartments.curl.sha256": self.metadata["curlSha256"],
            "com.rental-apartments.transport-closure.sha256": self.metadata["transportClosureSha256"],
        }
        self.labels_path = self.root / "labels.json"
        self.write_labels()
        docker = self.bin / "docker"
        docker.write_text(r'''#!/usr/bin/env python3
import json, os, re, shutil, sys
from pathlib import Path
args = sys.argv[1:]
labels = json.loads(Path(os.environ["FAKE_LABELS"]).read_text())
if args[0] == "inspect":
    print(labels.get("com.rental-apartments.runtime", ""))
elif args[:2] == ["image", "inspect"]:
    template = args[3]
    if template == "{{json .Config.Labels}}": print(json.dumps(labels))
    else:
        key = re.search(r'index .Config.Labels "([^"]+)"', template)
        if not key: sys.exit(97)
        print(labels.get(key.group(1), ""))
elif args[0] == "create":
    print("fake-container")
elif args[0] == "cp":
    source = args[1].split(":", 1)[1].lstrip("/")
    shutil.copyfile(Path(os.environ["FAKE_IMAGE_ROOT"]) / source, args[2])
elif args[0] == "rm":
    pass
else:
    sys.exit(97)
''')
        docker.chmod(0o755)
        self.environment = {**os.environ, "PATH": f"{self.bin}:{os.environ['PATH']}",
                            "FAKE_LABELS": str(self.labels_path),
                            "FAKE_IMAGE_ROOT": str(self.image_root),
                            "RENTAL_OPS_STATE_DIR": str(self.root / "state"),
                            "DEPLOYMENT_SOURCE_REVISION": REVISION,
                            "PYTHONDONTWRITEBYTECODE": "1"}

    @staticmethod
    def manifest(kind: str, files: dict[str, bytes]) -> bytes:
        return canonical({"schemaVersion": 1, "kind": kind,
                          "files": [{"path": name, "sha256": digest(content)}
                                    for name, content in sorted(files.items())]})

    def put_image(self, name: str, data: bytes) -> None:
        path = self.image_root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def write_metadata(self) -> None:
        self.metadata_path.write_bytes(canonical(self.metadata))

    def write_labels(self) -> None:
        self.labels_path.write_bytes(canonical(self.labels))

    def verify(self) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["bash", "-c", 'set -Eeuo pipefail; source ops/lib/deployment.sh; '
             'deployment_verify_release "$1" "$2" "$3"', "provenance-test",
             str(self.bundle), IMAGE, str(self.metadata_path)],
            cwd=ROOT, env=self.environment, text=True, capture_output=True,
            check=False, timeout=30,
        )

    def assert_refused(self) -> None:
        result = self.verify()
        self.assertEqual(result.returncode, 65, result.stderr)

    def test_valid_rust_only_payload_and_metadata_matrix(self) -> None:
        valid = self.verify()
        self.assertEqual(valid.returncode, 0, valid.stderr)
        original = dict(self.metadata)
        mutations = (
            {"packageLockSha256": "f" * 64}, {"provenanceKind": "unknown"},
            {"runtime": "node"}, {"rustVersion": "0.0.0"},
            {"curlImpersonateVersion": "0.0.0"}, {"sourceDirty": True},
            {"deployableStateBackends": ["json"]},
            {"deployableRuntimes": ["node"]},
            {"deployableRuntimes": ["rust", "node"]},
            {"deployableRuntimes": ["rust", "unknown"]},
            {"deployableRuntimes": []}, {"cutoverRollbackContract": "unknown"},
            {"cargoLockSha256": "f" * 64}, {"sourceInputsSha256": "f" * 64},
            {"binarySha256": "f" * 64}, {"curlSha256": "f" * 64},
            {"transportClosureSha256": "f" * 64}, {"minimumStateSchema": 0},
            {"composeSha256": "f" * 64}, {"operationsBundleSha256": "f" * 64},
            {"unknownProvenanceClaim": "accepted"},
        )
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                self.metadata = {**original, **mutation}
                self.write_metadata()
                self.assert_refused()
        self.metadata = original
        self.write_metadata()

    def test_binary_label_transport_and_source_payload_tampering(self) -> None:
        cases = (
            ("usr/local/bin/rental-app", b"changed binary\n"),
            ("lib/x86_64-linux-gnu/libssl.so.3", b"changed library\n"),
            ("lib64/ld-linux-x86-64.so.2", b"damaged loader\n"),
        )
        for name, corrupted in cases:
            with self.subTest(image_file=name):
                path = self.image_root / name
                original = path.read_bytes()
                path.write_bytes(corrupted)
                self.assert_refused()
                path.write_bytes(original)
        self.labels["org.opencontainers.image.package-lock.sha256"] = ""
        self.write_labels()
        self.assert_refused()
        self.labels.pop("org.opencontainers.image.package-lock.sha256")
        self.write_labels()
        self.labels["com.rental-apartments.runtime"] = "node"
        self.write_labels()
        self.assert_refused()

        self.labels["com.rental-apartments.runtime"] = "rust"
        self.write_labels()
        source_tar = self.image_root / "usr/local/share/native-image/source-inputs.tar"
        original_tar = source_tar.read_bytes()
        for name in ("experiments/rust-replay/src/production/configuration.json",
                     "experiments/rust-replay/src/production/storage/001.sql"):
            with self.subTest(source_file=name):
                altered = dict(self.sources)
                altered[name] = b"tampered\n"
                archive(altered, source_tar)
                self.assert_refused()
        source_tar.write_bytes(original_tar)

        manifest = json.loads(self.source_manifest)
        manifest["files"] = [entry for entry in manifest["files"]
                             if entry["path"] != "Dockerfile.native"]
        damaged_manifest = canonical(manifest)
        (self.bundle / "source-inputs.json").write_bytes(damaged_manifest)
        self.metadata["sourceInputsSha256"] = digest(damaged_manifest)
        self.write_metadata()
        self.labels["com.rental-apartments.source-inputs.sha256"] = digest(damaged_manifest)
        self.write_labels()
        self.assert_refused()

    def test_transition_requires_deployed_cargo_verifier_and_refuses_downgrade(self) -> None:
        legacy_image = "ghcr.io/example/arm-rental@sha256:" + "c" * 64
        legacy = {
            "schemaVersion": 2, "imageReference": legacy_image,
            "sourceRevision": "d" * 40, "stateBackend": "sqlite",
            "runtime": "rust", "minimumStateSchema": 1,
            "maximumStateSchema": 6,
            "deployableProvenanceContracts": ["legacy-package-lock-v2", "cargo-source-v3"],
        }
        legacy_path = self.root / "legacy.json"
        legacy_path.write_bytes(canonical(legacy))

        def transition(previous: Path, candidate: Path, old_image: str,
                       new_image: str) -> subprocess.CompletedProcess[str]:
            return subprocess.run(
                ["bash", "-c", 'set -Eeuo pipefail; source ops/lib/deployment.sh; '
                 'deployment_state_transition "$1" "$2" "$3" "$4"',
                 "provenance-transition", str(previous), str(candidate),
                 old_image, new_image], cwd=ROOT, env=self.environment,
                text=True, capture_output=True, check=False,
            )

        accepted = transition(legacy_path, self.metadata_path, legacy_image, IMAGE)
        self.assertEqual(accepted.returncode, 0, accepted.stderr)
        self.assertEqual(accepted.stdout.strip(), "sqlite-to-sqlite")
        no_capability = dict(legacy)
        no_capability.pop("deployableProvenanceContracts")
        legacy_path.write_bytes(canonical(no_capability))
        missing = transition(legacy_path, self.metadata_path, legacy_image, IMAGE)
        self.assertEqual(missing.returncode, 65, missing.stderr)
        self.assertIn("cannot verify Cargo", missing.stderr)
        legacy_path.write_bytes(canonical(legacy))
        downgrade = transition(self.metadata_path, legacy_path, IMAGE, legacy_image)
        self.assertEqual(downgrade.returncode, 65, downgrade.stderr)
        self.assertIn("downgrade", downgrade.stderr)
        dropped = self.root / "dropped.json"
        dropped.write_bytes(canonical(no_capability))
        removed = transition(legacy_path, dropped, legacy_image, legacy_image)
        self.assertEqual(removed.returncode, 65, removed.stderr)
        self.assertIn("removes the deployed Cargo", removed.stderr)
        deploy = (ROOT / "ops/deploy").read_text()
        self.assertLess(deploy.index("deployment_state_transition "),
                        deploy.index("ops_stop_application\n"))


if __name__ == "__main__":
    unittest.main()

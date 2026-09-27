"""Fast receipt and pointer checks for the Rust-only publication boundary."""

from __future__ import annotations

import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest import mock


SOURCE = Path(__file__).resolve().parents[1] / "scripts/native-release.py"
SPEC = importlib.util.spec_from_file_location("native_release", SOURCE)
assert SPEC and SPEC.loader
producer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(producer)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class RustOnlyPublicationGateTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="rust-only-gate-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.bundle = self.root / "current"
        self.bundle.mkdir()
        self.revision = "a" * 40
        self.image = f"fixture.local/arm-rental@sha256:{'b' * 64}"
        self.current = {
            "schemaVersion": 3,
            "provenanceKind": "cargo-source-v1",
            "runtime": "rust",
            "sourceRevision": self.revision,
            "imageReference": self.image,
            "deployableRuntimes": ["node", "rust"],
        }
        (self.bundle / "release-metadata.json").write_text(json.dumps(self.current))
        self.helpers = {
            "deployment.sh": b'candidate reintroduces retired Node runtime capability\n',
            "provenance.sh": b'.deployableRuntimes == ["rust"]\n',
        }
        with tarfile.open(self.bundle / "operations.tar", "w") as archive:
            for name, content in self.helpers.items():
                member = tarfile.TarInfo(f"ops/lib/{name}")
                member.size = len(content)
                archive.addfile(member, io.BytesIO(content))
        self.record_path = self.root / "receipt.json"
        self.record = {
            "schemaVersion": 1,
            "sourceRevision": self.revision,
            "imageReference": self.image,
            "host": {"sourceRevision": self.revision, "imageReference": self.image,
                     "observedAt": "2026-09-27T21:03:00Z"},
            "receipt": {"name": f"20260927T210000Z-success-{'b' * 16}.json",
                        "sha256": "c" * 64, "outcome": "success",
                        "completedAt": "2026-09-27T21:00:00Z",
                        "snapshot": "daily/2026-09-27T20-59-00Z",
                        "sourceRevision": self.revision, "candidateImage": self.image},
            "acceptedAt": "2026-09-27T21:04:00Z",
            "archivedVerifierSha256": {name: sha256(content) for name, content in self.helpers.items()},
        }
        self.record_path.write_text(json.dumps(self.record))
        inspect = {"RepoDigests": [self.image], "Config": {"Labels": {
            "org.opencontainers.image.revision": self.revision,
            "com.rental-apartments.runtime": "rust",
        }}}
        self.enterContext(mock.patch.object(producer, "verify"))
        self.enterContext(mock.patch.object(producer, "transition"))
        self.enterContext(mock.patch.object(producer, "image_inspect", return_value=inspect))

    def gate(self) -> bool:
        return producer.gate(self.image, self.bundle, self.record_path,
                             self.root / "candidate-summary.json", None)

    def test_first_rust_only_release_is_held_after_exact_host_acceptance(self) -> None:
        self.assertTrue(self.gate())
        self.current["deployableRuntimes"] = ["rust"]
        (self.bundle / "release-metadata.json").write_text(json.dumps(self.current))
        self.record_path.unlink()
        self.assertFalse(self.gate(), "subsequent Rust-only release should use normal pointer flow")

    def test_missing_mismatched_and_failed_host_acceptance_reject(self) -> None:
        self.record_path.unlink()
        with self.assertRaisesRegex(producer.ReleaseError, "receipt is missing"):
            self.gate()
        for field, value in (("imageReference", "fixture.local/other@sha256:" + "d" * 64),
                             ("sourceRevision", "d" * 40)):
            damaged = {**self.record, field: value}
            self.record_path.write_text(json.dumps(damaged))
            with self.assertRaises(producer.ReleaseError):
                self.gate()
        failed = json.loads(json.dumps(self.record))
        failed["receipt"]["outcome"] = "failed"
        self.record_path.write_text(json.dumps(failed))
        with self.assertRaises(producer.ReleaseError):
            self.gate()

    def test_archived_verifier_hash_and_content_must_match(self) -> None:
        damaged = json.loads(json.dumps(self.record))
        damaged["archivedVerifierSha256"]["deployment.sh"] = "d" * 64
        self.record_path.write_text(json.dumps(damaged))
        with self.assertRaisesRegex(producer.ReleaseError, "verifier hashes differ"):
            self.gate()
        damaged["archivedVerifierSha256"] = {name: sha256(content) for name, content in self.helpers.items()}
        self.record_path.write_text(json.dumps(damaged))
        self.helpers["provenance.sh"] = b"No Rust-only verifier predicate\n"
        with tarfile.open(self.bundle / "operations.tar", "w") as archive:
            for name, content in self.helpers.items():
                member = tarfile.TarInfo(f"ops/lib/{name}")
                member.size = len(content)
                archive.addfile(member, io.BytesIO(content))
        damaged["archivedVerifierSha256"]["provenance.sh"] = sha256(self.helpers["provenance.sh"])
        self.record_path.write_text(json.dumps(damaged))
        with self.assertRaisesRegex(producer.ReleaseError, "lack the reviewed"):
            self.gate()

    def test_legacy_v2_current_cannot_publish_rust_only(self) -> None:
        self.current["schemaVersion"] = 2
        (self.bundle / "release-metadata.json").write_text(json.dumps(self.current))
        with self.assertRaisesRegex(producer.ReleaseError, "requires the deployed Cargo verifier bridge"):
            self.gate()


if __name__ == "__main__":
    unittest.main()

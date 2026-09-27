"""Production image cleanup preserves exact rollback and unrelated images."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
CLEANUP = ROOT / "ops/image-cleanup"


def reference(character: str) -> str:
    return f"ghcr.io/example/arm-rental@sha256:{character * 64}"


def image_id(character: str) -> str:
    return f"sha256:{character * 64}"


class NativeImageRetentionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="native-image-retention-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.bin = self.root / "bin"
        self.state = self.root / "state"
        self.bin.mkdir()
        self.state.mkdir()
        self.ids = {name: image_id(character) for name, character in (
            ("current", "1"), ("previous", "2"), ("oldest", "3"), ("stale", "4"),
            ("current_metadata", "5"), ("previous_metadata", "6"),
            ("oldest_metadata", "7"), ("stale_metadata", "8"), ("unrelated", "9"),
        )}
        self.revisions = [character * 40 for character in "abcd"]
        (self.state / "current-image.env").write_text(f"RENTAL_APARTMENTS_IMAGE={reference('a')}\n")
        self.retention = self.state / "deployment-retention.json"
        self.retention.write_text(json.dumps({
            "schemaVersion": 2, "minimumRetainedReleases": 3,
            "retainedReleases": [
                {"candidateImage": reference(character), "sourceRevision": self.revisions[index],
                 "completedAt": f"2026-07-{27-index:02d}T12:00:00Z"}
                for index, character in enumerate("abc")
            ],
            "protectedReleases": [],
        }))

        def application(identifier: str, revision: str, character: str) -> dict:
            return {"Id": identifier, "Size": 1_000_000_000, "RepoTags": [],
                    "RepoDigests": [reference(character)], "Config": {"Labels": {
                        "org.opencontainers.image.title": "rental-apartments-bot",
                        "org.opencontainers.image.revision": revision}}}

        def metadata(identifier: str, revision: str) -> dict:
            return {"Id": identifier, "Size": 250_000,
                    "RepoTags": [f"ghcr.io/example/arm-rental:metadata-{revision}"],
                    "RepoDigests": [], "Config": {"Labels": {}}}

        inventory = [application(self.ids[name], self.revisions[index], character)
                     for index, (name, character) in enumerate((("current", "a"),
                                                                ("previous", "b"),
                                                                ("oldest", "c"), ("stale", "d")))]
        inventory.extend(metadata(self.ids[name], self.revisions[index]) for index, name in enumerate(
            ("current_metadata", "previous_metadata", "oldest_metadata", "stale_metadata")))
        inventory.append({"Id": self.ids["unrelated"], "Size": 500_000_000,
                          "RepoTags": ["example/unrelated:latest"], "RepoDigests": [],
                          "Config": {"Labels": {"large": "x" * 2_500_000}}})
        self.inventory = self.root / "inventory.json"
        self.inventory.write_text(json.dumps(inventory))
        docker = self.bin / "docker"
        docker.write_text('''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
inventory_file = Path(os.environ["FAKE_IMAGE_INVENTORY"])
images = json.loads(inventory_file.read_text())
with open(os.environ["FAKE_DOCKER_LOG"], "a") as log:
    log.write(" ".join(args) + "\\n")
current = os.environ["FAKE_CURRENT_ID"]
if args[:3] == ["image", "inspect", "--format"]:
    ref = args[4]
    for image in images:
        if ref in image.get("RepoTags", []) + image.get("RepoDigests", []):
            print(image["Id"])
            raise SystemExit(0)
    raise SystemExit(1)
if args[:2] == ["image", "inspect"]:
    print(json.dumps(images))
elif args[:2] == ["image", "ls"]:
    print("\\n".join(image["Id"] for image in images))
elif args[:2] == ["image", "rm"]:
    if args[2] != "--": raise SystemExit(97)
    with open(os.environ["FAKE_REMOVED_IMAGES"], "a") as removed:
        for identifier in args[3:]:
            removed.write(identifier + "\\n")
            images = [image for image in images if image["Id"] != identifier]
    inventory_file.write_text(json.dumps(images))
elif args[:2] == ["container", "ls"]:
    print("rental-apartments-bot-id")
elif args[:2] == ["container", "inspect"]:
    print(json.dumps([{"Image": current}]))
elif args[:2] == ["inspect", "--format"] and args[2] == "{{.Image}}":
    print(current)
elif args[0] == "inspect" and args[1].startswith("--format="):
    print("healthy")
else:
    raise SystemExit(97)
''')
        docker.chmod(0o755)
        for name, content in (
            ("systemd-cat", '#!/bin/sh\ncat >>"$FAKE_SYSTEMD_LOG"\n'),
            ("flock", '#!/bin/sh\nexit "${FAKE_FLOCK_STATUS:-0}"\n'),
            ("df", "#!/bin/sh\nprintf 'Avail\\n10000000000\\n'\n"),
        ):
            executable = self.bin / name
            executable.write_text(content)
            executable.chmod(0o755)
        self.removed = self.root / "removed-images"
        self.docker_log = self.root / "docker.log"
        self.environment = {**os.environ, "PATH": f"{self.bin}:{os.environ['PATH']}",
                            "RENTAL_OPS_STATE_DIR": str(self.state),
                            "RENTAL_OPS_LOCK_FILE": str(self.state / "operations.lock"),
                            "RENTAL_IMAGE_ENV_FILE": str(self.state / "current-image.env"),
                            "RENTAL_DEPLOYMENT_RETENTION_FILE": str(self.retention),
                            "RENTAL_READY_ATTEMPTS": "1",
                            "FAKE_IMAGE_INVENTORY": str(self.inventory),
                            "FAKE_CURRENT_ID": self.ids["current"],
                            "FAKE_REMOVED_IMAGES": str(self.removed),
                            "FAKE_DOCKER_LOG": str(self.docker_log),
                            "FAKE_SYSTEMD_LOG": str(self.root / "systemd.log")}

    def cleanup(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run([str(CLEANUP), *args], cwd=ROOT, env=self.environment,
                              text=True, capture_output=True, check=False, timeout=30)

    def test_dry_run_and_apply_remove_only_unprotected_managed_images(self) -> None:
        planned = self.cleanup("--dry-run")
        self.assertEqual(planned.returncode, 0, planned.stderr)
        plan = json.loads(planned.stdout)
        self.assertEqual(plan["removalCount"], 2)
        self.assertEqual([item["id"] for item in plan["removals"]],
                         [self.ids["stale"], self.ids["stale_metadata"]])
        self.assertFalse(self.removed.exists())
        applied = self.cleanup()
        self.assertEqual(applied.returncode, 0, applied.stderr)
        result = json.loads(applied.stdout)
        self.assertEqual(result, {"result": "success", "removedImageCount": 2,
                                  "candidateVirtualBytes": 1_000_250_000,
                                  "reclaimedBytes": 0,
                                  "availableBytes": 10_000_000_000})
        self.assertEqual(self.removed.read_text().splitlines(),
                         [self.ids["stale"], self.ids["stale_metadata"]])
        self.assertIn(self.ids["unrelated"], [item["Id"] for item in json.loads(self.inventory.read_text())])
        docker_calls = self.docker_log.read_text()
        for command in ("system prune", "image prune", "container rm", "volume rm"):
            self.assertNotIn(command, docker_calls)
        records = self.environment["FAKE_SYSTEMD_LOG"]
        events = Path(records).read_text()
        for event in ("image.cleanup.planned", "image.cleanup.completed",
                      "image-cleanup.completed"):
            self.assertIn(f'"event":"{event}"', events)

    def test_missing_current_protection_refuses_cleanup(self) -> None:
        retention = json.loads(self.retention.read_text())
        retention["retainedReleases"].reverse()
        self.retention.write_text(json.dumps(retention))
        result = self.cleanup("--dry-run")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not protect current", result.stderr)
        self.assertFalse(self.removed.exists())

    def test_retired_protected_record_refuses_pruning(self) -> None:
        retention = json.loads(self.retention.read_text())
        retention["retainedReleases"] = retention["retainedReleases"][:2]
        retention["protectedReleases"] = [{
            "candidateImage": reference("c"), "sourceRevision": self.revisions[2],
            "protectedSnapshot": "/mnt/backups/protected/pre-sqlite-bridge",
            "protectedAt": "2026-08-18T12:00:00Z",
        }]
        self.retention.write_text(json.dumps(retention))
        result = self.cleanup("--dry-run")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Deployment retention index is invalid", result.stderr)
        self.assertFalse(self.removed.exists())


if __name__ == "__main__":
    unittest.main()

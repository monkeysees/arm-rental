"""Process checks for serialized host operations and backup recovery."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class NativeOperationsSystemdTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="native-operations-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.bin = self.root / "bin"
        self.release = self.root / "release"
        self.state = self.root / "state"
        self.backups = self.root / "backups"
        snapshot = self.backups / "daily/2026-07-25T03-15-00-000Z"
        for directory in (self.bin, self.release / "ops", self.state, snapshot):
            directory.mkdir(parents=True, exist_ok=True)
        (self.release / "compose.production.yaml").write_text("services: {}\n")
        (self.release / "ops/compose.native.yaml").write_text("services: {}\n")
        environment_file = self.root / "production.env"
        environment_file.write_text("TELEGRAM_OWNER_ID=42\n")
        image_file = self.state / "current-image.env"
        image_file.write_text("RENTAL_APARTMENTS_IMAGE=ghcr.io/example/app@sha256:" + "a" * 64 + "\n")
        (snapshot / "manifest.json").write_text(json.dumps({"createdAt": "2026-07-25T11:59:00Z"}))
        prelude = '''#!/usr/bin/env bash
set -eu
printf '%s %s\\n' "${0##*/}" "$*" >>"$FAKE_COMMAND_LOG"
command_line="${0##*/} $*"
if [[ -n "${FAKE_FAIL_CONTAINS:-}" && "$command_line" == *"$FAKE_FAIL_CONTAINS"* ]]; then exit 55; fi
'''
        self._executable("systemctl", prelude + "exit 0\n")
        self._executable("flock", prelude + 'exit "${FAKE_FLOCK_STATUS:-0}"\n')
        self._executable("systemd-cat", prelude +
                         'IFS= read -r record || true\nprintf "record %s\\n" "$record" >>"$FAKE_COMMAND_LOG"\n')
        self._executable("date", prelude + '''case "$*" in
  "+%s") printf '%s\\n' 1784980800 ;;
  "--utc +%Y%m%dT%H%M%SZ") printf '%s\\n' 20260725T120000Z ;;
  *) exec /bin/date "$@" ;;
esac
''')
        self._executable("docker", prelude + '''if [[ "$*" == *com.rental-apartments.runtime* ]]; then
  printf '%s\\n' rust
elif [[ "$1" == image && "$2" == inspect ]]; then
  printf '%s\\n' image-id
elif [[ "$*" == "inspect --format {{.Image}} "* ]]; then
  printf '%s\\n' "${FAKE_ACTIVE_IMAGE:-image-id}"
elif [[ "$1" == volume && "$2" == create ]]; then
  printf '%s\\n' "${*: -1}"
elif [[ "$1" == volume && "$2" == inspect ]]; then
  name="${*: -1}"
  run_id="${name#rental-apartments-restore-drill-}"
  temporary=true
  if [[ ${FAKE_BAD_VOLUME_LABEL:-0} == 1 ]]; then temporary=false; fi
  printf '%s|%s|restore-drill|%s\\n' "$name" "$temporary" "$run_id"
elif [[ "$1" == create ]]; then
  printf '%s\\n' "${FAKE_CONTAINER_ID:-restore-test-id}"
elif [[ "$1" == inspect ]]; then
  name="${*: -1}"
  if [[ $name == rental-apartments-restore-drill-* ]]; then
    run_id="${name#rental-apartments-restore-drill-}"
    printf '/%s|true|restore-drill|%s\\n' "$name" "$run_id"
  else
    printf '%s\\n' "${FAKE_HEALTH_STATUS:-healthy}"
  fi
elif [[ "$*" == *maintenance:report* ]]; then
  exit "${FAKE_MAINTENANCE_STATUS:-0}"
fi
''')
        self.log = self.root / "commands.log"
        self.environment = {**os.environ,
                            "PATH": f"{self.bin}:{os.environ['PATH']}",
                            "FAKE_COMMAND_LOG": str(self.log),
                            "RENTAL_RELEASE_DIR": str(self.release),
                            "RENTAL_COMPOSE_FILE": str(self.release / "compose.production.yaml"),
                            "RENTAL_ENV_FILE": str(environment_file),
                            "RENTAL_IMAGE_ENV_FILE": str(image_file),
                            "RENTAL_OPS_STATE_DIR": str(self.state),
                            "RENTAL_OPS_LOCK_FILE": str(self.state / "operations.lock"),
                            "RENTAL_BACKUP_ROOT": str(self.backups),
                            "RENTAL_RESTORE_TMP_ROOT": str(self.state / "restore-drills"),
                            "RENTAL_REQUIRE_BACKUP_MOUNT": "0",
                            "RENTAL_READY_ATTEMPTS": "1",
                            "RENTAL_READY_INTERVAL_SECONDS": "0",
                            "RENTAL_CONTAINER_UID": str(os.getuid()),
                            "RENTAL_CONTAINER_GID": str(os.getgid())}

    def _executable(self, name: str, content: str) -> None:
        path = self.bin / name
        path.write_text(content)
        path.chmod(0o755)

    def operation(self, name: str, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run([str(ROOT / "ops" / name), *args], cwd=ROOT,
                              env=self.environment, text=True, capture_output=True,
                              check=False, timeout=30)

    def trace(self) -> str:
        return self.log.read_text() if self.log.exists() else ""

    def test_storage_check_and_deploy_distinguish_lock_contention_from_errors(self) -> None:
        for lock_status, expected, suffix in (("75", 0, "skipped"), ("66", 66, "failed")):
            with self.subTest(operation="storage-check", lock_status=lock_status):
                self.environment["FAKE_FLOCK_STATUS"] = lock_status
                self.log.unlink(missing_ok=True)
                result = self.operation("storage-check")
                self.assertEqual(result.returncode, expected, result.stderr)
                self.assertIn(f'"event":"storage-check.{suffix}"', self.trace())
                self.assertNotIn("docker ", self.trace())
        for args, status, terminal in (((), 0, "skipped"),
                                       (("--actor", "operator:test"), 75, "failed")):
            with self.subTest(operation="deploy", actor=args):
                self.environment["FAKE_FLOCK_STATUS"] = "75"
                self.log.unlink(missing_ok=True)
                result = self.operation("deploy", *args)
                self.assertEqual(result.returncode, status, result.stderr)
                self.assertIn(f'"event":"deployment.{terminal}"', self.trace())
                self.assertNotIn("docker ", self.trace())

    def test_backup_validates_snapshot_before_restart_and_restarts_on_failures(self) -> None:
        self.environment.pop("FAKE_FLOCK_STATUS", None)
        scenarios = (("", "healthy", 0),
                     ("systemctl stop rental-apartments.service", "healthy", 55),
                     ("backup:create", "healthy", 55),
                     ("systemctl start rental-apartments.service", "healthy", 55),
                     ("", "unhealthy", 70))
        for failure, health, expected in scenarios:
            with self.subTest(failure=failure, health=health):
                self.log.unlink(missing_ok=True)
                self.environment["FAKE_FAIL_CONTAINS"] = failure
                self.environment["FAKE_HEALTH_STATUS"] = health
                result = self.operation("backup")
                self.assertEqual(result.returncode, expected, result.stderr)
                commands = self.trace()
                self.assertIn("systemctl start rental-apartments.service", commands)
                self.assertIn('"event":"backup.started"', commands)
                self.assertIn(f'"event":"backup.{"completed" if expected == 0 else "failed"}"', commands)
                if expected == 0:
                    self.assertLess(commands.index("systemctl stop"), commands.index("backup:create"))
                    self.assertLess(commands.index("backup:validate"), commands.index("systemctl start"))

    def test_maintenance_requires_recent_validated_backup_and_keeps_threshold_status(self) -> None:
        self.environment["FAKE_MAINTENANCE_STATUS"] = "2"
        result = self.operation("maintain")
        self.assertEqual(result.returncode, 2, result.stderr)
        commands = self.trace()
        self.assertLess(commands.index("backup:validate"), commands.index("systemctl stop"))
        self.assertIn("maintenance:report", commands)
        self.assertIn("systemctl start rental-apartments.service", commands)
        self.assertIn('"event":"maintenance.failed"', commands)

        snapshot = self.backups / "daily/2026-07-25T03-15-00-000Z/manifest.json"
        snapshot.write_text(json.dumps({"createdAt": "2026-07-25T09:59:59Z"}))
        self.log.unlink()
        result = self.operation("maintain")
        self.assertEqual(result.returncode, 69, result.stderr)
        commands = self.trace()
        self.assertIn("backup:validate", commands)
        self.assertNotIn("systemctl stop", commands)
        self.assertNotIn("maintenance:report", commands)

    def test_restore_drill_is_offline_and_cleans_only_verified_resources(self) -> None:
        result = self.operation("restore-drill")
        self.assertEqual(result.returncode, 0, result.stderr)
        commands = self.trace()
        self.assertIn("--network none", commands)
        self.assertIn("TELEGRAM_BOT_TOKEN=restore-drill-disabled", commands)
        self.assertIn("TELEGRAM_DELIVERY_DISABLED=true", commands)
        self.assertIn("TELEGRAM_POLLING_DISABLED=true", commands)
        self.assertIn("backup:restore --snapshot", commands)
        self.assertIn("docker rm --force", commands)
        self.assertIn("docker volume rm", commands)
        self.assertEqual(list((self.state / "restore-drills").iterdir()), [])

        self.log.unlink()
        self.environment["FAKE_BAD_VOLUME_LABEL"] = "1"
        result = self.operation("restore-drill")
        self.assertEqual(result.returncode, 74, result.stderr)
        commands = self.trace()
        self.assertIn("docker volume inspect", commands)
        self.assertNotIn("docker volume rm", commands)
        self.assertEqual(len(list((self.state / "restore-drills").iterdir())), 1)

    def test_browser_cleanup_checks_active_image_and_restarts_after_failure(self) -> None:
        snapshot = self.backups / "daily/2026-07-25T03-15-00-000Z/manifest.json"
        snapshot.write_text(json.dumps({"version": 3, "hashes": {"state.sqlite3": "hash"}}))
        result = self.operation("browser-cleanup", "--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        commands = self.trace()
        self.assertIn("rental-app --version", commands)
        self.assertIn("browser:cleanup --backup-report", commands)
        self.assertIn("browser:cleanup --dry-run", commands)
        self.assertLess(commands.index("backup:validate"), commands.index("systemctl stop"))
        self.assertIn("systemctl start rental-apartments.service", commands)

        self.log.unlink()
        self.environment["FAKE_FAIL_CONTAINS"] = "browser:cleanup --apply"
        result = self.operation("browser-cleanup", "--apply")
        self.assertEqual(result.returncode, 55, result.stderr)
        self.assertIn("systemctl start rental-apartments.service", self.trace())

        for condition in ("busy", "wrong-image", "old-snapshot"):
            with self.subTest(condition=condition):
                self.log.unlink()
                self.environment.pop("FAKE_FAIL_CONTAINS", None)
                self.environment.pop("FAKE_FLOCK_STATUS", None)
                self.environment.pop("FAKE_ACTIVE_IMAGE", None)
                snapshot.write_text(json.dumps({"version": 3,
                                                "hashes": {"state.sqlite3": "hash"}}))
                if condition == "busy":
                    self.environment["FAKE_FLOCK_STATUS"] = "75"
                elif condition == "wrong-image":
                    self.environment["FAKE_ACTIVE_IMAGE"] = "different-image"
                else:
                    snapshot.write_text(json.dumps({"version": 2,
                                                    "hashes": {"state.sqlite3": "hash"}}))
                refused = self.operation("browser-cleanup")
                self.assertNotEqual(refused.returncode, 0, refused.stderr)
                commands = self.trace()
                self.assertNotIn("systemctl stop", commands)
                self.assertNotIn("browser:cleanup --dry-run", commands)

    def test_systemd_units_keep_persistent_bounded_utc_schedules(self) -> None:
        unit_dir = ROOT / "infra/systemd"
        operations = ("backup", "storage-check", "image-cleanup", "maintenance",
                      "monitor", "restore-drill", "reboot-check")
        for name in operations:
            service = (unit_dir / f"rental-{name}.service").read_text()
            timer = (unit_dir / f"rental-{name}.timer").read_text()
            self.assertIn("TimeoutStartSec=", service, name)
            self.assertIn("ExecStart=", service, name)
            self.assertNotIn("RuntimeMaxSec=", service, name)
            self.assertIn("Persistent=true", timer, name)
            self.assertRegex(timer, r"(?m)^OnCalendar=.* UTC$", name)
        schedules = {"backup": "*-*-* 03:15:00 UTC",
                     "image-cleanup": "Sat *-*-* 04:00:00 UTC",
                     "maintenance": "Sun *-*-* 04:00:00 UTC",
                     "restore-drill": "Sun *-*-01..07 05:00:00 UTC"}
        for name, schedule in schedules.items():
            self.assertIn(f"OnCalendar={schedule}",
                          (unit_dir / f"rental-{name}.timer").read_text())
        self.assertIn("Group=rental-deploy", (unit_dir / "rental-monitor.service").read_text())
        common = (ROOT / "ops/lib/common.sh").read_text()
        self.assertIn('install -d -m 0750 "$RENTAL_OPS_STATE_DIR"', common)
        self.assertNotIn('install -d -m 0700 "$RENTAL_OPS_STATE_DIR"', common)
        application = (unit_dir / "rental-apartments.service").read_text()
        self.assertIn("EnvironmentFile=/var/lib/rental-apartments-ops/current-image.env", application)
        self.assertIn("up --detach --wait --wait-timeout 240 bot", application)

    def test_deployment_refuses_loaded_unit_that_bypasses_runtime_service(self) -> None:
        script = r'''
          set -Eeuo pipefail
          RENTAL_RELEASE_DIR=/opt/rental-apartments/current
          source ops/lib/operations.sh
          systemctl() {
            [[ $1 == show && $2 == rental-apartments.service ]] || return 91
            local command=/opt/rental-apartments/current/ops/service
            local action=$3 args='up --detach --wait --wait-timeout 240 bot'
            if [[ $action == --property=ExecStop ]]; then args='stop --timeout 45 bot'; fi
            if [[ $RENTAL_TEST_LEGACY_ACTION == all ||
                  $action == "--property=$RENTAL_TEST_LEGACY_ACTION" ]]; then
              command=/usr/bin/docker
              args="compose --file /opt/rental-apartments/current/compose.production.yaml $args"
            fi
            printf '{ path=%s ; argv[]=%s %s ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }\n' \
              "$command" "$command" "$args"
          }
          ops_verify_rust_systemd_runtime
        '''
        for action in ("all", "ExecReload", "ExecStop"):
            with self.subTest(action=action):
                self.environment["RENTAL_TEST_LEGACY_ACTION"] = action
                refused = subprocess.run(["bash", "-c", script], cwd=ROOT,
                                         env=self.environment, text=True,
                                         capture_output=True, check=False)
                self.assertEqual(refused.returncode, 65, refused.stderr)
                self.assertIn("runtime-aware ops/service", refused.stderr)
        self.environment["RENTAL_TEST_LEGACY_ACTION"] = "none"
        accepted = subprocess.run(["bash", "-c", script], cwd=ROOT,
                                  env=self.environment, text=True,
                                  capture_output=True, check=False)
        self.assertEqual(accepted.returncode, 0, accepted.stderr)
        deploy = (ROOT / "ops/deploy").read_text()
        self.assertLess(deploy.index("ops_verify_rust_systemd_runtime"),
                        deploy.index("ops_stop_application"))


if __name__ == "__main__":
    unittest.main()

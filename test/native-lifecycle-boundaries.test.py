#!/usr/bin/env python3
"""Independent process and filesystem contracts retained after Node retirement."""
import http.server
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import threading
import unittest

ROOT = Path(__file__).resolve().parents[1]
BINARY = Path(os.environ.get("RENTAL_APP_BINARY", ROOT / "experiments/rust-replay/target/debug/rental-app")).resolve()
SOURCE = "https://www.list.am/ru/category/56/{page}?n=0&cmtype=0&crc=0&gl=2&srt=3"


class Boundaries(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="native-boundary-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data = self.root / "data"
        self.data.mkdir(mode=0o700)
        self.env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "TELEGRAM_BOT_TOKEN": "123:synthetic-test",
            "TELEGRAM_OWNER_ID": "123",
            "DATA_DIRECTORY": str(self.data),
        }

    def run_app(self, *args, extra=None, stdin=None):
        return subprocess.run([str(BINARY), *args], env=self.env | (extra or {}),
                              input=stdin, text=True, capture_output=True, timeout=15)

    def passed(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def events(self, result):
        return [json.loads(line) for line in result.stderr.splitlines() if line.startswith("{")]

    def test_frozen_health_transitions_and_exact_age_boundaries(self):
        fixture = json.loads((ROOT / "test/fixtures/native-lifecycle/health.json").read_text())
        self.assertEqual(len(fixture["cases"]), 3)
        for case in fixture["cases"]:
            with self.subTest(events=len(case["input"]["events"])):
                observed = self.passed(self.run_app("contract", stdin=json.dumps(case["input"]) + "\n"))
                self.assertEqual(observed, case["expected"])
                self.assertNotIn("do-not-expose", json.dumps(observed))

    def test_health_probe_projects_only_safe_readiness_reasons(self):
        payload = {"ready": False, "reasons": ["LIST_AM_CHALLENGE"], "alertReasons": []}

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                self.send_response(200 if payload["ready"] else 503)
                self.end_headers()
                self.wfile.write(json.dumps(payload).encode())

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join, 3)
        self.addCleanup(server.shutdown)
        env = {"HEALTH_HOST": "127.0.0.1", "HEALTH_PORT": str(server.server_port)}
        for body, code, expected in [
            (payload.copy(), 1, {"status": "not_ready", "reasons": ["LIST_AM_CHALLENGE"], "alertReasons": []}),
            ({"ready": True, "reasons": [], "alertReasons": []}, 0,
             {"status": "ready", "reasons": [], "alertReasons": []}),
            ({"ready": False, "reasons": ["secret:do-not-project"], "alertReasons": []}, 1,
             {"status": "not_ready", "reasons": ["READINESS_RESPONSE_INVALID"],
              "alertReasons": ["READINESS_RESPONSE_INVALID"]}),
        ]:
            payload.clear()
            payload.update(body)
            result = self.run_app("health-check", "--ready", "--json", extra=env)
            self.assertEqual(result.returncode, code, result.stderr)
            self.assertEqual(json.loads(result.stdout), expected)

    def inspection_db(self, version=6):
        filename = self.data / "state.sqlite3"
        db = sqlite3.connect(filename, isolation_level=None)
        self.addCleanup(db.close)
        db.executescript(f"PRAGMA application_id=1095912786; PRAGMA user_version={version}; "
                         "PRAGMA journal_mode=WAL; CREATE TABLE application_metadata("
                         "singleton INTEGER PRIMARY KEY,database_id TEXT,list_url_template TEXT);")
        db.execute("INSERT INTO application_metadata VALUES(1,?,?)", ("synthetic-inspection", SOURCE))
        filename.chmod(0o600)
        return filename, db

    def unix_listener(self):
        sock = socket.socket(socket.AF_UNIX)
        sock.bind(str(self.data / ".singleton.sock"))
        sock.listen()
        self.addCleanup(sock.close)
        return sock

    def test_inspection_reads_committed_wal_without_lease_or_mutation(self):
        filename, db = self.inspection_db(5)
        self.data.chmod(0o750)
        self.unix_listener()
        db.execute("BEGIN IMMEDIATE")
        db.execute("UPDATE application_metadata SET database_id='uncommitted-writer'")
        wal = Path(str(filename) + "-wal")
        before = (filename.read_bytes(), wal.read_bytes())
        self.assertEqual(self.passed(self.run_app("state:inspect")), {"stateBackend": "sqlite", "stateSchema": 5})
        self.assertEqual((filename.read_bytes(), wal.read_bytes()), before)
        self.assertEqual(self.data.stat().st_mode & 0o777, 0o750)
        self.assertTrue((self.data / ".singleton.sock").exists())
        db.execute("ROLLBACK")
        self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 5)
        self.assertEqual(db.execute("SELECT database_id FROM application_metadata").fetchone()[0], "synthetic-inspection")

    def test_inspection_reports_newer_schema_and_rejects_foreign_state(self):
        _filename, db = self.inspection_db(7)
        self.assertEqual(self.passed(self.run_app("state:inspect")), {"stateBackend": "sqlite", "stateSchema": 7})
        db.execute("UPDATE application_metadata SET list_url_template='https://other.invalid/{page}'")
        self.assertNotEqual(self.run_app("state:inspect").returncode, 0)
        db.execute("UPDATE application_metadata SET list_url_template=?", (SOURCE,))
        db.execute("PRAGMA application_id=123")
        self.assertNotEqual(self.run_app("state:inspect").returncode, 0)
        absent = self.root / "absent"
        self.assertNotEqual(self.run_app("state:inspect", "--data-directory", str(absent)).returncode, 0)
        self.assertFalse(absent.exists())

    def test_initialization_respects_live_lease_and_recovers_stale_socket(self):
        sock = self.unix_listener()
        blocked = self.run_app("state:init")
        self.assertNotEqual(blocked.returncode, 0)
        self.assertIn("ERR_SINGLETON_LOCKED", blocked.stderr)
        self.assertFalse((self.data / "state.sqlite3").exists())
        sock.close()
        self.passed(self.run_app("state:init"))
        self.assertFalse((self.data / ".singleton.sock").exists())
        self.assertFalse((self.data / ".singleton.json").exists())

    def test_browser_cleanup_inventory_symlink_refusal_and_backup_usage(self):
        profile = self.data / "chrome-profile"
        nested = profile / "nested"
        nested.mkdir(parents=True)
        cache = nested / "cache"
        cache.write_text("old browser data")
        backup = self.root / "backup"
        backup.mkdir()
        env = {"BACKUP_DIRECTORY": str(backup)}
        paths = [cache, nested, profile]
        expected = {"event": "browser-cleanup.report", "mode": "dry-run", "candidate": str(profile),
                    "paths": [str(path) for path in paths],
                    "candidateBytes": sum(path.stat().st_blocks * 512 for path in paths),
                    "reclaimedBytes": 0, "missing": False}
        self.assertEqual(self.passed(self.run_app("browser:cleanup", "--dry-run", extra=env)), expected)
        unsafe = profile / "unsafe"
        unsafe.symlink_to(cache)
        self.assertNotEqual(self.run_app("browser:cleanup", "--apply", extra=env).returncode, 0)
        self.assertTrue(cache.exists())
        unsafe.unlink()
        applied = self.passed(self.run_app("browser:cleanup", "--apply", extra=env))
        self.assertEqual(applied, expected | {"mode": "apply", "reclaimedBytes": expected["candidateBytes"]})
        self.assertTrue(self.passed(self.run_app("browser:cleanup", "--dry-run", extra=env))["missing"])
        for name, version, hashes in [("old", 2, {"chrome-profile/cache": "x"}), ("new", 3, {"state.sqlite3": "x"})]:
            directory = backup / "daily" / name
            directory.mkdir(parents=True)
            (directory / "manifest.json").write_text(json.dumps({"version": version, "hashes": hashes}))
        result = self.passed(self.run_app("browser:cleanup", "--backup-report", extra=env))
        self.assertEqual(result["event"], "browser-cleanup.backup-usage")
        def allocated(path):
            return path.stat().st_blocks * 512 + (sum(allocated(child) for child in path.iterdir()) if path.is_dir() else 0)
        snapshots = [{"path": str(backup / "daily" / name), "kind": kind,
                      "bytes": allocated(backup / "daily" / name)}
                     for name, kind in [("new", "browser-free"), ("old", "legacy-browser")]]
        self.assertEqual(result, {"event": "browser-cleanup.backup-usage",
                                  "retainedBackupBytes": allocated(backup), "snapshots": snapshots,
                                  "legacyBrowserBytes": snapshots[1]["bytes"],
                                  "browserFreeBytes": snapshots[0]["bytes"], "legacyOrUnknownBytes": 0})

    def test_storage_status_and_alert_edges(self):
        filesystem = os.statvfs(self.data)
        free_percent = filesystem.f_bavail / filesystem.f_blocks * 100
        self.assertGreater(free_percent, 0)
        self.assertLess(free_percent, 99.99)
        result = self.run_app("storage:check", extra={"DISK_FREE_WARNING_PERCENT": str(free_percent / 2)})
        observed = self.passed(result)
        self.assertEqual(observed["status"], "ok")
        self.assertEqual(observed["totalBytes"], filesystem.f_blocks * filesystem.f_frsize)
        self.assertGreater(observed["freeBytes"], 0)
        self.assertLessEqual(observed["freeBytes"], observed["totalBytes"])
        self.assertEqual([event["event"] for event in self.events(result)], ["storage.disk_ok", "alert.resolved"])
        self.assertEqual(self.events(result)[1]["alertName"], "low_disk")
        result = self.run_app("storage:check", extra={"DISK_FREE_WARNING_PERCENT": "99.99"})
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertEqual(json.loads(result.stdout)["status"], "warning")
        self.assertEqual([event["event"] for event in self.events(result)], ["storage.low_disk", "alert.firing"])
        self.assertEqual(self.events(result)[1]["alertName"], "low_disk")
        self.assertEqual(self.events(result)[0]["component"], "storage")

    def test_maintenance_threshold_and_command_failure_statuses(self):
        self.assertEqual(self.run_app("maintenance:report").returncode, 1)
        self.passed(self.run_app("state:init"))
        healthy = self.run_app("maintenance:report")
        self.passed(healthy)
        self.assertEqual([event["event"] for event in self.events(healthy)],
                         ["maintenance.report", "alert.resolved", "alert.resolved"])
        self.assertEqual([event["alertName"] for event in self.events(healthy)[1:]],
                         ["state_database_growth", "state_wal_growth"])
        with (self.data / "state.sqlite3").open("r+b") as stream:
            stream.truncate(256 * 1024 * 1024)
        warning = self.run_app("maintenance:report")
        self.assertEqual(warning.returncode, 2, warning.stderr)
        report = json.loads(warning.stdout)
        self.assertEqual(report["stateFiles"][0]["status"], "warning")
        self.assertEqual([alert["alertName"] for alert in report["alerts"]], ["state_database_growth"])
        self.assertEqual([event["event"] for event in self.events(warning)],
                         ["maintenance.report", "alert.firing", "alert.resolved"])
        shutil.rmtree(self.data)
        self.assertEqual(self.run_app("storage:check").returncode, 1)

    def test_operation_wrappers_preserve_threshold_status_and_restart_service(self):
        bin_dir, release, state, backup = [self.root / name for name in ("bin", "release", "state", "backup")]
        snapshot = backup / "daily/2026-09-26T00-00-00-000Z"
        for directory in (bin_dir, release / "ops", state, snapshot):
            directory.mkdir(parents=True)
        log = self.root / "commands.log"
        commands = {
            "docker": '''#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$FAKE_COMMAND_LOG"
if [[ "$*" == *com.rental-apartments.runtime* ]]; then
  printf '%s\\n' rust
elif [[ "$*" == *maintenance:report* || "$*" == *storage:check* ]]; then
  exit "$FAKE_APP_STATUS"
elif [[ "$*" == *'inspect --format'* ]]; then
  printf '%s\\n' healthy
fi
''',
            "systemctl": '''#!/usr/bin/env bash
printf 'systemctl %s\\n' "$*" >>"$FAKE_COMMAND_LOG"
''',
            "systemd-cat": '''#!/usr/bin/env bash
IFS= read -r record || true
printf '%s\\n' "$record" >>"$FAKE_COMMAND_LOG"
''',
        }
        for name, source in commands.items():
            path = bin_dir / name
            path.write_text(source)
            path.chmod(0o755)
        (release / "compose.production.yaml").write_text("services: {}\n")
        (release / "ops/compose.native.yaml").write_text("services: {}\n")
        env_file = self.root / "production.env"
        env_file.write_text("TELEGRAM_OWNER_ID=42\n")
        image = "ghcr.io/example/rental-apartments@sha256:" + "a" * 64
        (state / "current-image.env").write_text(f"RENTAL_APARTMENTS_IMAGE={image}\n")
        from datetime import datetime, timezone
        (snapshot / "manifest.json").write_text(json.dumps({"createdAt": datetime.now(timezone.utc).isoformat()}))
        env = self.env | {
            "PATH": str(bin_dir) + ":" + self.env["PATH"], "FAKE_COMMAND_LOG": str(log),
            "RENTAL_RELEASE_DIR": str(release), "RENTAL_COMPOSE_FILE": str(release / "compose.production.yaml"),
            "RENTAL_ENV_FILE": str(env_file), "RENTAL_IMAGE_ENV_FILE": str(state / "current-image.env"),
            "RENTAL_OPS_STATE_DIR": str(state), "RENTAL_BACKUP_ROOT": str(backup),
            "RENTAL_REQUIRE_BACKUP_MOUNT": "0", "RENTAL_READY_ATTEMPTS": "1", "RENTAL_READY_INTERVAL_SECONDS": "0",
        }
        for operation, command, event in [("storage-check", "storage:check", "storage-check"),
                                           ("maintain", "maintenance:report", "maintenance")]:
            for code in (0, 2):
                with self.subTest(operation=operation, code=code):
                    log.write_text("")
                    result = subprocess.run([str(ROOT / "ops" / operation)], cwd=ROOT,
                                            env=env | {"FAKE_APP_STATUS": str(code)},
                                            text=True, capture_output=True, timeout=15)
                    self.assertEqual(result.returncode, code, result.stderr)
                    trace = log.read_text()
                    self.assertIn(command, trace)
                    records = [json.loads(line) for line in trace.splitlines() if line.startswith("{")]
                    terminal = event + (".completed" if code == 0 else ".failed")
                    self.assertTrue(any(record.get("event") == terminal and record.get("exitCode") == code
                                        for record in records), trace)
                    if operation == "maintain":
                        self.assertIn("systemctl start rental-apartments.service", trace)


if __name__ == "__main__":
    unittest.main()

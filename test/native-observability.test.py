#!/usr/bin/env python3
"""Exercise the actual SSH observability scripts with isolated host commands."""

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
RENTALCTL = ROOT / "ops/rentalctl"
MONITOR = ROOT / "ops/monitor"
FIXTURE = ROOT / "test/fixtures/journal-observability.jsonl"


def stamp(value):
    return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)


def application_record(observed_at, record):
    return json.dumps({
        "__CURSOR": f"{stamp(observed_at)}-{record['event']}",
        "__REALTIME_TIMESTAMP": str(stamp(observed_at) * 1000),
        "CONTAINER_NAME": "rental-apartments-bot",
        "PRIORITY": "3" if record.get("severity") == "error" else "6",
        "MESSAGE": json.dumps(record),
    }) + "\n"


def alert_record(observed_at, event="alert.firing", name="list_am_challenge", **details):
    return json.dumps({
        "__CURSOR": f"{stamp(observed_at)}-{event}-{name}",
        "__REALTIME_TIMESTAMP": str(stamp(observed_at) * 1000),
        "CONTAINER_NAME": "rental-apartments-bot",
        "PRIORITY": "4" if event == "alert.firing" else "6",
        "MESSAGE": json.dumps({
            "severity": "warn" if event == "alert.firing" else "info",
            "event": event, "alertName": name, "alertSeverity": "warn",
            **details, "message": "List.am challenge state changed",
        }),
    }) + "\n"


def database_records(count, duration_ms, event="state.transaction.completed",
                     operation="private_delivery_acknowledge", error_code=None,
                     sqlite_result_code=None):
    base = stamp("2026-07-25T11:30:00Z")
    lines = []
    for index in range(count):
        record = {"severity": "error" if event.endswith(".failed") else "info",
                  "event": event, "operation": operation,
                  "rowsChanged": 0 if event.endswith(".failed") else 1,
                  "durationMs": duration_ms, "databaseBytes": 12582912,
                  "walBytes": 37080}
        if error_code:
            record["errorCode"] = error_code
        if sqlite_result_code is not None:
            record["sqliteResultCode"] = sqlite_result_code
        time = datetime.fromtimestamp((base + index * 1000) / 1000, timezone.utc).isoformat().replace("+00:00", "Z")
        lines.append(application_record(time, record))
    return "".join(lines)


def deploy_record(observed_at, record):
    return json.dumps({"__REALTIME_TIMESTAMP": str(stamp(observed_at) * 1000),
                       "SYSLOG_IDENTIFIER": "rental-deploy", "PRIORITY": "6",
                       "MESSAGE": json.dumps(record)}) + "\n"


class FakeHost:
    def __init__(self, root, started="2026-07-25T11:00:00Z", lock_available=True):
        self.root = root
        self.bin = root / "bin"
        self.state = root / "state"
        self.bin.mkdir()
        self.state.mkdir()
        self.journal = root / "journal.jsonl"
        self.unit_journal = root / "unit-journal.jsonl"
        self.disk_available = root / "disk-available-kb"
        self.container_started = root / "container-started-at"
        self.readiness_exit = root / "readiness-exit-code"
        shutil.copyfile(FIXTURE, self.journal)
        self.unit_journal.write_text("")
        self.disk_available.write_text("900\n")
        self.container_started.write_text(started + "\n")
        self.readiness_exit.write_text("0\n")
        self._shim("journalctl", '''#!/bin/sh
case " $* " in *" --unit="*) cat "$RENTAL_TEST_UNIT_JOURNAL" ;; *) cat "$RENTAL_TEST_JOURNAL" ;; esac
''')
        self._shim("docker", '''#!/bin/sh
if [ "$1" = "exec" ]; then
  if [ -n "$RENTAL_TEST_READINESS_JSON" ]; then cat "$RENTAL_TEST_READINESS_JSON"
  elif [ "$(cat "$RENTAL_TEST_READINESS_EXIT")" = "0" ]; then
    printf '%s\\n' '{"status":"ready","reasons":[],"alertReasons":[]}'
  else
    printf '%s\\n' '{"status":"not_ready","reasons":["READINESS_PROBE_FAILED"],"alertReasons":["READINESS_PROBE_FAILED"]}'
  fi
  exit "$(cat "$RENTAL_TEST_READINESS_EXIT")"
fi
case "$*" in *com.rental-apartments.runtime*) printf '%s\\n' "${RENTAL_TEST_RUNTIME_LABEL:-<no value>}"; exit 0 ;; esac
if [ "$1" = "inspect" ]; then
  printf '%s\\n' '[{"Image":"sha256:abc","Config":{"Labels":{"org.opencontainers.image.revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}},"State":{"Running":true,"StartedAt":"'"$(cat "$RENTAL_TEST_CONTAINER_STARTED")"'","Health":{"Status":"healthy"}},"RestartCount":0}]'
  exit 0
fi
exit 1
''')
        self._shim("systemctl", '''#!/bin/sh
case "$2" in
  rental-storage-check.timer) printf 'ActiveState=active\\nLastTriggerUSec=Sat 2026-07-25 11:55:00 UTC\\nNextElapseUSecRealtime=Sat 2026-07-25 12:05:00 UTC\\n' ;;
  rental-storage-check.service) printf 'Result=%s\\nExecMainStatus=%s\\n' "${RENTAL_TEST_STORAGE_RESULT:-success}" "${RENTAL_TEST_STORAGE_EXIT_STATUS:-0}" ;;
  *.timer) printf 'ActiveState=active\\nLastTriggerUSec=Sat 2026-07-25 11:55:00 UTC\\nNextElapseUSecRealtime=Sat 2026-07-25 12:05:00 UTC\\n' ;;
  *.service) printf 'Result=success\\nExecMainStatus=0\\n' ;;
esac
''')
        self._shim("df", '''#!/usr/bin/env bash
available=900
case "${!#}" in
  *rental-apartments-data*) available=$(cat "$RENTAL_TEST_DISK_AVAILABLE") ;;
  /var/log/journal) available="${RENTAL_TEST_JOURNAL_AVAILABLE:-900}" ;;
esac
used=$((1000 - available))
printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\n'
printf '/dev/test 1000 %s %s 10%% /test\\n' "$used" "$available"
''')
        self._shim("du", '#!/bin/sh\nprintf "10\\t/var/log/journal\\n"\n')
        self._shim("systemd-cat", '#!/bin/sh\ncat >>"$RENTAL_TEST_SYSTEMD_LOG"\n')
        self._shim("curl", '#!/bin/sh\ncat >>"$RENTAL_TEST_CURL_PAYLOADS"\nprintf "sent\\n" >>"$RENTAL_TEST_CURL_CALLS"\n')
        self._shim("flock", f'#!/bin/sh\nexit {0 if lock_available else 1}\n')
        env_file = root / "env"
        env_file.write_text("TELEGRAM_BOT_TOKEN=123456:abcdefghijklmnopqrstuvwxyz\nTELEGRAM_OWNER_ID=123456789\n")
        env_file.chmod(0o600)
        self.env = dict(os.environ, PATH=f"{self.bin}:{os.environ['PATH']}",
                        JOURNALCTL_BIN=str(self.bin / "journalctl"),
                        DOCKER_BIN=str(self.bin / "docker"),
                        SYSTEMCTL_BIN=str(self.bin / "systemctl"),
                        DF_BIN=str(self.bin / "df"), DU_BIN=str(self.bin / "du"),
                        SYSTEMD_CAT_BIN=str(self.bin / "systemd-cat"),
                        CURL_BIN=str(self.bin / "curl"),
                        RENTAL_TEST_JOURNAL=str(self.journal),
                        RENTAL_TEST_UNIT_JOURNAL=str(self.unit_journal),
                        RENTAL_TEST_DISK_AVAILABLE=str(self.disk_available),
                        RENTAL_TEST_CONTAINER_STARTED=str(self.container_started),
                        RENTAL_TEST_READINESS_EXIT=str(self.readiness_exit),
                        RENTAL_TEST_RUNTIME_LABEL="rust",
                        READINESS_PROBE_RETRY_DELAY_SECONDS="0",
                        RENTAL_TEST_SYSTEMD_LOG=str(root / "systemd.log"),
                        RENTAL_TEST_CURL_CALLS=str(root / "curl.calls"),
                        RENTAL_TEST_CURL_PAYLOADS=str(root / "curl.payloads"),
                        RENTAL_OPS_STATE_DIR=str(self.state),
                        RENTAL_OPS_LOCK_FILE=str(root / "operations.lock"),
                        RENTAL_ENV_FILE=str(env_file),
                        RENTAL_OBSERVABILITY_NOW_EPOCH="1784980800")

    def _shim(self, name, content):
        path = self.bin / name
        path.write_text(content)
        path.chmod(0o755)

    def run(self, program, *args, env=None):
        result = subprocess.run([str(program), *args], env=self.env if env is None else env,
                                text=True, capture_output=True, timeout=30)
        if result.returncode:
            raise AssertionError(f"{program} {args} failed ({result.returncode}): {result.stderr}")
        return result.stdout

    def monitor(self, env=None):
        self.run(MONITOR, env=env)

    def ctl(self, *args, env=None):
        return self.run(RENTALCTL, *args, env=env)

    def alerts(self):
        return json.loads((self.state / "alerts.json").read_text())

    def metrics(self):
        return json.loads((self.state / "metrics-latest.json").read_text())

    def payloads(self):
        return (self.root / "curl.payloads").read_text() if (self.root / "curl.payloads").exists() else ""


class Observability(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="native-observability-")
        self.addCleanup(tmp.cleanup)
        self.host = FakeHost(Path(tmp.name))

    def test_logs_metrics_and_timer_inventory(self):
        host = self.host
        host.journal.write_text(host.journal.read_text() +
            application_record("2026-07-25T11:59:00Z", {"severity": "info", "event": "source.integrity.checked", "page": 1, "parsedCount": 20}) +
            application_record("2026-07-25T11:59:30Z", {"severity": "error", "event": "source.integrity.failed", "reason": "IDENTITY_REJECTION", "page": 1, "rejectedCount": 1}) +
            application_record("2026-07-25T11:59:40Z", {"severity": "warn", "event": "alert.firing", "alertName": "readiness_failure", "status": "firing", "reasons": ["LIST_AM_CHALLENGE", "unsafe reason"], "component": "list_am", "code": "ERR_LIST_AM_CHALLENGE", "ownerId": "must-not-appear", "message": "Production alert firing"}))
        logs = host.ctl("logs", "--since", "30m", "--severity", "error")
        self.assertIn("crawl.failed\tApartment crawl failed", logs)
        self.assertIn("unstructured.message\tnot-json but still visible", logs)
        alert_logs = host.ctl("logs", "--since", "30m", "--event", "alert.firing")
        self.assertIn('"reasons":["LIST_AM_CHALLENGE"]', alert_logs)
        self.assertNotIn("unsafe reason", alert_logs)
        self.assertNotIn("must-not-appear", alert_logs)
        database_logs = host.ctl("logs", "--since", "30m", "--event", "state.transaction.failed")
        self.assertIn('"code":"ERR_STATE_DATABASE_BUSY","sqliteResultCode":5', database_logs)
        metrics = json.loads(host.ctl("metrics", "--since", "1h", "--json"))["metrics"]
        self.assertEqual(metrics["crawl"], {"successful": 2, "failed": 1, "successRatio": 2 / 3,
                       "durationMs": {"p50": 100, "p95": 500}, "pages": 6,
                       "discovered": 8, "updated": 3, "notified": 5, "filtered": 3,
                       "channelSent": 3, "channelEdited": 1})
        self.assertEqual(metrics["retries"], [{"component": "telegram", "operation": "send", "count": 1}])
        self.assertNotIn("stateWrites", metrics)
        self.assertEqual(metrics["databaseOperations"], [{
            "operation": "private_delivery_acknowledge", "count": 2,
            "failureCount": 1, "busyFailureCount": 1,
            "sqliteResultCodes": [{"code": 5, "count": 1}], "rowsChanged": 1,
            "durationMs": {"p50": 3, "p95": 9},
            "databaseBytes": 12582912, "walBytes": 37080}])
        self.assertEqual(metrics["sourceIntegrity"], {
            "checkedPages": 1, "failures": 1,
            "failuresByReason": [{"reason": "IDENTITY_REJECTION", "count": 1}],
            "lastCheckedAt": "2026-07-25T11:59:00Z",
            "lastFailureAt": "2026-07-25T11:59:30Z"})
        timers = host.ctl("timers").strip().splitlines()[1:]
        self.assertEqual([line.split()[0] for line in timers], [
            "rental-deploy", "rental-monitor", "rental-storage-check", "rental-backup",
            "rental-image-cleanup", "rental-maintenance", "rental-restore-drill", "rental-reboot-check"])

    def test_alert_edges_deduplicate_and_redact_fallback(self):
        host = self.host
        host.monitor()
        self.assertEqual([item["name"] for item in host.alerts()["alerts"]], ["state_database_busy"])
        self.assertEqual([item["name"] for item in json.loads(host.ctl("status", "--json"))["monitorAlerts"]],
                         ["state_database_busy"])
        self.assertIn("firing alerts", host.ctl("status"))
        host.monitor()
        self.assertEqual((host.root / "curl.calls").read_text().strip().splitlines(), ["sent"])
        host.journal.write_text("")
        host.monitor()
        self.assertEqual((host.root / "curl.calls").read_text().strip().splitlines(), ["sent", "sent"])
        self.assertEqual(host.alerts()["alerts"], [])
        self.assertNotIn("abcdefghijklmnopqrstuvwxyz", (host.root / "systemd.log").read_text())
        self.assertNotIn("123456789", (host.root / "systemd.log").read_text())
        self.assertIn("monitor.succeeded", (host.root / "systemd.log").read_text())

    def test_transaction_latency_sample_and_hysteresis(self):
        host = self.host
        host.journal.write_text(database_records(19, 900))
        host.monitor()
        self.assertFalse(any(a["name"] == "state_transaction_latency" for a in host.alerts()["alerts"]))
        for duration, firing in ((600, True), (300, True), (250, False)):
            host.journal.write_text(database_records(20, duration))
            host.monitor()
            matches = [a for a in host.alerts()["alerts"] if a["name"] == "state_transaction_latency"]
            self.assertEqual(bool(matches), firing)
            if firing:
                self.assertIn(f"p95 is {duration} ms", matches[0]["reason"])
        events = [json.loads(line) for line in (host.root / "systemd.log").read_text().splitlines()]
        self.assertEqual([event["alertStatus"] for event in events if event.get("alertName") == "state_transaction_latency"],
                         ["firing", "resolved"])

    def test_busy_and_other_database_failures_are_distinct(self):
        host = self.host
        host.journal.write_text(database_records(2, 5, event="state.transaction.failed",
            error_code="ERR_STATE_DATABASE_BUSY", sqlite_result_code=5) +
            database_records(1, 8, event="state.checkpoint.failed", operation="checkpoint", sqlite_result_code=10))
        host.monitor()
        alerts = {item["name"]: item for item in host.alerts()["alerts"]}
        self.assertEqual(set(alerts), {"state_database_busy", "state_database_operation_failure"})
        self.assertEqual(alerts["state_database_busy"]["reason"],
            "database busy failure count for private_delivery_acknowledge is 2 (SQLite result codes: 5=2)")
        self.assertEqual(alerts["state_database_operation_failure"]["reason"],
            "database operation failure count for checkpoint is 1 (SQLite result codes: 10=1)")

    def test_journal_capacity_follows_filesystem_not_retained_size(self):
        host = self.host
        host._shim("du", '#!/bin/sh\nprintf "1048576\\t/var/log/journal\\n"\n')
        for available, firing in ((900, False), (199, True), (210, True), (260, False)):
            host.monitor(env=dict(host.env, RENTAL_TEST_JOURNAL_AVAILABLE=str(available)))
            names = {item["name"] for item in host.alerts()["alerts"]}
            self.assertNotIn("journal_capacity", names)
            self.assertEqual("filesystem_capacity_journal" in names, firing)

    def test_data_filesystem_hysteresis_uses_same_free_fraction(self):
        host = self.host
        for available, reason in ((199, "filesystem data has 19.9% free"),
                                  (210, "filesystem data has 21% free"), (260, None)):
            host.disk_available.write_text(f"{available}\n")
            host.monitor()
            alert = next((item for item in host.alerts()["alerts"]
                          if item["name"] == "filesystem_capacity_data"), None)
            self.assertEqual(None if alert is None else alert["reason"], reason)
            if available == 199:
                data = host.metrics()["filesystems"][0]
                self.assertEqual((data["freeFraction"], data["usedPercent"]), (0.199, 80.1))
        events = [json.loads(line) for line in (host.root / "systemd.log").read_text().splitlines()]
        self.assertEqual([item["alertStatus"] for item in events
                          if item.get("alertName") == "filesystem_capacity_data"],
                         ["firing", "resolved"])

    def test_transient_application_edges_deliver_once(self):
        host = self.host
        host.monitor()
        initial = host.payloads().count("request =")
        with host.journal.open("a") as out:
            out.write(alert_record("2026-07-25T11:59:10Z", name="list_am_source_integrity") +
                      alert_record("2026-07-25T11:59:20Z", event="alert.resolved",
                                   name="list_am_source_integrity"))
        host.monitor()
        host.monitor()
        payloads = host.payloads()
        self.assertEqual(payloads.count("request ="), initial + 2)
        self.assertIn("alert firing: list_am_source_integrity", payloads)
        self.assertIn("alert resolved: list_am_source_integrity", payloads)
        self.assertNotIn("abcdefghijklmnopqrstuvwxyz", (host.root / "systemd.log").read_text())

    def test_application_readiness_reasons_are_validated_in_alert(self):
        host = self.host
        with host.journal.open("a") as out:
            out.write(alert_record("2026-07-25T11:59:10Z", name="readiness_failure",
                                   reasons=["CRAWL_STALE", "LIST_AM_CHALLENGE", "unsafe reason"]))
        host.monitor()
        self.assertIn("reason: CRAWL_STALE, LIST_AM_CHALLENGE", host.payloads())
        self.assertNotIn("unsafe reason", host.payloads())
        alert = next(item for item in host.alerts()["alerts"] if item["name"] == "readiness_failure")
        self.assertEqual(alert["reason"], "CRAWL_STALE, LIST_AM_CHALLENGE")

    def test_host_readiness_resolves_even_with_application_alert_same_name(self):
        host = self.host
        with host.journal.open("a") as out:
            out.write(alert_record("2026-07-25T11:58:00Z", name="readiness_failure",
                                   reasons=["CRAWL_STALE"]) +
                      alert_record("2026-07-25T11:58:30Z", event="alert.resolved",
                                   name="readiness_failure"))
        host.readiness_exit.write_text("1\n")
        host.monitor()
        host.monitor()
        host.readiness_exit.write_text("0\n")
        host.monitor()
        self.assertIn("alert firing: host_readiness_failure", host.payloads())
        self.assertIn("alert resolved: host_readiness_failure", host.payloads())
        self.assertEqual(host.alerts()["readinessFailureCount"], 0)
        self.assertFalse(any(item["name"] == "host_readiness_failure" for item in host.alerts()["alerts"]))

    def test_challenge_grace_does_not_hide_stale_crawl(self):
        host = self.host
        response = host.root / "readiness.json"
        host.env["RENTAL_TEST_READINESS_JSON"] = str(response)
        host.readiness_exit.write_text("1\n")
        response.write_text(json.dumps({"status": "not_ready", "reasons": ["LIST_AM_CHALLENGE"],
                                        "alertReasons": []}))
        for _ in range(4):
            host.monitor()
        self.assertEqual(host.alerts()["readinessFailureCount"], 0)
        self.assertFalse(any(item["name"] == "host_readiness_failure" for item in host.alerts()["alerts"]))
        self.assertEqual(json.loads(host.ctl("status", "--json"))["freshReadiness"]["reasons"],
                         ["LIST_AM_CHALLENGE"])
        response.write_text(json.dumps({"status": "not_ready",
                                        "reasons": ["LIST_AM_CHALLENGE", "CRAWL_STALE"],
                                        "alertReasons": ["CRAWL_STALE"]}))
        host.monitor()
        host.monitor()
        self.assertEqual(host.alerts()["readinessFailureCount"], 2)
        self.assertIn("CRAWL_STALE", next(item["reason"] for item in host.alerts()["alerts"]
                                          if item["name"] == "host_readiness_failure"))

    def test_readiness_alert_survives_gap_and_replacement_until_ready(self):
        host = self.host
        host.readiness_exit.write_text("1\n")
        host.monitor()
        host.monitor()
        state = host.alerts()
        self.assertTrue(any(item["name"] == "host_readiness_failure" for item in state["alerts"]))
        state["updatedAt"] = "2000-01-01T00:00:00Z"
        (host.state / "alerts.json").write_text(json.dumps(state))
        host.monitor()
        self.assertEqual(host.alerts()["readinessFailureCount"], 1)
        host.container_started.write_text("2026-07-25T11:56:00Z\n")
        host.monitor()
        self.assertNotIn("alert resolved: host_readiness_failure", host.payloads())
        host.readiness_exit.write_text("0\n")
        host.monitor()
        self.assertIn("alert resolved: host_readiness_failure", host.payloads())

    def test_readiness_failures_across_container_replacement_are_not_consecutive(self):
        host = self.host
        host.readiness_exit.write_text("1\n")
        host.monitor()
        self.assertEqual(host.alerts()["readinessFailureCount"], 1)
        host.container_started.write_text("2026-07-25T11:56:00Z\n")
        host.monitor()
        self.assertEqual(host.alerts()["readinessFailureCount"], 1)
        self.assertEqual(host.alerts()["readinessProbeContainerStartedAt"],
                         "2026-07-25T11:56:00Z")
        self.assertNotIn("host_readiness_failure", host.payloads())
        host.monitor()
        self.assertIn("alert firing: host_readiness_failure", host.payloads())

    def test_quarantined_pointer_alerts_until_skip_stops(self):
        host = self.host
        digest = "sha256:" + "f70af2cd" * 8
        host.unit_journal.write_text(deploy_record("2026-07-25T11:50:00Z", {
            "event": "deployment.quarantine.skipped", "result": "success",
            "candidateImage": "ghcr.io/owner/repository:latest", "previousImage": None}))
        host.monitor()
        self.assertNotIn("deployment_blocked", host.payloads())
        with host.unit_journal.open("a") as out:
            out.write(deploy_record("2026-07-25T11:55:00Z", {
                "event": "deployment.quarantine.skipped", "result": "success",
                "candidateImage": f"ghcr.io/owner/repository@{digest}",
                "previousImage": "ghcr.io/owner/repository@sha256:2c1be778"}))
        host.monitor()
        self.assertEqual(host.metrics()["deployment"]["blockedCandidate"],
                         {"digest": digest, "observedAt": "2026-07-25T11:55:00Z"})
        self.assertIn(f"quarantined candidate {digest}", host.payloads())
        self.assertIn("alert firing: deployment_blocked", host.payloads())
        host.unit_journal.write_text("")
        host.monitor()
        self.assertIn("alert resolved: deployment_blocked", host.payloads())

    def test_failed_rollout_alerts_even_if_timer_succeeded(self):
        host = self.host
        digest = "sha256:" + "f0845a6a" * 8
        host.unit_journal.write_text(deploy_record("2026-07-25T11:52:24Z", {
            "event": "alert.firing", "alertName": "deployment_failure",
            "alertSeverity": "critical", "candidateImage": f"ghcr.io/owner/repository@{digest}",
            "previousImage": "ghcr.io/owner/repository@sha256:2c1be778"}))
        host.monitor()
        self.assertEqual(host.metrics()["deployment"]["alerts"], [{
            "name": "deployment_failure", "severity": "critical", "digest": digest,
            "observedAt": "2026-07-25T11:52:24Z"}])
        self.assertIn("alert firing: deployment_failure", host.payloads())
        self.assertIn(f"for candidate {digest}", host.payloads())
        host.unit_journal.write_text("")
        host.monitor()
        self.assertIn("alert resolved: deployment_failure", host.payloads())

    def test_scheduled_failure_uses_structured_reason(self):
        host = self.host
        host.unit_journal.write_text("".join(json.dumps({"MESSAGE": json.dumps(event)}) + "\n"
            for event in ({"severity": "warn", "event": "alert.firing", "alertName": "low_disk",
                           "freeFraction": 0.125, "warningThreshold": 0.2},
                          {"event": "storage-check.failed", "result": "failure", "exitCode": 2,
                           "durationMs": 1000, "step": "check-disk-capacity"})))
        env = dict(host.env, RENTAL_TEST_STORAGE_RESULT="exit-code",
                   RENTAL_TEST_STORAGE_EXIT_STATUS="2")
        self.assertIn("low disk: 12.5% free is below the 20% threshold", host.ctl("timers", env=env))
        (host.state / "alerts.json").write_text(json.dumps({
            "schemaVersion": 1, "readinessFailureCount": 0,
            "alerts": [{"name": "scheduled_job_rental-storage-check", "severity": "error",
                        "runbook": "rentalctl timers", "status": "firing",
                        "firstObservedAt": "2026-07-25T11:56:00Z",
                        "lastObservedAt": "2026-07-25T11:56:00Z", "sourceRevision": "a" * 40}]}))
        host.monitor(env=env)
        alert = next(item for item in host.alerts()["alerts"]
                     if item["name"] == "scheduled_job_rental-storage-check")
        self.assertEqual(alert["reason"], "low disk: 12.5% free is below the 20% threshold")
        self.assertIn("reason: low disk: 12.5% free", host.payloads())
        host.unit_journal.write_text(json.dumps({"MESSAGE": json.dumps({
            "event": "storage-check.failed", "result": "failure", "exitCode": 1,
            "durationMs": 0, "step": "verify-backup-mount"})}) + "\n")
        self.assertIn("failed during verify-backup-mount", host.ctl("timers", env=env))

    def test_old_container_application_alerts_are_ignored(self):
        host = self.host
        host.container_started.write_text("2026-07-25T11:00:00.123456789Z\n")
        with host.journal.open("a") as out:
            out.write(alert_record("2026-07-25T10:59:59Z"))
        host.monitor()
        self.assertEqual(host.metrics()["applicationAlerts"], [])
        self.assertEqual(host.metrics()["deployment"]["uptimeSeconds"], 3599)
        with host.journal.open("a") as out:
            out.write(alert_record("2026-07-25T11:00:01Z"))
        host.monitor()
        self.assertEqual([{"name": item["name"], "status": item["status"]}
                          for item in host.metrics()["applicationAlerts"]],
                         [{"name": "list_am_challenge", "status": "firing"}])

    def test_monitor_defers_while_operations_lock_is_held(self):
        with tempfile.TemporaryDirectory(prefix="native-observability-lock-") as root:
            host = FakeHost(Path(root), lock_available=False)
            host.monitor()
            self.assertFalse((host.state / "metrics-latest.json").exists())
            self.assertFalse((host.root / "curl.calls").exists())
            events = (host.root / "systemd.log").read_text()
            self.assertIn("monitor.started", events)
            self.assertIn("monitor.skipped", events)
            self.assertNotIn("monitor.succeeded", events)
            self.assertNotIn("monitor.failed", events)


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Exercise the real host evidence collector with isolated command peers."""
import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "ops/production-exercise"
PREVIOUS = "ghcr.io/example/rental-apartments@sha256:" + "a" * 64
CANDIDATE = "ghcr.io/example/rental-apartments@sha256:" + "b" * 64
FIRST_BOOT = "11111111-1111-4111-8111-111111111111"
SECOND_BOOT = "22222222-2222-4222-8222-222222222222"
CRAWL = "33333333-3333-4333-8333-333333333333"
SHELLS = {
'systemctl': r'''#!/usr/bin/env bash
set -eu
printf '%s %s\n' "${0##*/}" "$*" >>"$FAKE_COMMAND_LOG"

if [[ "${1:-}" == "start" && "${2:-}" == "rental-deploy.service" ]]; then
  mkdir -p "$RENTAL_DEPLOYMENTS_DIR" "$RENTAL_QUARANTINE_DIR"
  if [[ -f "$RENTAL_OPS_STATE_DIR/fake-deploy-failed-once" ]]; then
    : >"$RENTAL_OPS_STATE_DIR/fake-deploy-retry-success"
    exit 0
  fi
  digest="${FAKE_CANDIDATE##*@sha256:}"
  printf '%s\n' "$FAKE_DEPLOYMENT_RECEIPT" >"$RENTAL_DEPLOYMENTS_DIR/observed.json"
  printf '%s\n' '{"schemaVersion":1}' >"$RENTAL_QUARANTINE_DIR/$digest.json"
  : >"$RENTAL_OPS_STATE_DIR/fake-deploy-failed-once"
  exit 1
fi
if [[ "${1:-}" == "start" && "${2:-}" == "rental-restore-drill.service" ]]; then
  exit "$FAKE_RESTORE_STATUS"
fi
if [[ "${1:-}" == "show" ]]; then
  unit="${2:-}"
  property="${3:-}"
  case "$property" in
    --property=Result)
      case "$unit" in
        rental-deploy.service)
          if [[ -f "$RENTAL_OPS_STATE_DIR/fake-deploy-retry-success" ]]; then
            printf '%s\n' success
          else
            printf '%s\n' exit-code
          fi
          ;;
        rental-restore-drill.service)
          if [[ "$FAKE_RESTORE_STATUS" == "0" ]]; then
            printf '%s\n' success
          else
            printf '%s\n' failed
          fi
          ;;
        *) printf '%s\n' success ;;
      esac
      ;;
    --property=LastTriggerUSec)
      if [[ "$FAKE_TIMERS_NEVER" == "1" ]]; then printf '%s\n' n/a
      else printf '%s\n' 2026-07-25T11:59:00Z
      fi
      ;;
    --property=NextElapseUSecRealtime)
      printf '%s\n' 2026-07-25T12:05:00Z
      ;;
  esac
  exit 0
fi
case "${1:-}" in
  is-active|is-enabled|restart|reboot|start) exit 0 ;;
esac
exit 0
''',
'docker': r'''#!/usr/bin/env bash
set -eu
printf '%s %s\n' "${0##*/}" "$*" >>"$FAKE_COMMAND_LOG"

if [[ "$*" == *com.rental-apartments.runtime* ]]; then printf '%s\n' 'rust'; exit 0; fi
if [[ "${1:-}" == "inspect" ]]; then printf '%s\n' healthy; exit 0; fi
if [[ "${1:-}" == "exec" ]]; then
  printf '%s\n' '{"status":"ready","ready":true,"startedAt":"2026-07-25T11:58:00Z","privateAccess":{"accessMode":"allowlist","persistedUserCount":300,"authorizedUserCount":250,"suspendedUserCount":'"$FAKE_SUSPENDED_COUNT"',"activeUserCount":200}}'
  exit 0
fi
exit 0
''',
'journalctl': r'''#!/usr/bin/env bash
set -eu
printf '%s %s\n' "${0##*/}" "$*" >>"$FAKE_COMMAND_LOG"

if [[ "$FAKE_RESTORE_STATUS" == "0" ]]; then
  printf '%s\n' '{"event":"restore-drill.completed","result":"success","durationMs":12000}'
else
  printf '%s\n' '{"event":"restore-drill.failed","result":"failure","durationMs":500}'
  printf '%s\n' 'credential=never-copy-raw-journal-output'
fi
printf '%s\n' '{"timestamp":"2026-07-25T11:59:10Z","event":"source.integrity.checked","phase":"runtime","crawlId":"33333333-3333-4333-8333-333333333333","page":1}'
printf '%s\n' '{"timestamp":"2026-07-25T11:59:11Z","event":"source.integrity.checked","phase":"runtime","crawlId":"33333333-3333-4333-8333-333333333333","page":2}'
printf '%s\n' '{"timestamp":"2026-07-25T11:59:12Z","event":"crawl.succeeded","crawlId":"33333333-3333-4333-8333-333333333333","pagesParsed":2,"notifiedCount":0}'
printf '%s\n' '{"timestamp":"2026-07-25T11:59:13Z","event":"crawl.succeeded","crawlId":"44444444-4444-4444-8444-444444444444","pagesParsed":1,"notifiedCount":99}'
''',
'date': r'''#!/usr/bin/env bash
set -eu
printf '%s %s\n' "${0##*/}" "$*" >>"$FAKE_COMMAND_LOG"

case "$*" in
  "-u +%Y-%m-%dT%H:%M:%SZ") printf '%s\n' 2026-07-25T12:00:00Z ;;
  "-u +%Y%m%dT%H%M%SZ") printf '%s\n' 20260725T120000Z ;;
  "+%s") printf '%s\n' 1784980800 ;;
  --date=2026-07-25T11:59:00Z*" +%s") printf '%s\n' 1784980740 ;;
  --date=2026-07-25T11:59:00Z*) printf '%s\n' 2026-07-25T11:59:00Z ;;
  --date=2026-07-25T12:05:00Z*) printf '%s\n' 2026-07-25T12:05:00Z ;;
  *) printf 'unexpected fake date invocation: %s\n' "$*" >&2; exit 9 ;;
esac
''',
'git': r'''#!/usr/bin/env bash
set -eu
printf '%s %s\n' "${0##*/}" "$*" >>"$FAKE_COMMAND_LOG"

printf '%040d\n' 1
''',
'stat': r'''#!/usr/bin/env bash
set -eu
printf '%s %s\n' "${0##*/}" "$*" >>"$FAKE_COMMAND_LOG"

if [[ "${1:-}" == "--format=%a" ]]; then printf '%s\n' 600; else exit 9; fi
''',
'sleep': r'''#!/usr/bin/env bash
set -eu
printf '%s %s\n' "${0##*/}" "$*" >>"$FAKE_COMMAND_LOG"
exit 0
''',
'sync': r'''#!/usr/bin/env bash
set -eu
printf '%s %s\n' "${0##*/}" "$*" >>"$FAKE_COMMAND_LOG"
exit 0
''',
}


class ProductionExerciseTests(unittest.TestCase):
    def host(self, restore_fails=False, timers_never=False, inconsistent_counts=False):
        temporary = tempfile.TemporaryDirectory(prefix="production-exercise-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.bin, self.state = self.root / "bin", self.root / "state"
        self.bin.mkdir()
        for name in ("deployments", "quarantine"):
            (self.state / name).mkdir(parents=True)
        self.evidence = self.root / "evidence.json"
        image = self.state / "current-image.env"
        image.write_text(f"RENTAL_APARTMENTS_IMAGE={PREVIOUS}\n")
        image.chmod(0o600)
        self.boot = self.root / "boot-id"
        self.boot.write_text(FIRST_BOOT + "\n")
        self.log = self.root / "commands.log"
        for name, value in SHELLS.items():
            target = self.bin / name
            target.write_text(value)
            target.chmod(0o755)
        receipt = dict(schemaVersion=1, outcome="failed", actor="systemd:rental-deploy",
                       candidateImage=CANDIDATE, previousImage=PREVIOUS,
                       sourceRevision="c" * 40, snapshot="/sanitized/snapshot",
                       firstInstall=False, rollback=dict(attempted=True, result="completed"),
                       completedAt="2026-07-25T12:00:00Z")
        self.environment = {**os.environ,
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "FAKE_COMMAND_LOG": str(self.log), "FAKE_CANDIDATE": CANDIDATE,
            "FAKE_DEPLOYMENT_RECEIPT": json.dumps(receipt),
            "FAKE_RESTORE_STATUS": str(int(restore_fails)),
            "FAKE_TIMERS_NEVER": str(int(timers_never)),
            "FAKE_SUSPENDED_COUNT": "51" if inconsistent_counts else "50",
            "RENTAL_OPS_STATE_DIR": str(self.state), "RENTAL_IMAGE_ENV_FILE": str(image),
            "RENTAL_DEPLOYMENTS_DIR": str(self.state / "deployments"),
            "RENTAL_QUARANTINE_DIR": str(self.state / "quarantine"),
            "RENTAL_BOOT_ID_FILE": str(self.boot),
            "RENTAL_EXERCISE_READY_ATTEMPTS": "1", "RENTAL_EXERCISE_READY_INTERVAL_SECONDS": "0",
            "RENTAL_REPOSITORY_REVISION": "d" * 40,
        }
        self.execute("init", "--actor", "human:production-owner", "--host-alias", "production-vps")

    def execute(self, command, *arguments, status=0):
        result = subprocess.run([str(SCRIPT), command, "--evidence", str(self.evidence), *arguments],
                                cwd=ROOT, env=self.environment, text=True, capture_output=True, timeout=30)
        if status is None:
            self.assertNotEqual(result.returncode, 0)
        else:
            self.assertEqual(result.returncode, status, result.stdout + result.stderr)
        return result

    def read(self):
        return json.loads(self.evidence.read_text())

    def accept_runtime(self, mode="allowlist", status=0):
        return self.execute("runtime-acceptance", "--expected-access-mode", mode,
                            "--expected-private-deliveries", "0", status=status)

    def test_observed_recovery_receipt_is_complete_sanitized_and_private(self):
        self.host()
        self.accept_runtime()
        self.execute("restore-drill")
        self.execute("failed-deployment", "--candidate", CANDIDATE, "--previous", PREVIOUS)
        self.execute("docker-restart")
        self.execute("reboot-before", "--request-reboot")
        self.boot.write_text(SECOND_BOOT + "\n")
        for command in ("reboot-after", "timers", "finalize", "validate"):
            self.execute(command)
        evidence = self.read()
        self.assertEqual(evidence["overallStatus"], "observed-pass")
        self.assertEqual(evidence["completedAt"], "2026-07-25T12:00:00Z")
        exercises = evidence["exercises"]
        self.assertEqual([item["status"] for item in exercises.values()], ["observed-pass"] * 6)
        self.assertEqual(exercises["runtimeAcceptance"], {
            "status": "observed-pass", "observedAt": "2026-07-25T12:00:00Z",
            "readinessProbe": "container-loopback:/ready", "readinessReady": True,
            "runtimeStartedAt": "2026-07-25T11:58:00Z", "expectedAccessMode": "allowlist",
            "observedAccessMode": "allowlist", "persistedUserCount": 300,
            "authorizedUserCount": 250, "suspendedUserCount": 50, "activeUserCount": 200,
            "crawlId": CRAWL, "sourceIntegrityChecked": True, "checkedPageCount": 2,
            "pagesParsed": 2, "observedPrivateDeliveryCount": 0,
            "expectedPrivateDeliveryCount": 0, "unexpectedRedeliveryObserved": False,
        })
        self.assertEqual(len(exercises["timerFreshness"]["timers"]), 8)
        self.assertEqual(exercises["failedDeploymentRollback"]["rollbackResult"], "completed")
        self.assertEqual(exercises["failedDeploymentRollback"]["deployUnitResult"], "failed")
        self.assertEqual(exercises["hostRebootRecovery"]["beforeBootId"], FIRST_BOOT)
        self.assertEqual(exercises["hostRebootRecovery"]["afterBootId"], SECOND_BOOT)
        self.assertNotRegex(self.evidence.read_text(), r"(?i)never-copy-raw|TELEGRAM_BOT_TOKEN|GHCR_READ_TOKEN|Authorization:")
        self.assertEqual(self.evidence.stat().st_mode & 0o777, 0o600)
        commands = self.log.read_text()
        for command in ("systemctl start rental-restore-drill.service",
                        "docker exec rental-apartments-bot", "rental-app health-check --ready --document",
                        "systemctl start rental-deploy.service", "systemctl restart docker.service",
                        "systemctl reboot --no-block"):
            self.assertIn(command, commands)
        self.assertNotIn("127.0.0.1:8787", commands)
        self.assertNotRegex(commands, r"exec .* node ")

    def test_access_mismatch_and_semantic_tampering_fail(self):
        self.host()
        self.accept_runtime("owner", status=None)
        runtime = self.read()["exercises"]["runtimeAcceptance"]
        self.assertEqual(runtime["status"], "observed-fail")
        self.assertEqual(runtime["expectedAccessMode"], "owner")
        self.assertEqual(runtime["observedAccessMode"], "allowlist")
        self.evidence.unlink()
        self.execute("init", "--actor", "human:production-owner", "--host-alias", "production-vps")
        self.accept_runtime()
        accepted = self.read()
        for key, value in (("readinessReady", False), ("sourceIntegrityChecked", False),
                           ("observedAccessMode", "owner"), ("observedPrivateDeliveryCount", 1),
                           ("unexpectedRedeliveryObserved", True), ("checkedPageCount", 1)):
            with self.subTest(key=key):
                tampered = copy.deepcopy(accepted)
                tampered["exercises"]["runtimeAcceptance"][key] = value
                self.evidence.write_text(json.dumps(tampered) + "\n")
                result = self.execute("validate", status=64)
                self.assertIn("sanitized exercise contract", result.stderr)
        self.host(inconsistent_counts=True)
        self.accept_runtime(status=None)
        runtime = self.read()["exercises"]["runtimeAcceptance"]
        self.assertEqual(runtime["status"], "observed-fail")
        self.assertEqual(runtime["suspendedUserCount"], 51)

    def test_failure_cannot_become_launch_approval(self):
        self.host(restore_fails=True)
        self.execute("restore-drill", status=None)
        self.execute("finalize", status=None)
        evidence = self.read()
        self.assertEqual(evidence["overallStatus"], "observed-fail")
        self.assertEqual(evidence["exercises"]["restoreDrill"]["status"], "observed-fail")
        self.assertEqual(evidence["exercises"]["restoreDrill"]["terminalEvent"], "restore-drill.failed")
        self.assertNotIn("never-copy-raw", self.evidence.read_text())

    def test_disruption_preconditions_and_incomplete_timer_history(self):
        self.host(timers_never=True)
        result = self.execute("reboot-before", status=64)
        self.assertIn("--request-reboot", result.stderr)
        result = self.execute("failed-deployment", "--candidate", CANDIDATE,
                              "--previous", PREVIOUS.replace("a" * 64, "e" * 64), status=64)
        self.assertIn("does not match --previous", result.stderr)
        self.execute("timers")
        self.execute("finalize")
        evidence = self.read()
        self.assertEqual(evidence["overallStatus"], "pending")
        self.assertIsNone(evidence["completedAt"])
        self.assertTrue(all(item["status"] == "pending" and item["lastResult"] == "never"
                            for item in evidence["exercises"]["timerFreshness"]["timers"]))

    def test_committed_template_claims_no_live_evidence(self):
        schema = json.loads((ROOT / "docs/production-exercise-evidence.schema.json").read_text())
        template = json.loads((ROOT / "docs/production-exercise-evidence.template.json").read_text())
        self.assertEqual(schema["$schema"], "https://json-schema.org/draft/2020-12/schema")
        self.assertEqual(schema["properties"]["schemaVersion"]["const"], 2)
        self.assertEqual(template["schemaVersion"], 2)
        self.assertEqual(template["evidenceKind"], "repository-template")
        self.assertEqual(template["overallStatus"], "pending")
        self.assertIsNone(template["completedAt"])
        self.assertTrue(all(item["status"] == "pending" for item in template["exercises"].values()))
        self.assertEqual(template["sanitization"], dict(rawLogsIncluded=False, secretsIncluded=False,
                                                       collectionPolicy="allowlisted-status-fields-only"))


if __name__ == "__main__":
    unittest.main(verbosity=2)

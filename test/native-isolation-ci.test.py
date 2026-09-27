#!/usr/bin/env python3
"""Production isolation and executable GitHub workflow boundary checks."""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def read(name):
    return (ROOT / name).read_text()


def workflow_step(filename, name):
    source = read(".github/workflows/" + filename)
    step = source.split("      - name: " + name + "\n", 1)[1].split("\n      - name:", 1)[0]
    return re.sub(r"(?m)^ {10}", "", step.split("        run: |\n", 1)[1])


DOCKER_PEER = r'''
    docker() {
      case "$1 $2" in
        'pull --quiet') ;;
        'image inspect')
          case "$*" in
            *org.opencontainers.image.revision*)
              case "$*" in
                *:production*) printf '%s\n' "$CURRENT_REVISION" ;;
                *) printf '%s\n' "$CANDIDATE_IMAGE_REVISION" ;;
              esac ;;
            *com.rental-apartments.runtime*)
              case "$*" in
                *:production*) printf '%s\n' "$CURRENT_RUNTIME" ;;
                *) printf '%s\n' "$CANDIDATE_RUNTIME" ;;
              esac ;;
            *.RepoDigests*)
              case "$*" in
                *:production*) printf '%s\n' "$CURRENT_IMAGE" ;;
                *) printf '%s\n' "$CANDIDATE_IMAGE" ;;
              esac ;;
            *) return 99 ;;
          esac ;;
        create*)
          case "$2" in
            *metadata-"$REVISION") printf '%s\n' candidate-container ;;
            *) printf '%s\n' current-container ;;
          esac ;;
        cp*)
          case "$2" in
            candidate-container:*) cp "$CANDIDATE_METADATA" "$3/release-metadata.json" ;;
            current-container:*) cp "$CURRENT_METADATA" "$3/release-metadata.json" ;;
            *) return 99 ;;
          esac ;;
        rm*) ;;
        push*) printf '%s\n' push >> "$DOCKER_LOG" ;;
        *) return 99 ;;
      esac
    }
  '''


class IsolationAndCI(unittest.TestCase):
    def test_build_context_and_runtime_isolation(self):
        patterns = {line.strip() for line in read(".dockerignore").splitlines()
                    if line.strip() and not line.startswith("#")}
        self.assertTrue({".env", ".env.*", ".data/", "node_modules/", "coverage/", ".git/",
                         "*.log", "logs/", ".scratch/", "experiments/rust-replay/target/"} <= patterns)
        dockerfile = read("Dockerfile.native")
        self.assertRegex(dockerfile, r"(?m)^USER 1000:1000$")
        self.assertNotRegex(dockerfile, r"(?m)^COPY\s+\.\s")
        self.assertNotIn("--env-file", dockerfile)
        self.assertNotRegex(dockerfile, r"(?i)package-lock|\bnpm\b|chromium|puppeteer|SYS_ADMIN")
        for required in ("FROM scratch AS payload", "FROM ${PAYLOAD_IMAGE} AS production"):
            self.assertIn(required, dockerfile)
        compose = read("compose.production.yaml")
        for required in ('user: "1000:1000"', 'cap_drop:\n      - ALL', "no-new-privileges:true",
                         "read_only: true", "- rental-apartments-data:/app/.data",
                         "- /tmp:size=134217728,mode=1777,nosuid,nodev,noexec",
                         "driver: journald", "tag: rental-apartments.production",
                         "labels: com.rental-apartments.environment"):
            self.assertIn(required, compose)
        self.assertNotRegex(compose, r"(?m)^\s+ports:")
        self.assertNotRegex(compose, r"(?i)fluentd|LOG_COLLECTOR_ADDRESS")
        installer = read("scripts/install-curl-impersonate")
        self.assertIn("sha256sum --check --status", installer)
        self.assertIn("LICENSE*", installer)
        versions = read("scripts/curl-impersonate-version")
        for architecture in ("AMD64", "ARM64"):
            self.assertRegex(versions, rf"CURL_IMPERSONATE_{architecture}_SHA256=[a-f0-9]{{64}}")

    def test_observability_and_single_environment_contract(self):
        runbook = read("docs/observability.md")
        for expected in ("Storage=persistent", "SystemMaxUse=1G", "MaxRetentionSec=14day",
                         "rentalctl logs --since 30m --follow", "rentalctl metrics --since 24h --json",
                         "process_restart_loop", "readiness_failure", "list_am_challenge",
                         "invalid_telegram_credentials", "invalid_telegram_channel_permissions",
                         "five_consecutive_crawl_failures", "stale_exchange_rates", "backup_failure",
                         "restore_test_failure", "low_disk"):
            self.assertIn(expected, runbook)
        self.assertNotRegex(runbook, r"(?i)Fluentd|LOG_COLLECTOR_ADDRESS")
        self.assertFalse((ROOT / "package.json").exists())
        for name in ("staging-guard.js", "staging-smoke-cli.js", "staging-smoke.js",
                     "staging-soak-cli.js", "staging-soak-runtime.js", "staging-soak.js"):
            self.assertFalse((ROOT / "src" / name).exists())
        self.assertFalse((ROOT / "test/staging.test.js").exists())
        for path in [ROOT / "README.md", *(ROOT / "docs").glob("*.md")]:
            if path.name != "architecture.md":
                self.assertNotRegex(path.read_text(), r"(?i)\bstaging\b|\brehears(?:al|e|ed|ing)?\b|\b24-hour soak\b")

    def test_required_checks_publication_permissions_and_order(self):
        quality = read(".github/workflows/quality.yml")
        publication = read(".github/workflows/publish-production.yml")
        promotion = read(".github/workflows/promote-production.yml")
        self.assertIn("scripts/check --already-built", quality)
        self.assertIn("scripts/validate-production-contract", read("scripts/check"))
        validator = read("scripts/validate-production-contract")
        for expected in ("shellcheck --severity=warning --external-sources", "systemd-analyze",
                         "--recursive-errors=no", "--no-env-resolution --no-path-resolution"):
            self.assertIn(expected, validator)
        for source in (quality, publication, promotion):
            for reference in re.findall(r"(?m)^\s*uses:\s+([^ #]+)", source):
                self.assertRegex(reference, r"@[0-9a-f]{40}$")
        for source in (publication, promotion):
            self.assertIn("group: production-publication", source)
            self.assertIn("cancel-in-progress: false", source)
            self.assertIn("packages: write", source)
            self.assertIn("contents: read", source)
        self.assertIn("github.event.workflow_run.conclusion == 'success'", publication)
        self.assertIn("github.event.workflow_run.head_branch == 'main'", publication)
        self.assertIn("github.event.workflow_run.event == 'push'", publication)
        self.assertIn("ref: ${{ github.event.workflow_run.head_sha }}", publication)
        self.assertIn("workflow_dispatch:", promotion)
        steps = [promotion.index("name: " + name) for name in (
            "Require the confirmed bridge to be the release production runs",
            "Confirm the running release can deploy the candidate", "Advance production discovery pointer")]
        self.assertEqual(steps, sorted(steps))

    def run_shell(self, script, root, environment):
        return subprocess.run(["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script],
                              cwd=root, env={**os.environ, **environment}, capture_output=True, text=True, timeout=20)

    def test_promotion_binds_both_metadata_objects_before_any_push(self):
        script = workflow_step("promote-production.yml", "Resolve the requested release and the release production runs")
        current_revision, candidate_revision = "b" * 40, "c" * 40
        current_image = "ghcr.io/example/arm-rental@sha256:" + "a" * 64
        candidate_image = "ghcr.io/example/arm-rental@sha256:" + "d" * 64
        current = dict(sourceRevision=current_revision, imageReference=current_image, runtime="rust", schemaVersion=3)
        candidate = dict(sourceRevision=candidate_revision, imageReference=candidate_image, runtime="rust", schemaVersion=3)
        with tempfile.TemporaryDirectory(prefix="promotion-binding-") as temporary:
            root = Path(temporary)
            def run_case(current_object=None, candidate_object=None, **overrides):
                (root / "current.json").write_text(json.dumps(current if current_object is None else current_object))
                (root / "candidate.json").write_text(json.dumps(candidate if candidate_object is None else candidate_object))
                (root / "github-output").write_text("")
                (root / "docker.log").write_text("")
                environment = dict(GITHUB_REPOSITORY="example/arm-rental", GITHUB_OUTPUT=str(root / "github-output"),
                    REVISION=candidate_revision, CURRENT_REVISION=current_revision, CURRENT_IMAGE=current_image,
                    CURRENT_RUNTIME="rust", CANDIDATE_IMAGE=candidate_image, CANDIDATE_IMAGE_REVISION=candidate_revision,
                    CANDIDATE_RUNTIME="rust", CANDIDATE_METADATA=str(root / "candidate.json"),
                    CURRENT_METADATA=str(root / "current.json"), DOCKER_LOG=str(root / "docker.log"))
                environment.update(overrides)
                result = self.run_shell(DOCKER_PEER + "\n" + script + "\ndocker push production-pointer", root, environment)
                return result, "push" in (root / "docker.log").read_text()
            result, pushed = run_case()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(pushed)
            for field, value in (("sourceRevision", candidate_revision), ("imageReference", candidate_image),
                                 ("runtime", "node"), ("schemaVersion", 2)):
                with self.subTest(current_field=field):
                    result, pushed = run_case(current_object={**current, field: value})
                    self.assertNotEqual(result.returncode, 0)
                    self.assertFalse(pushed)
            for field, value in (("sourceRevision", current_revision), ("imageReference", current_image),
                                 ("runtime", "node"), ("schemaVersion", 2)):
                with self.subTest(candidate_field=field):
                    result, pushed = run_case(candidate_object={**candidate, field: value})
                    self.assertNotEqual(result.returncode, 0)
                    self.assertFalse(pushed)
            for overrides in ({"CANDIDATE_IMAGE_REVISION": current_revision}, {"CANDIDATE_RUNTIME": "node"},
                              {"CURRENT_RUNTIME": "node"}, {"CURRENT_RUNTIME": "<no value>"}):
                result, pushed = run_case(**overrides)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(pushed)

    def test_confirmed_host_must_equal_production_pointer(self):
        script = workflow_step("promote-production.yml", "Require the confirmed bridge to be the release production runs")
        values = dict(CONFIRMED="b" * 40, CURRENT_REVISION="b" * 40,
                      CONFIRMED_DIGEST="image@sha256:" + "a" * 64,
                      CURRENT_REFERENCE="image@sha256:" + "a" * 64)
        with tempfile.TemporaryDirectory() as root:
            self.assertEqual(self.run_shell(script, root, values).returncode, 0)
            for field in ("CONFIRMED", "CONFIRMED_DIGEST"):
                self.assertNotEqual(self.run_shell(script, root, {**values, field: "mismatch"}).returncode, 0)

    def test_metadata_publication_copies_complete_verified_bundle(self):
        script = workflow_step("publish-production.yml", "Publish Cargo/source-input release metadata")
        fixtures = {
            "git": "#!/bin/sh\nprintf 'operations archive\\n'\n",
            "python3": r'''#!/usr/bin/env bash
set -eu
if [[ $2 == verify ]]; then exit 0; fi
[[ $2 == metadata ]]
while (($#)); do
  if [[ $1 == --output-dir ]]; then output=$2; break; fi
  shift
done
mkdir -p "$output"
cp release/operations.tar "$output/operations.tar"
cp compose.production.yaml "$output/compose.production.yaml"
for artifact in release-metadata.json source-inputs.json transport-files.json; do
  printf '%s\n' "$artifact" > "$output/$artifact"
done
''',
            "docker": r'''#!/usr/bin/env bash
set -eu
case "$1" in
  build|push|rm) ;;
  create) printf 'metadata-container\n' ;;
  cp) cp -R metadata-image/release/. "$3" ;;
  *) exit 9 ;;
esac
''',
        }
        with tempfile.TemporaryDirectory(prefix="metadata-publication-") as temporary:
            root = Path(temporary)
            (root / "bin").mkdir()
            (root / "compose.production.yaml").write_text("base compose\n")
            for name, content in fixtures.items():
                target = root / "bin" / name
                target.write_text(content)
                target.chmod(0o755)
            result = self.run_shell(script, root, dict(PATH=f"{root / 'bin'}:{os.environ['PATH']}",
                SOURCE_REVISION="a" * 40, IMAGE_REPOSITORY="ghcr.io/example/arm-rental",
                IMAGE_REFERENCE="ghcr.io/example/arm-rental@sha256:" + "b" * 64,
                RUNNER_TEMP=str(root)))
            self.assertEqual(result.returncode, 0, result.stderr)
            for name in ("release-metadata.json", "operations.tar", "compose.production.yaml",
                         "source-inputs.json", "transport-files.json"):
                self.assertEqual((root / "release/published" / name).read_bytes(),
                                 (root / "release/bundle" / name).read_bytes())


if __name__ == "__main__":
    unittest.main(verbosity=2)

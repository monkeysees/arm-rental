import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const executeFile = promisify(execFile);
const digest = (character = "a") =>
  `ghcr.io/example/arm-rental@sha256:${character.repeat(64)}`;

test("deployment quarantine is digest keyed, sanitized, and explicitly clearable", async (t) => {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "deploy-quarantine-"),
  );
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const stateDirectory = join(temporaryDirectory, "state");
  const environmentFile = join(temporaryDirectory, "env");
  await writeFile(environmentFile, "unused=true\n", { mode: 0o600 });
  const script = `
    set -Eeuo pipefail
    RENTAL_OPS_STATE_DIR=$1
    RENTAL_ENV_FILE=$2
    source ops/lib/common.sh
    source ops/lib/deployment.sh
    candidate=$3
    deployment_write_quarantine "$candidate" "$4" candidate-verification-failed
    deployment_is_quarantined "$candidate"
    file=$(deployment_quarantine_file "$candidate")
    jq -e --arg candidate "$candidate" '
      .candidateImage == $candidate and
      .reason == "candidate-verification-failed" and
      (.sourceRevision | test("^[a-f0-9]{40}$"))
    ' "$file" >/dev/null
    deployment_clear_quarantine "$candidate"
    ! deployment_is_quarantined "$candidate"
  `;
  await executeFile(
    "bash",
    [
      "-c",
      script,
      "deployment-quarantine-test",
      stateDirectory,
      environmentFile,
      digest(),
      "b".repeat(40),
    ],
    { cwd: new URL("..", import.meta.url) },
  );
});

test("deployment resolves only the repository digest returned by the discovery pull", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "deploy-resolve-"));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const fakeDirectory = join(temporaryDirectory, "bin");
  await executeFile("mkdir", ["-p", fakeDirectory]);
  const docker = join(fakeDirectory, "docker");
  await writeFile(
    docker,
    `#!/usr/bin/env bash
set -eu
if [[ $1 == pull ]]; then exit 0; fi
if [[ $1 == image && $2 == inspect ]]; then
  printf '%s\\n' 'ghcr.io/other/image@sha256:${"f".repeat(64)}'
  printf '%s\\n' '${digest("c")}'
  exit 0
fi
exit 9
`,
  );
  await chmod(docker, 0o755);
  const script = `
    set -Eeuo pipefail
    RENTAL_OPS_STATE_DIR=$1
    source ops/lib/common.sh
    source ops/lib/deployment.sh
    test "$(deployment_resolve_discovery ghcr.io/example/arm-rental)" = "$2"
  `;
  await executeFile(
    "bash",
    ["-c", script, "deployment-resolve-test", temporaryDirectory, digest("c")],
    {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, PATH: `${fakeDirectory}:${process.env.PATH}` },
    },
  );
});

test("deployment accepts the exact operations archive and rejects broader infra", async (t) => {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "deploy-operations-archive-"),
  );
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const archive = join(temporaryDirectory, "operations.tar");
  await executeFile(
    "git",
    [
      "archive",
      "--format=tar",
      `--output=${archive}`,
      "HEAD",
      "ops",
      "infra/systemd",
    ],
    { cwd: new URL("..", import.meta.url) },
  );
  const script = `
    set -Eeuo pipefail
    RENTAL_OPS_STATE_DIR=$1/state
    source ops/lib/deployment.sh
    deployment_validate_operations_archive "$2"
  `;
  await executeFile(
    "bash",
    [
      "-c",
      script,
      "deployment-operations-archive-test",
      temporaryDirectory,
      archive,
    ],
    { cwd: new URL("..", import.meta.url) },
  );

  const payload = join(temporaryDirectory, "unexpected-payload");
  const unexpectedArchive = join(temporaryDirectory, "unexpected.tar");
  await executeFile("mkdir", ["-p", join(payload, "infra")]);
  await writeFile(join(payload, "infra", "unexpected"), "not allowed\n");
  await executeFile("tar", [
    "--create",
    "--file",
    unexpectedArchive,
    "--directory",
    payload,
    "infra",
  ]);
  await assert.rejects(
    executeFile(
      "bash",
      [
        "-c",
        script,
        "deployment-operations-archive-test",
        temporaryDirectory,
        unexpectedArchive,
      ],
      { cwd: new URL("..", import.meta.url) },
    ),
    (error) =>
      error.code === 65 &&
      error.stderr.includes("Operations bundle contains an unexpected path"),
  );
});

test("deployment evidence is exclusive and retention tracks three complete releases", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "deploy-evidence-"));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const script = `
    set -Eeuo pipefail
    RENTAL_OPS_STATE_DIR=$1
    RENTAL_DEPLOYMENTS_DIR=$1/deployments
    source ops/lib/common.sh
    source ops/lib/deployment.sh
    for character in a b c d; do
      candidate="ghcr.io/example/arm-rental@sha256:"
      candidate+=$(printf '%064d' 0 | tr 0 "$character")
      evidence=$(deployment_write_evidence \
        success systemd:rental-deploy "$candidate" "" "${2}" \
        "/mnt/backups/daily/2026-07-25T00:00:00Z" false \
        not-applicable "/var/lib/rental-apartments/releases/${2}-$character")
      deployment_update_retention_index "$evidence"
    done
    jq -e '
      .minimumRetainedReleases == 3 and
      (.retainedReleases | length) == 3 and
      ([.retainedReleases[] |
        has("candidateImage") and has("sourceRevision") and
        has("releaseDirectory") and has("snapshot")
      ] | all)
    ' "$RENTAL_OPS_STATE_DIR/deployment-retention.json" >/dev/null
  `;
  await executeFile(
    "bash",
    [
      "-c",
      script,
      "deployment-evidence-test",
      temporaryDirectory,
      "e".repeat(40),
    ],
    { cwd: new URL("..", import.meta.url) },
  );
});

test("unattended deploy contract covers no-op, first install, rollback, and failed rollback", async () => {
  const [deploy, library, operations, launcher, service, timer] =
    await Promise.all([
      readFile(new URL("../ops/deploy", import.meta.url), "utf8"),
      readFile(new URL("../ops/lib/deployment.sh", import.meta.url), "utf8"),
      readFile(new URL("../ops/lib/operations.sh", import.meta.url), "utf8"),
      readFile(new URL("../ops/deploy-launcher", import.meta.url), "utf8"),
      readFile(
        new URL("../infra/systemd/rental-deploy.service", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../infra/systemd/rental-deploy.timer", import.meta.url),
        "utf8",
      ),
    ]);

  assert.match(operations, /operations\.lock/u);
  assert.match(deploy, /deployment\.noop/u);
  assert.match(deploy, /DEPLOYMENT_FIRST_INSTALL=true/u);
  assert.match(deploy, /deployment_validate_empty_storage/u);
  assert.match(deploy, /deployment\.first-install\.rejected/u);
  assert.match(deploy, /deployment\.rollback\.completed/u);
  assert.match(deploy, /deployment\.rollback\.failed/u);
  assert.match(deploy, /deployment_write_quarantine/u);
  assert.match(deploy, /node src\/recovery-cli\.js backup/u);
  assert.match(deploy, /node src\/recovery-cli\.js restore/u);
  assert.match(library, /minimumRetainedReleases: 3/u);
  assert.match(library, /retainedReleases/u);
  assert.match(
    library,
    /RENTAL_APARTMENTS_IMAGE=%s\\n/u,
    "the current image file must contain the exact section-3 runtime key",
  );
  assert.match(
    library,
    /compose\.production\.yaml/u,
    "candidate and current releases use the production Compose contract",
  );
  assert.match(
    library,
    /docker create "\$metadata_tag" \/release\/release-metadata\.json/u,
    "scratch metadata images require an inert create-time command",
  );
  assert.match(library, /deployment_extract_release_bundle/u);
  assert.match(library, /operations\.tar/u);
  assert.doesNotMatch(library, /git -C|RENTAL_GIT_REMOTE/u);
  assert.doesNotMatch(
    deploy,
    /:production.*compose|RENTAL_APARTMENTS_IMAGE=.*:production/su,
  );
  assert.match(
    launcher,
    /\/usr\/local\/lib\/rental-apartments-bootstrap\/ops\/deploy/u,
  );
  assert.match(launcher, /\/opt\/rental-apartments\/current\/ops\/deploy/u);
  assert.match(service, /ExecStart=\/usr\/local\/sbin\/rental-deploy/u);
  assert.match(service, /TimeoutStartSec=30min/u);
  assert.doesNotMatch(service, /RuntimeMaxSec/u);
  assert.match(timer, /OnBootSec=5min/u);
  assert.match(timer, /OnCalendar=\*-\*-\* \*:00\/5:00 UTC/u);
  assert.match(timer, /Persistent=true/u);
});

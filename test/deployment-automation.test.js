import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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

test("deployment observation uses the application poll default and rejects ambiguity", async (t) => {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "deploy-poll-setting-"),
  );
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const environmentFile = join(temporaryDirectory, "env");
  await writeFile(environmentFile, "GHCR_USERNAME=reader\n", { mode: 0o600 });
  const script = `
    set -Eeuo pipefail
    RENTAL_OPS_STATE_DIR=$1/state
    RENTAL_ENV_FILE=$2
    source ops/lib/deployment.sh
    value=$(deployment_read_optional_setting POLL_INTERVAL_MS)
    value=\${value:-60000}
    test "$value" = 60000
  `;
  await executeFile(
    "bash",
    [
      "-c",
      script,
      "deployment-poll-setting-test",
      temporaryDirectory,
      environmentFile,
    ],
    { cwd: new URL("..", import.meta.url) },
  );

  await writeFile(
    environmentFile,
    "POLL_INTERVAL_MS=60000\nPOLL_INTERVAL_MS=30000\n",
    { mode: 0o600 },
  );
  await assert.rejects(
    executeFile(
      "bash",
      [
        "-c",
        script,
        "deployment-poll-setting-test",
        temporaryDirectory,
        environmentFile,
      ],
      { cwd: new URL("..", import.meta.url) },
    ),
    (error) =>
      error.code === 65 &&
      error.stderr.includes(
        "Optional production setting is repeated: POLL_INTERVAL_MS",
      ),
  );
});

test("deployment observation rejects an unready candidate before the observation window", async (t) => {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "deploy-unready-candidate-"),
  );
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const sleepMarker = join(temporaryDirectory, "sleep-called");
  const script = `
    set -Eeuo pipefail
    RENTAL_OPS_STATE_DIR=$1/state
    source ops/lib/deployment.sh
    ops_wait_ready() { return 70; }
    sleep() { : >"$SLEEP_MARKER"; }
    journalctl() { return 99; }
    ! deployment_wait_candidate 0 360 skipped
    test ! -e "$SLEEP_MARKER"
  `;
  await executeFile(
    "bash",
    ["-c", script, "deployment-unready-test", temporaryDirectory],
    {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, SLEEP_MARKER: sleepMarker },
    },
  );
});

test("first deployment creates a Compose-owned volume and permits only its browser profile", async (t) => {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "deploy-data-volume-"),
  );
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const fakeDirectory = join(temporaryDirectory, "bin");
  const mountpoint = join(temporaryDirectory, "volume-data");
  const marker = join(temporaryDirectory, "created");
  const log = join(temporaryDirectory, "docker.log");
  await executeFile("mkdir", ["-p", fakeDirectory, mountpoint]);
  const docker = join(fakeDirectory, "docker");
  await writeFile(
    docker,
    `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >>"$FAKE_DOCKER_LOG"
if [[ $1 == volume && $2 == inspect && $3 == rental-apartments-data ]]; then
  [[ -f $FAKE_DOCKER_MARKER ]]
  exit
fi
if [[ $1 == volume && $2 == create ]]; then
  touch "$FAKE_DOCKER_MARKER"
  printf '%s\\n' rental-apartments-data
  exit
fi
if [[ $1 == volume && $2 == inspect && $3 == --format ]]; then
  if [[ $4 == *Mountpoint* ]]; then
    printf '%s\\n' "$FAKE_DOCKER_MOUNTPOINT"
  else
    printf '%s\\n' 'rental-apartments-data|local|rental-apartments|rental-apartments-data'
  fi
  exit
fi
exit 9
`,
  );
  await chmod(docker, 0o755);
  const script = `
    set -Eeuo pipefail
    RENTAL_OPS_STATE_DIR=$1/state
    source ops/lib/common.sh
    source ops/lib/deployment.sh
    deployment_validate_first_install_storage
  `;
  const environment = {
    ...process.env,
    PATH: `${fakeDirectory}:${process.env.PATH}`,
    FAKE_DOCKER_LOG: log,
    FAKE_DOCKER_MARKER: marker,
    FAKE_DOCKER_MOUNTPOINT: mountpoint,
  };
  await executeFile(
    "bash",
    ["-c", script, "deployment-data-volume-test", temporaryDirectory],
    { cwd: new URL("..", import.meta.url), env: environment },
  );
  const dockerCalls = await readFile(log, "utf8");
  assert.match(
    dockerCalls,
    /volume create --driver local --label com\.docker\.compose\.project=rental-apartments --label com\.docker\.compose\.volume=rental-apartments-data rental-apartments-data/u,
  );

  await executeFile("mkdir", [join(mountpoint, "chrome-profile")]);
  await writeFile(
    join(mountpoint, "chrome-profile", "Cookies"),
    "browser identity\n",
  );
  await executeFile(
    "bash",
    ["-c", script, "deployment-data-volume-test", temporaryDirectory],
    { cwd: new URL("..", import.meta.url), env: environment },
  );

  await writeFile(join(mountpoint, "unexpected-state"), "must fail\n");
  await assert.rejects(
    executeFile(
      "bash",
      ["-c", script, "deployment-data-volume-test", temporaryDirectory],
      { cwd: new URL("..", import.meta.url), env: environment },
    ),
    (error) =>
      error.code === 65 &&
      error.stderr.includes(
        "First deployment requires empty or browser-profile-only application storage",
      ),
  );

  await rm(join(mountpoint, "unexpected-state"));
  await rm(join(mountpoint, "chrome-profile"), {
    recursive: true,
    force: true,
  });
  await symlink("elsewhere", join(mountpoint, "chrome-profile"), "dir");
  await assert.rejects(
    executeFile(
      "bash",
      ["-c", script, "deployment-data-volume-test", temporaryDirectory],
      { cwd: new URL("..", import.meta.url), env: environment },
    ),
    (error) =>
      error.code === 65 &&
      error.stderr.includes(
        "First deployment requires empty or browser-profile-only application storage",
      ),
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
    export RENTAL_BACKUP_ROOT=$1/backups
    protected_snapshot="$RENTAL_BACKUP_ROOT/protected/pre-sqlite-bridge"
    mkdir -p "$protected_snapshot"
    deployment_protect_migration_release "$evidence" "$protected_snapshot"
    candidate="ghcr.io/example/arm-rental@sha256:"
    candidate+=$(printf '%064d' 0 | tr 0 e)
    next=$(deployment_write_evidence \
      success systemd:rental-deploy "$candidate" "" "${2}" \
      "/mnt/backups/daily/2026-07-26T00:00:00Z" false \
      not-applicable "/var/lib/rental-apartments/releases/${2}-e")
    deployment_update_retention_index "$next"
    jq -e '
      .schemaVersion == 2 and
      .minimumRetainedReleases == 3 and
      (.protectedReleases | length) == 1 and
      .protectedReleases[0].protectedSnapshot ==
        ($ENV.RENTAL_BACKUP_ROOT + "/protected/pre-sqlite-bridge") and
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

test("deployment classifies cutover from metadata and binds it to the protected bridge", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "deploy-state-transition-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, "state");
  const backups = join(root, "backups");
  const protectedSnapshot = join(
    backups,
    "protected",
    "pre-sqlite-2026-08-18T10-00-00Z",
  );
  const previousRelease = join(root, "bridge-release");
  await Promise.all([
    mkdir(state, { recursive: true }),
    mkdir(protectedSnapshot, { recursive: true }),
    mkdir(previousRelease, { recursive: true }),
  ]);
  const previousImage = digest("a");
  const candidateImage = digest("b");
  const revision = "a".repeat(40);
  const previousMetadata = join(previousRelease, "release-metadata.json");
  const candidateMetadata = join(root, "candidate-metadata.json");
  const migrationCalls = join(root, "migration-calls");
  await Promise.all([
    writeFile(
      previousMetadata,
      JSON.stringify({
        schemaVersion: 2,
        imageReference: previousImage,
        sourceRevision: revision,
        stateBackend: "json",
        minimumStateSchema: 0,
        maximumStateSchema: 0,
      }),
    ),
    writeFile(
      candidateMetadata,
      JSON.stringify({
        schemaVersion: 2,
        imageReference: candidateImage,
        stateBackend: "sqlite",
        minimumStateSchema: 1,
        maximumStateSchema: 1,
      }),
    ),
    writeFile(
      join(state, "deployment-retention.json"),
      JSON.stringify({
        schemaVersion: 2,
        protectedReleases: [
          {
            candidateImage: previousImage,
            sourceRevision: revision,
            releaseDirectory: previousRelease,
            protectedSnapshot,
          },
        ],
      }),
    ),
  ]);
  const script = `
    set -Eeuo pipefail
    RENTAL_OPS_STATE_DIR=$1
    RENTAL_BACKUP_ROOT=$2
    source ops/lib/deployment.sh
    test "$(deployment_state_transition "$3" "$4" "$5" "$6")" = json-to-sqlite
    test "$(deployment_bridge_protected_snapshot "$3" "$5" "$7")" = "$8"
    jq '.stateBackend = "sqlite" | .minimumStateSchema = 1 | .maximumStateSchema = 1' "$3" >"$3.next"
    mv "$3.next" "$3"
    test "$(deployment_state_transition "$3" "$4" "$5" "$6")" = sqlite-to-sqlite
    migration_log=$9
    ops_set_step() { :; }
    deployment_compose() {
      command="\${!#}"
      printf '%s\n' "$command" >>"$migration_log"
      [[ $command != "\${FAIL_MIGRATION_COMMAND:-}" ]]
    }
    export FAIL_MIGRATION_COMMAND=migrate
    if deployment_migrate_json_state candidate-release candidate-environment; then
      exit 1
    fi
    test "$(cat "$migration_log")" = $'plan\nmigrate'
    : >"$migration_log"
    unset FAIL_MIGRATION_COMMAND
    deployment_migrate_json_state candidate-release candidate-environment
    test "$(cat "$migration_log")" = $'plan\nmigrate\nvalidate'
  `;
  await executeFile(
    "bash",
    [
      "-c",
      script,
      "deploy-state-transition-test",
      state,
      backups,
      previousMetadata,
      candidateMetadata,
      previousImage,
      candidateImage,
      previousRelease,
      protectedSnapshot,
      migrationCalls,
    ],
    { cwd: new URL("..", import.meta.url) },
  );

  const retention = JSON.parse(
    await readFile(join(state, "deployment-retention.json"), "utf8"),
  );
  retention.protectedReleases[0].candidateImage = digest("c");
  await writeFile(
    join(state, "deployment-retention.json"),
    JSON.stringify(retention),
  );
  await assert.rejects(
    executeFile(
      "bash",
      [
        "-c",
        `
          set -Eeuo pipefail
          RENTAL_OPS_STATE_DIR=$1
          RENTAL_BACKUP_ROOT=$2
          source ops/lib/deployment.sh
          deployment_bridge_protected_snapshot "$3" "$4" "$5"
        `,
        "deploy-state-transition-test",
        state,
        backups,
        previousMetadata,
        previousImage,
        previousRelease,
      ],
      { cwd: new URL("..", import.meta.url) },
    ),
    (error) =>
      error.code === 65 &&
      error.stderr.includes("not the protected rollback image"),
  );
});

test("unattended deploy contract covers no-op, first install, rollback, and failed rollback", async () => {
  const [
    deploy,
    library,
    operations,
    launcher,
    rentalctlLauncher,
    hostBootstrap,
    service,
    timer,
    migrationProtection,
    migrationUnprotection,
  ] = await Promise.all([
    readFile(new URL("../ops/deploy", import.meta.url), "utf8"),
    readFile(new URL("../ops/lib/deployment.sh", import.meta.url), "utf8"),
    readFile(new URL("../ops/lib/operations.sh", import.meta.url), "utf8"),
    readFile(new URL("../ops/deploy-launcher", import.meta.url), "utf8"),
    readFile(new URL("../ops/rentalctl-launcher", import.meta.url), "utf8"),
    readFile(
      new URL("../infra/hcloud/host-bootstrap.sh", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../infra/systemd/rental-deploy.service", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../infra/systemd/rental-deploy.timer", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../ops/protect-migration-rollback", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../ops/unprotect-migration-rollback", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(operations, /operations\.lock/u);
  assert.match(deploy, /deployment\.noop/u);
  assert.match(deploy, /DEPLOYMENT_FIRST_INSTALL=true/u);
  assert.match(deploy, /deployment_validate_first_install_storage/u);
  assert.match(deploy, /deployment\.first-install\.rejected/u);
  assert.match(deploy, /deployment\.rollback\.completed/u);
  assert.match(deploy, /deployment\.rollback\.failed/u);
  assert.match(deploy, /deployment_write_quarantine/u);
  assert.match(deploy, /node src\/recovery-cli\.js backup/u);
  assert.match(deploy, /node src\/recovery-cli\.js restore/u);
  assert.match(library, /for command in plan migrate validate/u);
  assert.match(library, /node src\/state-migration-cli\.js "\$command"/u);
  assert.match(deploy, /DEPLOYMENT_STATE_TRANSITION == json-to-sqlite/u);
  assert.match(deploy, /deployment_bridge_protected_snapshot/u);
  assert.ok(
    deploy.indexOf("ops_stop_application") <
      deploy.indexOf("deployment_migrate_json_state") &&
      deploy.indexOf("deployment_migrate_json_state") <
        deploy.indexOf("up --detach --force-recreate bot"),
    "JSON cutover must stop, plan, migrate, validate, and only then launch",
  );
  assert.ok(
    deploy.indexOf("validate-protected-bridge") <
      deploy.indexOf("ops_stop_application"),
    "an unusable rollback point must be refused before the bot is stopped",
  );
  assert.match(deploy, /deployment_read_optional_setting POLL_INTERVAL_MS/u);
  assert.match(deploy, /poll_interval_ms=\$\{poll_interval_ms:-60000\}/u);
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
  assert.match(
    rentalctlLauncher,
    /\/usr\/local\/lib\/rental-apartments-bootstrap\/ops\/rentalctl/u,
  );
  assert.match(
    rentalctlLauncher,
    /\/opt\/rental-apartments\/current\/ops\/rentalctl/u,
  );
  assert.match(
    hostBootstrap,
    /install_file "\$SOURCE_ROOT\/ops\/rentalctl-launcher" \/usr\/local\/bin\/rentalctl 0755/u,
  );
  assert.match(service, /ExecStart=\/usr\/local\/sbin\/rental-deploy/u);
  assert.match(deploy, /image_retention_cleanup apply rental-deploy/u);
  assert.match(deploy, /deployment\.image-cleanup\.deferred/u);
  assert.match(service, /TimeoutStartSec=30min/u);
  assert.doesNotMatch(service, /RuntimeMaxSec/u);
  assert.match(timer, /OnBootSec=5min/u);
  assert.match(timer, /OnCalendar=\*-\*-\* \*:00\/5:00 UTC/u);
  assert.match(timer, /Persistent=true/u);
  assert.match(migrationProtection, /backup-protected/u);
  assert.match(migrationProtection, /deployment_protect_migration_release/u);
  assert.match(migrationProtection, /ops_validate_snapshot/u);
  assert.match(migrationUnprotection, /deployment_validate_actor/u);
  assert.match(
    migrationUnprotection,
    /deployment_unprotect_migration_release/u,
  );
  assert.match(migrationUnprotection, /ops_acquire_lock/u);
  assert.doesNotMatch(
    migrationUnprotection,
    /ops_stop_application/u,
    "releasing a rollback point is a state edit and must not stop the bot",
  );
});

test("a rollback point protected against a superseded release can be replaced", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "deploy-unprotect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, "state");
  const backups = join(root, "backups");
  const staleSnapshot = join(
    backups,
    "protected",
    "pre-sqlite-2026-08-18T17-57-40-023Z",
  );
  const freshSnapshot = join(
    backups,
    "protected",
    "pre-sqlite-2026-08-19T07-32-32-202Z",
  );
  const bridgeRelease = join(root, "bridge-release");
  await Promise.all([
    mkdir(state, { recursive: true }),
    mkdir(staleSnapshot, { recursive: true }),
    mkdir(freshSnapshot, { recursive: true }),
    mkdir(bridgeRelease, { recursive: true }),
  ]);
  const staleImage = digest("a");
  const currentImage = digest("b");
  const retentionFile = join(state, "deployment-retention.json");
  const evidenceFile = join(root, "evidence.json");
  await Promise.all([
    writeFile(
      retentionFile,
      JSON.stringify({
        schemaVersion: 2,
        retainedReleases: [],
        protectedReleases: [
          {
            candidateImage: staleImage,
            sourceRevision: "a".repeat(40),
            releaseDirectory: bridgeRelease,
            protectedSnapshot: staleSnapshot,
          },
        ],
      }),
      { mode: 0o600 },
    ),
    writeFile(
      evidenceFile,
      JSON.stringify({
        candidateImage: currentImage,
        sourceRevision: "b".repeat(40),
        releaseDirectory: bridgeRelease,
      }),
      { mode: 0o600 },
    ),
  ]);

  const preamble = `
    set -Eeuo pipefail
    RENTAL_OPS_STATE_DIR=$1
    RENTAL_BACKUP_ROOT=$2
    source ops/lib/deployment.sh
  `;
  const run = (script, ...extra) =>
    executeFile(
      "bash",
      [
        "-c",
        `${preamble}\n${script}`,
        "deploy-unprotect-test",
        state,
        backups,
        ...extra,
      ],
      { cwd: new URL("..", import.meta.url) },
    );

  // Naming the wrong image must not clear anything: the mistake this repairs
  // is a protection taken against a release nobody re-read.
  await assert.rejects(
    run('deployment_unprotect_migration_release "$3"', currentImage),
    (error) =>
      error.code === 65 &&
      error.stderr.includes("No single protected rollback point is registered"),
  );
  assert.equal(
    JSON.parse(await readFile(retentionFile, "utf8")).protectedReleases.length,
    1,
    "a rejected unprotect must leave the protection intact",
  );

  // Replacing a protection is refused until the stale one is released.
  await assert.rejects(
    run(
      'deployment_protect_migration_release "$3" "$4"',
      evidenceFile,
      freshSnapshot,
    ),
    (error) => error.code === 65,
  );

  const released = await run(
    'deployment_unprotect_migration_release "$3"',
    staleImage,
  );
  assert.equal(released.stdout.trim(), staleSnapshot);
  assert.deepEqual(
    JSON.parse(await readFile(retentionFile, "utf8")).protectedReleases,
    [],
  );

  await run(
    'deployment_protect_migration_release "$3" "$4"',
    evidenceFile,
    freshSnapshot,
  );
  const retention = JSON.parse(await readFile(retentionFile, "utf8"));
  assert.equal(retention.protectedReleases.length, 1);
  assert.equal(retention.protectedReleases[0].candidateImage, currentImage);
  assert.equal(retention.protectedReleases[0].protectedSnapshot, freshSnapshot);
});

test("a refused candidate names the contract it failed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "deploy-verify-reason-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const metadata = join(root, "release-metadata.json");
  const candidate = digest("c");
  await writeFile(
    metadata,
    JSON.stringify({
      schemaVersion: 2,
      imageReference: candidate,
      imageDigest: candidate.slice(candidate.indexOf("@") + 1),
      sourceRevision: "d".repeat(40),
      stateBackend: "json",
      minimumStateSchema: 0,
      maximumStateSchema: 0,
      packageLockSha256: "0".repeat(64),
      composeSha256: "0".repeat(64),
      operationsBundleSha256: "0".repeat(64),
    }),
  );

  await assert.rejects(
    executeFile(
      "bash",
      [
        "-c",
        `
          set -Eeuo pipefail
          RENTAL_OPS_STATE_DIR=$1
          DEPLOYMENT_SOURCE_REVISION=$2
          source ops/lib/deployment.sh
          deployment_verify_release "$1/absent-bundle" "$3" "$4"
        `,
        "deploy-verify-reason-test",
        root,
        "d".repeat(40),
        candidate,
        metadata,
      ],
      { cwd: new URL("..", import.meta.url) },
    ),
    (error) =>
      error.code === 65 &&
      // Both halves of the mismatch: what arrived and what this release takes.
      error.stderr.includes("stateBackend json, state schema 0-0") &&
      error.stderr.includes("stateBackend sqlite, state schema 1-1"),
  );
});

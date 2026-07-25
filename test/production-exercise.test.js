import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const script = path.join(repositoryRoot, "ops", "production-exercise");
const previousImage = `ghcr.io/example/rental-apartments@sha256:${"a".repeat(64)}`;
const candidateImage = `ghcr.io/example/rental-apartments@sha256:${"b".repeat(64)}`;
const firstBootId = "11111111-1111-4111-8111-111111111111";
const secondBootId = "22222222-2222-4222-8222-222222222222";

async function executable(filename, source) {
  await writeFile(filename, source, { mode: 0o755 });
  await chmod(filename, 0o755);
}

async function fixture(t, { restoreFails = false, timersNever = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "production-exercise-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fakeBin = path.join(root, "bin");
  const state = path.join(root, "state");
  const deployments = path.join(state, "deployments");
  const quarantine = path.join(state, "quarantine");
  const evidence = path.join(root, "evidence.json");
  const imageFile = path.join(state, "current-image.env");
  const bootIdFile = path.join(root, "boot-id");
  const commandLog = path.join(root, "commands.log");
  await Promise.all([
    mkdir(fakeBin),
    mkdir(deployments, { recursive: true }),
    mkdir(quarantine, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(imageFile, `RENTAL_APARTMENTS_IMAGE=${previousImage}\n`, {
      mode: 0o600,
    }),
    writeFile(bootIdFile, `${firstBootId}\n`),
  ]);

  const prelude = `#!/usr/bin/env bash
set -eu
printf '%s %s\\n' "\${0##*/}" "$*" >>"$FAKE_COMMAND_LOG"
`;
  await executable(
    path.join(fakeBin, "systemctl"),
    `${prelude}
if [[ "\${1:-}" == "start" && "\${2:-}" == "rental-deploy.service" ]]; then
  mkdir -p "$RENTAL_DEPLOYMENTS_DIR" "$RENTAL_QUARANTINE_DIR"
  if [[ -f "$RENTAL_OPS_STATE_DIR/fake-deploy-failed-once" ]]; then
    : >"$RENTAL_OPS_STATE_DIR/fake-deploy-retry-success"
    exit 0
  fi
  digest="\${FAKE_CANDIDATE##*@sha256:}"
  printf '%s\\n' "$FAKE_DEPLOYMENT_RECEIPT" >"$RENTAL_DEPLOYMENTS_DIR/observed.json"
  printf '%s\\n' '{"schemaVersion":1}' >"$RENTAL_QUARANTINE_DIR/$digest.json"
  : >"$RENTAL_OPS_STATE_DIR/fake-deploy-failed-once"
  exit 1
fi
if [[ "\${1:-}" == "start" && "\${2:-}" == "rental-restore-drill.service" ]]; then
  exit "$FAKE_RESTORE_STATUS"
fi
if [[ "\${1:-}" == "show" ]]; then
  unit="\${2:-}"
  property="\${3:-}"
  case "$property" in
    --property=Result)
      case "$unit" in
        rental-deploy.service)
          if [[ -f "$RENTAL_OPS_STATE_DIR/fake-deploy-retry-success" ]]; then
            printf '%s\\n' success
          else
            printf '%s\\n' failed
          fi
          ;;
        rental-restore-drill.service)
          if [[ "$FAKE_RESTORE_STATUS" == "0" ]]; then
            printf '%s\\n' success
          else
            printf '%s\\n' failed
          fi
          ;;
        *) printf '%s\\n' success ;;
      esac
      ;;
    --property=LastTriggerUSec)
      if [[ "$FAKE_TIMERS_NEVER" == "1" ]]; then printf '%s\\n' n/a
      else printf '%s\\n' 2026-07-25T11:59:00Z
      fi
      ;;
    --property=NextElapseUSecRealtime)
      printf '%s\\n' 2026-07-25T12:05:00Z
      ;;
  esac
  exit 0
fi
case "\${1:-}" in
  is-active|is-enabled|restart|reboot|start) exit 0 ;;
esac
exit 0
`,
  );
  await executable(
    path.join(fakeBin, "docker"),
    `${prelude}
if [[ "\${1:-}" == "inspect" ]]; then printf '%s\\n' healthy; exit 0; fi
exit 0
`,
  );
  await executable(
    path.join(fakeBin, "journalctl"),
    `${prelude}
if [[ "$FAKE_RESTORE_STATUS" == "0" ]]; then
  printf '%s\\n' '{"event":"restore-drill.completed","result":"success","durationMs":12000}'
else
  printf '%s\\n' '{"event":"restore-drill.failed","result":"failure","durationMs":500}'
  printf '%s\\n' 'credential=never-copy-raw-journal-output'
fi
`,
  );
  await executable(
    path.join(fakeBin, "date"),
    `${prelude}
case "$*" in
  "-u +%Y-%m-%dT%H:%M:%SZ") printf '%s\\n' 2026-07-25T12:00:00Z ;;
  "-u +%Y%m%dT%H%M%SZ") printf '%s\\n' 20260725T120000Z ;;
  "+%s") printf '%s\\n' 1784980800 ;;
  --date=2026-07-25T11:59:00Z*" +%s") printf '%s\\n' 1784980740 ;;
  --date=2026-07-25T11:59:00Z*) printf '%s\\n' 2026-07-25T11:59:00Z ;;
  --date=2026-07-25T12:05:00Z*) printf '%s\\n' 2026-07-25T12:05:00Z ;;
  *) printf 'unexpected fake date invocation: %s\\n' "$*" >&2; exit 9 ;;
esac
`,
  );
  await executable(
    path.join(fakeBin, "git"),
    `${prelude}
printf '%040d\\n' 1
`,
  );
  await executable(
    path.join(fakeBin, "stat"),
    `${prelude}
if [[ "\${1:-}" == "--format=%a" ]]; then printf '%s\\n' 600; else exit 9; fi
`,
  );
  for (const command of ["sleep", "sync"]) {
    await executable(path.join(fakeBin, command), `${prelude}\nexit 0\n`);
  }

  const receipt = JSON.stringify({
    schemaVersion: 1,
    outcome: "failed",
    actor: "systemd:rental-deploy",
    candidateImage,
    previousImage,
    sourceRevision: "c".repeat(40),
    snapshot: "/sanitized/snapshot",
    firstInstall: false,
    rollback: { attempted: true, result: "completed" },
    completedAt: "2026-07-25T12:00:00Z",
  });
  const environment = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    FAKE_COMMAND_LOG: commandLog,
    FAKE_CANDIDATE: candidateImage,
    FAKE_DEPLOYMENT_RECEIPT: receipt,
    FAKE_RESTORE_STATUS: restoreFails ? "1" : "0",
    FAKE_TIMERS_NEVER: timersNever ? "1" : "0",
    RENTAL_OPS_STATE_DIR: state,
    RENTAL_IMAGE_ENV_FILE: imageFile,
    RENTAL_DEPLOYMENTS_DIR: deployments,
    RENTAL_QUARANTINE_DIR: quarantine,
    RENTAL_BOOT_ID_FILE: bootIdFile,
    RENTAL_EXERCISE_READY_ATTEMPTS: "1",
    RENTAL_EXERCISE_READY_INTERVAL_SECONDS: "0",
    RENTAL_REPOSITORY_REVISION: "d".repeat(40),
  };
  return {
    root,
    evidence,
    bootIdFile,
    commandLog,
    environment,
  };
}

function run(args, environment) {
  return new Promise((resolve) => {
    const child = spawn(script, args, {
      cwd: repositoryRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function initialize(fixtureValue) {
  const result = await run(
    [
      "init",
      "--evidence",
      fixtureValue.evidence,
      "--actor",
      "human:production-owner",
      "--host-alias",
      "production-vps",
    ],
    fixtureValue.environment,
  );
  assert.equal(result.status, 0, result.stderr);
}

test("exercise harness records observed recovery outcomes without raw logs or secrets", async (t) => {
  const value = await fixture(t);
  await initialize(value);

  let result = await run(
    ["restore-drill", "--evidence", value.evidence],
    value.environment,
  );
  assert.equal(result.status, 0, result.stderr);
  result = await run(
    [
      "failed-deployment",
      "--evidence",
      value.evidence,
      "--candidate",
      candidateImage,
      "--previous",
      previousImage,
    ],
    value.environment,
  );
  assert.equal(result.status, 0, result.stderr);
  result = await run(
    ["docker-restart", "--evidence", value.evidence],
    value.environment,
  );
  assert.equal(result.status, 0, result.stderr);
  result = await run(
    ["reboot-before", "--evidence", value.evidence, "--request-reboot"],
    value.environment,
  );
  assert.equal(result.status, 0, result.stderr);
  await writeFile(value.bootIdFile, `${secondBootId}\n`);
  result = await run(
    ["reboot-after", "--evidence", value.evidence],
    value.environment,
  );
  assert.equal(result.status, 0, result.stderr);
  result = await run(
    ["timers", "--evidence", value.evidence],
    value.environment,
  );
  assert.equal(
    result.status,
    0,
    `${result.stderr}\n${await readFile(value.evidence, "utf8")}`,
  );
  result = await run(
    ["finalize", "--evidence", value.evidence],
    value.environment,
  );
  assert.equal(result.status, 0, result.stderr);
  result = await run(
    ["validate", "--evidence", value.evidence],
    value.environment,
  );
  assert.equal(result.status, 0, result.stderr);

  const source = await readFile(value.evidence, "utf8");
  const evidence = JSON.parse(source);
  assert.equal(evidence.overallStatus, "observed-pass");
  assert.equal(evidence.completedAt, "2026-07-25T12:00:00Z");
  assert.deepEqual(
    Object.values(evidence.exercises).map(({ status }) => status),
    Array(5).fill("observed-pass"),
  );
  assert.equal(evidence.exercises.timerFreshness.timers.length, 7);
  assert.equal(
    evidence.exercises.failedDeploymentRollback.rollbackResult,
    "completed",
  );
  assert.equal(evidence.exercises.hostRebootRecovery.beforeBootId, firstBootId);
  assert.equal(evidence.exercises.hostRebootRecovery.afterBootId, secondBootId);
  assert.doesNotMatch(
    source,
    /never-copy-raw|TELEGRAM_BOT_TOKEN|GHCR_READ_TOKEN|Authorization:/iu,
  );
  assert.equal((await stat(value.evidence)).mode & 0o777, 0o600);

  const commands = await readFile(value.commandLog, "utf8");
  assert.match(commands, /systemctl start rental-restore-drill\.service/u);
  assert.match(commands, /systemctl start rental-deploy\.service/u);
  assert.match(commands, /systemctl restart docker\.service/u);
  assert.match(commands, /systemctl reboot --no-block/u);
});

test("failed observations remain explicit and never become launch approval", async (t) => {
  const value = await fixture(t, { restoreFails: true });
  await initialize(value);
  const restore = await run(
    ["restore-drill", "--evidence", value.evidence],
    value.environment,
  );
  assert.notEqual(restore.status, 0);
  const finalized = await run(
    ["finalize", "--evidence", value.evidence],
    value.environment,
  );
  assert.notEqual(finalized.status, 0);
  const evidence = JSON.parse(await readFile(value.evidence, "utf8"));
  assert.equal(evidence.overallStatus, "observed-fail");
  assert.equal(evidence.exercises.restoreDrill.status, "observed-fail");
  assert.equal(
    evidence.exercises.restoreDrill.terminalEvent,
    "restore-drill.failed",
  );
  assert.doesNotMatch(JSON.stringify(evidence), /never-copy-raw/u);
});

test("disruptive phases require exact preconditions and incomplete timer history stays pending", async (t) => {
  const value = await fixture(t, { timersNever: true });
  await initialize(value);

  const reboot = await run(
    ["reboot-before", "--evidence", value.evidence],
    value.environment,
  );
  assert.equal(reboot.status, 64);
  assert.match(reboot.stderr, /--request-reboot/u);

  const mismatch = await run(
    [
      "failed-deployment",
      "--evidence",
      value.evidence,
      "--candidate",
      candidateImage,
      "--previous",
      `ghcr.io/example/rental-apartments@sha256:${"e".repeat(64)}`,
    ],
    value.environment,
  );
  assert.equal(mismatch.status, 64);
  assert.match(mismatch.stderr, /does not match --previous/u);

  const timers = await run(
    ["timers", "--evidence", value.evidence],
    value.environment,
  );
  assert.equal(timers.status, 0, timers.stderr);
  const finalized = await run(
    ["finalize", "--evidence", value.evidence],
    value.environment,
  );
  assert.equal(finalized.status, 0, finalized.stderr);
  const evidence = JSON.parse(await readFile(value.evidence, "utf8"));
  assert.equal(evidence.overallStatus, "pending");
  assert.equal(evidence.completedAt, null);
  assert.ok(
    evidence.exercises.timerFreshness.timers.every(
      ({ status, lastResult }) =>
        status === "pending" && lastResult === "never",
    ),
  );
});

test("the committed evidence artifact is a pending template, not invented VPS evidence", async () => {
  const [schema, template] = await Promise.all([
    readFile(
      new URL(
        "../docs/production-exercise-evidence.schema.json",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../docs/production-exercise-evidence.template.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
  const schemaDocument = JSON.parse(schema);
  const templateDocument = JSON.parse(template);
  assert.equal(
    schemaDocument.$schema,
    "https://json-schema.org/draft/2020-12/schema",
  );
  assert.equal(templateDocument.evidenceKind, "repository-template");
  assert.equal(templateDocument.overallStatus, "pending");
  assert.equal(templateDocument.completedAt, null);
  assert.ok(
    Object.values(templateDocument.exercises).every(
      ({ status }) => status === "pending",
    ),
  );
  assert.deepEqual(templateDocument.sanitization, {
    rawLogsIncluded: false,
    secretsIncluded: false,
    collectionPolicy: "allowlisted-status-fields-only",
  });
});

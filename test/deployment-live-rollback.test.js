import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const executeFile = promisify(execFile);
const root = new URL("..", import.meta.url);
const previousImage = `ghcr.io/example/arm-rental@sha256:${"a".repeat(64)}`;
const runningImageId = `sha256:${"b".repeat(64)}`;

test("deploy re-pulls the recorded previous digest before stopping for backup", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "deploy-previous-image-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const metadata = join(directory, "release-metadata.json");
  const log = join(directory, "docker.log");
  await writeFile(metadata, JSON.stringify({ runtime: "node" }));
  const script = String.raw`
    set -Eeuo pipefail
    METADATA=$1
    LOG=$2
    PREVIOUS_IMAGE=$3
    RUNNING_ID=$4
    RENTAL_OPS_STATE_DIR=$(dirname "$LOG")
    RENTAL_CONTAINER_NAME=rental-apartments-bot
    source ops/lib/deployment.sh
    docker() {
      printf '%s:%s\n' "$1" "$2" >> "$LOG"
      if [[ $1 == pull ]]; then
        : >"$LOG.pulled"
        return
      fi
      if [[ $1 == inspect ]]; then
        case $3 in
          '{{.Image}}') printf '%s\n' "$RUNNING_ID" ;;
          *) printf 'node\n' ;;
        esac
        return
      fi
      if [[ $1 == image && $2 == inspect ]]; then
        [[ -f $LOG.pulled ]] || return 91
        case $4 in
          '{{.Id}}')
            if [[ $SCENARIO == mismatch ]]; then printf 'sha256:%064d\n' 0;
            else printf '%s\n' "$RUNNING_ID"; fi ;;
          *) printf '["%s"]\n' "$PREVIOUS_IMAGE" ;;
        esac
        return
      fi
      return 99
    }
    deployment_retain_previous_image "$PREVIOUS_IMAGE" "$METADATA"
  `;
  const deploy = await readFile(
    new URL("../ops/deploy", import.meta.url),
    "utf8",
  );
  assert.ok(
    deploy.indexOf("retain-previous-image") <
      deploy.indexOf("ops_stop_application"),
    "the previous digest must be restored before stopping the service",
  );
  await executeFile(
    "bash",
    ["-c", script, "retain-test", metadata, log, previousImage, runningImageId],
    { cwd: root, env: { ...process.env, SCENARIO: "matching" } },
  );
  const calls = (await readFile(log, "utf8")).trim().split("\n");
  assert.deepEqual(calls.slice(0, 4), [
    "inspect:--format",
    `pull:${previousImage}`,
    "image:inspect",
    "image:inspect",
  ]);

  await rm(`${log}.pulled`);
  await assert.rejects(
    executeFile(
      "bash",
      [
        "-c",
        script,
        "retain-test",
        metadata,
        log,
        previousImage,
        runningImageId,
      ],
      { cwd: root, env: { ...process.env, SCENARIO: "mismatch" } },
    ),
    (error) => error.code === 65 && error.stderr.includes("does not match"),
  );
});

const recoverScript = String.raw`
  set -Eeuo pipefail
  METADATA=$1
  SCENARIO=$2
  LOG=$3
  PREVIOUS_IMAGE=$4
  RENTAL_CONTAINER_NAME=rental-apartments-bot
  RENTAL_OPS_STATE_DIR=$(dirname "$LOG")
  source ops/lib/deployment.sh
  docker() {
    if [[ $1 == image && $2 == inspect ]]; then
      if [[ $SCENARIO == label-mismatch ]]; then
        printf '{"com.rental-apartments.state.backend":"sqlite","com.rental-apartments.state.schema.minimum":"1","com.rental-apartments.state.schema.maximum":"5"}\n'
      else
        printf '{"com.rental-apartments.state.backend":"sqlite","com.rental-apartments.state.schema.minimum":"1","com.rental-apartments.state.schema.maximum":"6"}\n'
      fi
      return
    fi
    if [[ $1 == inspect ]]; then
      if [[ $SCENARIO == still-running ]]; then printf 'true\n'; else printf 'false\n'; fi
      return
    fi
    return 99
  }
  deployment_compose() {
    printf 'compose:%s:%s\n' "$1" "$3" >> "$LOG"
    if [[ $SCENARIO == candidate-stop-fails && $1 == candidate-release && $3 == stop ]]; then
      return 71
    fi
    if [[ $3 == run ]]; then
      case $SCENARIO in
        corrupt) printf 'not-json\n' ;;
        incompatible) printf '{"stateBackend":"sqlite","stateSchema":7}\n' ;;
        *) printf '{"stateBackend":"sqlite","stateSchema":6}\n' ;;
      esac
    fi
  }
  deployment_restore_current() { printf 'restore-pointer\n' >> "$LOG"; }
  ops_start_application() {
    printf 'start-node\n' >> "$LOG"
    [[ $SCENARIO != restart-fails ]]
  }
  ops_stop_application() { printf 'stop-node\n' >> "$LOG"; }
  set +e
  deployment_recover_node_from_live_state \
    candidate-release candidate-env previous-release previous-env \
    "$METADATA" "$PREVIOUS_IMAGE"
  result=$?
  set -e
  printf '%s\n' "$result"
`;

test("failed Rust rollout selects compatible live state without snapshot restore", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "deploy-live-rollback-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const metadata = join(directory, "release-metadata.json");
  await writeFile(
    metadata,
    JSON.stringify({
      imageReference: previousImage,
      stateBackend: "sqlite",
      minimumStateSchema: 1,
      maximumStateSchema: 6,
    }),
  );

  for (const [scenario, expectedSuccess, expectedCalls] of [
    [
      "compatible",
      true,
      [
        "compose:candidate-release:stop",
        "restore-pointer",
        "compose:candidate-release:run",
        "start-node",
      ],
    ],
    [
      "incompatible",
      false,
      [
        "compose:candidate-release:stop",
        "restore-pointer",
        "compose:candidate-release:run",
      ],
    ],
    [
      "corrupt",
      false,
      [
        "compose:candidate-release:stop",
        "restore-pointer",
        "compose:candidate-release:run",
      ],
    ],
    [
      "restart-fails",
      false,
      [
        "compose:candidate-release:stop",
        "restore-pointer",
        "compose:candidate-release:run",
        "start-node",
        "stop-node",
        "compose:previous-release:stop",
      ],
    ],
    ["candidate-stop-fails", false, ["compose:candidate-release:stop"]],
    ["still-running", false, ["compose:candidate-release:stop"]],
    [
      "label-mismatch",
      false,
      [
        "compose:candidate-release:stop",
        "restore-pointer",
        "compose:candidate-release:run",
      ],
    ],
  ]) {
    const log = join(directory, `${scenario}.log`);
    const { stdout } = await executeFile(
      "bash",
      [
        "-c",
        recoverScript,
        "rollback-test",
        metadata,
        scenario,
        log,
        previousImage,
      ],
      { cwd: root },
    );
    assert.equal(stdout.trim() === "0", expectedSuccess, scenario);
    assert.deepEqual(
      (await readFile(log, "utf8")).trim().split("\n"),
      expectedCalls,
      scenario,
    );
  }
});

test("an unexpected exit after candidate launch uses guarded recovery", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "deploy-trap-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = join(directory, "trap.log");
  const temporary = join(directory, "temporary");
  await mkdir(temporary);
  await writeFile(join(temporary, "compose.env"), "candidate=image\n");
  const deploy = await readFile(
    new URL("../ops/deploy", import.meta.url),
    "utf8",
  );
  const recover = deploy.match(
    /^deployment_recover_candidate\(\) \{[\s\S]*?^\}/mu,
  )?.[0];
  const cleanup = deploy.match(/^ops_cleanup\(\) \{[\s\S]*?^\}/mu)?.[0];
  assert.ok(recover, "deploy must choose its recovery strategy");
  assert.ok(cleanup, "deploy must define its exit cleanup");
  const script =
    String.raw`
    set -Eeuo pipefail
    LOG=$1
    DEPLOYMENT_TEMPORARY_DIR=$2
    source ops/lib/common.sh
    ops_emit_record() { :; }
    deployment_emit() { :; }
    deployment_emit_alert() { :; }
    deployment_recover_node_from_live_state() {
      [[ -f $DEPLOYMENT_TEMPORARY_DIR/compose.env ]] || return 91
      printf 'guarded-live-recovery\n' >> "$LOG"
    }
    deployment_recover_previous_snapshot() { printf 'snapshot-restore\n' >> "$LOG"; }
    ops_start_application() { printf 'blind-start\n' >> "$LOG"; }
    DEPLOYMENT_RESTART_REQUIRED=1
    DEPLOYMENT_CANDIDATE_MAY_RUN=1
    DEPLOYMENT_LIVE_ROLLBACK_REQUIRED=1
    DEPLOYMENT_RELEASE=candidate-release
    DEPLOYMENT_CANDIDATE_ENV=candidate-env
    DEPLOYMENT_PREVIOUS_RELEASE=previous-release
    DEPLOYMENT_PREVIOUS_ENV=previous-env
    DEPLOYMENT_CANDIDATE=candidate
    DEPLOYMENT_PREVIOUS=previous
  ` +
    recover +
    "\n" +
    cleanup +
    String.raw`
    ops_begin deployment test-deploy
    exit 19
  `;
  await assert.rejects(
    executeFile("bash", ["-c", script, "trap-test", log, temporary], {
      cwd: root,
    }),
    (error) => error.code === 19,
  );
  assert.equal((await readFile(log, "utf8")).trim(), "guarded-live-recovery");
  await assert.rejects(readFile(join(temporary, "compose.env")), {
    code: "ENOENT",
  });
});

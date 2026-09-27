import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertRollbackStateCompatibility } from "../src/release-compatibility.js";
import { SQLITE_APPLICATION_ID } from "../src/sqlite-schema.js";

const executeFile = promisify(execFile);
const DIGEST_REFERENCE =
  /^(?:sha256:[a-f0-9]{64}|[a-z0-9][a-z0-9._/-]*(?::[a-z0-9._-]+)?@sha256:[a-f0-9]{64})$/u;
const SNAPSHOT_PATH =
  /^\/app-backups\/(?:daily|weekly)\/[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u;
const OPERATIONS = new Set(["validate", "deploy", "rollback"]);
const DELIVERY_MODES = new Set(["private", "channel", "both"]);
const STATE_STRATEGIES = new Set(["compatible", "restore"]);
const PRODUCTION_RELEASE_TRUST = Object.freeze({
  root: "/var/lib/rental-apartments/releases",
  ancestors: ["/", "/var", "/var/lib", "/var/lib/rental-apartments"],
  rootOwnerAccount: "rental-deploy",
  releaseOwnerUid: 0,
});
const ARGUMENT_NAMES = new Set([
  "environment",
  "actor",
  "image",
  "previous-image",
  "snapshot",
  "poll-interval-ms",
  "observation-minutes",
  "delivery",
  "state-strategy",
  "evidence-file",
  "compose-file",
  "target-release",
]);

function usage() {
  return [
    "Usage:",
    "  node scripts/release-operations.js validate|deploy|rollback \\",
    "    --environment production --actor IDENTITY \\",
    "    --image IMMUTABLE_REF --previous-image IMMUTABLE_REF \\",
    "    --snapshot /app-backups/daily/ID --poll-interval-ms MS \\",
    "    --observation-minutes MINUTES --delivery private|channel|both \\",
    "    [--state-strategy compatible|restore] [--target-release ABSOLUTE_DIR]",
    "    [--evidence-file PATH] [--dry-run]",
    "",
    "validate and --dry-run never invoke Docker.",
  ].join("\n");
}

function parseArguments(arguments_) {
  const [operation, ...rest] = arguments_;
  if (!OPERATIONS.has(operation)) throw new Error(usage());

  const values = { operation, dryRun: false };
  for (let index = 0; index < rest.length; index += 1) {
    const name = rest[index];
    if (name === "--dry-run") {
      values.dryRun = true;
      continue;
    }
    if (!name?.startsWith("--") || rest[index + 1] === undefined) {
      throw new Error(usage());
    }
    const key = name.slice(2);
    if (!ARGUMENT_NAMES.has(key)) {
      throw new Error(`Unknown --${key} argument`);
    }
    if (Object.hasOwn(values, key)) {
      throw new Error(`Duplicate --${key} argument`);
    }
    values[key] = rest[index + 1];
    index += 1;
  }
  return values;
}

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`--${name} is required`);
  }
  return value.trim();
}

function positiveInteger(value, name) {
  if (!/^[1-9][0-9]*$/u.test(value || "")) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return Number(value);
}

function immutableReference(value, name) {
  const reference = requiredString(value, name);
  if (!DIGEST_REFERENCE.test(reference)) {
    throw new Error(
      `--${name} must be an immutable image ID or registry digest reference`,
    );
  }
  return reference;
}

/**
 * Validates every release input before a mutating Docker command can run.
 * The resulting contract is also the machine-readable dry-run output.
 */
export function createReleaseContract(
  raw,
  releaseTrust = PRODUCTION_RELEASE_TRUST,
) {
  if (!OPERATIONS.has(raw.operation)) {
    throw new Error("operation must be validate, deploy, or rollback");
  }
  const environment = requiredString(raw.environment, "environment");
  if (environment !== "production") {
    throw new Error("--environment must be production");
  }

  const actor = requiredString(raw.actor, "actor");
  if (
    actor.length < 3 ||
    /^(?:unknown|n\/a|none|operator|actor|automation|systemd|github-actions)$/iu.test(
      actor,
    )
  ) {
    throw new Error(
      "--actor must identify the accountable human or automation execution",
    );
  }

  const image = immutableReference(raw.image, "image");
  const previousImage = immutableReference(
    raw["previous-image"],
    "previous-image",
  );
  if (image === previousImage) {
    throw new Error(
      "--image and --previous-image must identify different artifacts",
    );
  }

  const snapshot = requiredString(raw.snapshot, "snapshot");
  if (!SNAPSHOT_PATH.test(snapshot) || snapshot.includes(".snapshot-")) {
    throw new Error(
      "--snapshot must be a published /app-backups/daily|weekly recovery point",
    );
  }

  const pollIntervalMs = positiveInteger(
    raw["poll-interval-ms"],
    "poll-interval-ms",
  );
  const observationMinutes = positiveInteger(
    raw["observation-minutes"],
    "observation-minutes",
  );
  const observationMs = observationMinutes * 60_000;
  if (observationMs < pollIntervalMs + 5 * 60_000) {
    throw new Error(
      "--observation-minutes must cover one full crawl interval plus five minutes",
    );
  }

  const delivery = requiredString(raw.delivery, "delivery");
  if (!DELIVERY_MODES.has(delivery)) {
    throw new Error("--delivery must be private, channel, or both");
  }
  const stateStrategy = raw["state-strategy"] || "compatible";
  if (!STATE_STRATEGIES.has(stateStrategy)) {
    throw new Error("--state-strategy must be compatible or restore");
  }

  const evidenceFile = path.resolve(
    raw["evidence-file"] ||
      `.release-evidence/${environment}-${raw.operation}.json`,
  );
  const composeFile = path.resolve(
    raw["compose-file"] || "compose.production.yaml",
  );
  const projectName = "rental-apartments";
  const releasesRoot = releaseTrust.root;
  if (raw["target-release"] && !path.isAbsolute(raw["target-release"])) {
    throw new Error(
      "--target-release must be an absolute verified release directory",
    );
  }
  const targetRelease = raw["target-release"]
    ? path.resolve(raw["target-release"])
    : undefined;
  if (targetRelease && path.dirname(targetRelease) !== releasesRoot) {
    throw new Error(
      "--target-release must be a direct child of the trusted releases root",
    );
  }

  return {
    schemaVersion: 1,
    operation: raw.operation,
    environment,
    actor,
    image,
    previousImage,
    snapshot,
    pollIntervalMs,
    observationMinutes,
    observationMs,
    delivery,
    stateStrategy,
    composeFile,
    projectName,
    targetRelease,
    releasesRoot,
    releaseTrust,
    evidenceFile,
    dryRun: raw.dryRun || raw.operation === "validate",
  };
}

function composeArguments(contract, runtime, image, ...arguments_) {
  const composeFile =
    runtime === "node" &&
    contract.operation === "rollback" &&
    contract.stateStrategy === "restore" &&
    image === contract.image &&
    contract.targetRelease
      ? path.join(contract.targetRelease, "compose.production.yaml")
      : contract.composeFile;
  return [
    "compose",
    "--project-name",
    contract.projectName,
    "--file",
    composeFile,
    ...(runtime === "rust"
      ? [
          "--file",
          path.join(
            path.dirname(contract.composeFile),
            "ops/compose.native.yaml",
          ),
        ]
      : []),
    ...arguments_,
  ];
}

function commandPlan(contract) {
  const candidateAction =
    contract.operation === "rollback" ? "rollback target" : "candidate";
  return [
    `inspect immutable ${candidateAction} ${contract.image}`,
    `inspect retained previous artifact ${contract.previousImage}`,
    `validate singleton/stop-first Compose contract ${contract.composeFile}`,
    `validate verified snapshot ${contract.snapshot} with ${
      contract.operation === "rollback" && contract.stateStrategy === "restore"
        ? contract.image
        : contract.previousImage
    }`,
    "confirm exactly one expected container and persistent data volume",
    "stop old container and confirm it is not running",
    `start ${contract.image} without replacing the named data volume`,
    "require ready startup preflight and one crawl.succeeded record",
    `verify ${contract.delivery} Telegram behavior from preflight/crawl evidence`,
    `observe readiness for ${contract.observationMinutes} minutes`,
    "retain the previous image and write a sanitized evidence receipt",
  ];
}

async function run(command, arguments_, options = {}) {
  try {
    return await executeFile(command, arguments_, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      ...options,
    });
  } catch (error) {
    const detail = (error.stderr || error.stdout || error.message).trim();
    throw new Error(`${command} ${arguments_.join(" ")} failed: ${detail}`, {
      cause: error,
    });
  }
}

function releaseEnvironment(contract, image) {
  return {
    ...process.env,
    RENTAL_APARTMENTS_IMAGE: image,
  };
}

async function inspectComposeContract(contract, runtime, image) {
  const { stdout } = await run(
    "docker",
    composeArguments(contract, runtime, image, "config", "--format", "json"),
    { env: releaseEnvironment(contract, image) },
  );
  const configuration = JSON.parse(stdout);
  const bot = configuration.services?.bot;
  const dataMounts = (bot?.volumes || []).filter(
    (mount) => mount.target === "/app/.data",
  );

  if (
    bot?.container_name !== "rental-apartments-bot" ||
    bot?.labels?.["com.rental-apartments.environment"] !== "production" ||
    bot?.environment?.NODE_ENV !== "production" ||
    bot?.read_only !== true ||
    bot?.deploy?.replicas !== 1 ||
    bot?.deploy?.update_config?.order !== "stop-first" ||
    dataMounts.length !== 1 ||
    dataMounts[0].type !== "volume"
  ) {
    throw new Error(
      "Compose contract must enforce one fixed container, stop-first updates, a read-only root, and one named /app/.data volume",
    );
  }
}

async function inspectRuntime(contract) {
  const { stdout } = await run("docker", [
    "inspect",
    "--format",
    "{{json .}}",
    "rental-apartments-bot",
  ]);
  const container = JSON.parse(stdout);
  const dataMount = container.Mounts?.find(
    (mount) => mount.Destination === "/app/.data" && mount.Type === "volume",
  );
  if (
    container.Config?.Image !== contract.previousImage ||
    container.Config?.Labels?.["com.rental-apartments.environment"] !==
      contract.environment ||
    container.State?.Running !== true ||
    !dataMount?.Name
  ) {
    throw new Error(
      "Running singleton does not match the requested environment/previous image or lacks the named persistent data volume",
    );
  }
  return { dataVolume: dataMount.Name };
}

async function inspectImageStateCompatibility(image) {
  const { stdout } = await run("docker", [
    "image",
    "inspect",
    "--format",
    "{{json .Config.Labels}}",
    image,
  ]);
  const labels = JSON.parse(stdout);
  const label = labels?.["com.rental-apartments.runtime"];
  // Retained pre-Rust images lack this label and still require their Node tools.
  const runtime =
    label === "rust"
      ? "rust"
      : [undefined, null, "", "node"].includes(label)
        ? "node"
        : undefined;
  if (!runtime)
    throw new Error(`Unsupported application runtime label: ${label}`);
  return {
    runtime,
    sourceRevision: labels?.["org.opencontainers.image.revision"],
    stateBackend: labels?.["com.rental-apartments.state.backend"],
    minimumStateSchema: Number(
      labels?.["com.rental-apartments.state.schema.minimum"],
    ),
    maximumStateSchema: Number(
      labels?.["com.rental-apartments.state.schema.maximum"],
    ),
  };
}

async function verifyHistoricalNodeRelease(contract, targetMetadata) {
  if (!contract.targetRelease) {
    throw new Error(
      "--target-release is required for snapshot-backed rollback to a retained Node release",
    );
  }
  if (
    !/^[a-f0-9]{40}$/u.test(targetMetadata.sourceRevision || "") ||
    !/^[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/u.test(contract.image) ||
    targetMetadata.stateBackend !== "sqlite" ||
    !Number.isSafeInteger(targetMetadata.minimumStateSchema) ||
    !Number.isSafeInteger(targetMetadata.maximumStateSchema) ||
    targetMetadata.minimumStateSchema < 1 ||
    targetMetadata.maximumStateSchema < targetMetadata.minimumStateSchema
  ) {
    throw new Error(
      "Historical Node rollback requires valid revision, digest, and SQLite schema labels",
    );
  }
  const library = fileURLToPath(
    new URL("../ops/lib/deployment.sh", import.meta.url),
  );
  await run("bash", [
    "-c",
    `set -Eeuo pipefail
      image=$1
      revision=$2
      installed=$3
      library=$4
      releases_root=$5
      minimum=$6
      maximum=$7
      deployment_account=$8
      release_owner=$9
      shift 9
      RENTAL_OPS_STATE_DIR=/var/lib/rental-apartments-ops
      digest=\${image##*@sha256:}
      [[ \${installed##*/} == "$revision-\${digest:0:16}" ]]
      [[ -d "$installed" && ! -L "$installed" ]]
      [[ $(realpath --canonicalize-existing "$releases_root") == "$releases_root" ]]
      [[ $(realpath --canonicalize-existing "$installed") == "$installed" ]]
      [[ $(dirname "$installed") == "$releases_root" ]]
      deployment_owner=$(id -u "$deployment_account")
      [[ $(stat -c %u "$installed") == "$release_owner" ]]
      for directory in "$@"; do
        [[ -d "$directory" && ! -L "$directory" ]]
        [[ $(realpath --canonicalize-existing "$directory") == "$directory" ]]
        [[ $(stat -c %u "$directory") == 0 ]]
        mode=$(stat -c %a "$directory")
        (( (8#$mode & 0022) == 0 ))
      done
      [[ $(stat -c %u "$releases_root") == "$deployment_owner" ]]
      for directory in "$releases_root" "$installed"; do
        [[ -d "$directory" && ! -L "$directory" ]]
        [[ $(realpath --canonicalize-existing "$directory") == "$directory" ]]
        mode=$(stat -c %a "$directory")
        (( (8#$mode & 0022) == 0 ))
      done
      bundle=$(mktemp -d)
      trap 'rm -rf -- "$bundle"' EXIT
      source "$library"
      DEPLOYMENT_SOURCE_REVISION=$revision
      repository=\${image%@sha256:*}
      deployment_extract_release_bundle "$repository" "$revision" "$bundle"
      metadata="$bundle/release-metadata.json"
      jq -e --argjson minimum "$minimum" --argjson maximum "$maximum" '
        (.schemaVersion == 2) and ((.runtime // "node") == "node") and
        .stateBackend == "sqlite" and
        .minimumStateSchema == $minimum and .maximumStateSchema == $maximum
      ' "$metadata" >/dev/null
      deployment_verify_release "$bundle" "$image" "$metadata"
      deployment_verify_existing_release_contents "$installed" "$bundle" 2
    `,
    "historical-node-rollback",
    contract.image,
    targetMetadata.sourceRevision,
    contract.targetRelease,
    library,
    contract.releasesRoot,
    String(targetMetadata.minimumStateSchema),
    String(targetMetadata.maximumStateSchema),
    contract.releaseTrust.rootOwnerAccount,
    String(contract.releaseTrust.releaseOwnerUid),
    ...contract.releaseTrust.ancestors,
  ]);
}

async function inspectLiveState(runtime) {
  if (runtime === "rust") {
    const { stdout } = await run("docker", [
      "exec",
      "rental-apartments-bot",
      "/usr/local/bin/rental-app",
      "state:inspect",
    ]);
    return JSON.parse(stdout);
  }
  // The database is the whole answer: SQLite is the only backend a release can
  // serve, so a directory without one is a host with no state to be compatible
  // with rather than a host on some other backend.
  const expression = String.raw`
    const path = await import("node:path");
    const { DatabaseSync } = await import("node:sqlite");
    const root = process.env.DATA_DIRECTORY || "/app/.data";
    const database = new DatabaseSync(path.join(root, "state.sqlite3"), { readOnly: true });
    try {
      const stateSchema = database.prepare("PRAGMA user_version").get().user_version;
      console.log(JSON.stringify({ stateBackend: "sqlite", stateSchema }));
    } finally {
      database.close();
    }
  `;
  const { stdout } = await run("docker", [
    "exec",
    "rental-apartments-bot",
    "node",
    "--input-type=module",
    "--eval",
    expression,
  ]);
  return JSON.parse(stdout);
}

async function inspectStoppedNodeState(contract) {
  const expression = String.raw`
    const path = await import("node:path");
    const { DatabaseSync } = await import("node:sqlite");
    const root = process.env.DATA_DIRECTORY || "/app/.data";
    const database = new DatabaseSync(path.join(root, "state.sqlite3"), { readOnly: true });
    try {
      console.log(JSON.stringify({
        stateBackend: "sqlite",
        stateSchema: database.prepare("PRAGMA user_version").get().user_version,
        applicationId: database.prepare("PRAGMA application_id").get().application_id,
        integrity: database.prepare("PRAGMA quick_check").all(),
        foreignKeyViolations: database.prepare("PRAGMA foreign_key_check").all().length,
        updateOffset: database.prepare("SELECT update_offset FROM telegram_state WHERE singleton = 1").get()?.update_offset,
      }));
    } finally {
      database.close();
    }
  `;
  const { stdout } = await run(
    "docker",
    composeArguments(
      contract,
      "node",
      contract.previousImage,
      "run",
      "--rm",
      "--no-deps",
      "bot",
      "node",
      "--input-type=module",
      "--eval",
      expression,
    ),
    { env: releaseEnvironment(contract, contract.previousImage) },
  );
  const state = JSON.parse(stdout);
  if (
    state.applicationId !== SQLITE_APPLICATION_ID ||
    state.integrity?.length !== 1 ||
    Object.values(state.integrity[0])[0] !== "ok" ||
    state.foreignKeyViolations !== 0 ||
    !Number.isSafeInteger(state.updateOffset) ||
    state.updateOffset < 0
  ) {
    throw new Error("Stopped SQLite state failed identity or integrity checks");
  }
  return state;
}

async function inspectStoppedState(contract, runtime) {
  if (runtime === "node") return inspectStoppedNodeState(contract);
  const { stdout } = await run(
    "docker",
    composeArguments(
      contract,
      runtime,
      contract.previousImage,
      "run",
      "--rm",
      "--no-deps",
      "bot",
      "state:inspect",
    ),
    { env: releaseEnvironment(contract, contract.previousImage) },
  );
  return JSON.parse(stdout);
}

async function validateSnapshot(
  contract,
  runtime,
  image = contract.previousImage,
) {
  await run(
    "docker",
    composeArguments(
      contract,
      runtime,
      image,
      "run",
      "--rm",
      "--no-deps",
      "bot",
      ...(runtime === "rust"
        ? ["backup:validate", "--snapshot", contract.snapshot]
        : ["npm", "run", "backup:validate", "--", contract.snapshot]),
    ),
    { env: releaseEnvironment(contract, image) },
  );
}

async function stopAndConfirm(contract, runtime) {
  await run(
    "docker",
    composeArguments(contract, runtime, contract.previousImage, "stop", "bot"),
    {
      env: releaseEnvironment(contract, contract.previousImage),
    },
  );
  const { stdout } = await run("docker", [
    "inspect",
    "--format",
    "{{.State.Running}}",
    "rental-apartments-bot",
  ]);
  if (stdout.trim() !== "false") {
    throw new Error("The old container is still running; refusing overlap");
  }
}

async function startImage(contract, image, runtime) {
  await run(
    "docker",
    composeArguments(
      contract,
      runtime,
      image,
      "up",
      "--detach",
      "--force-recreate",
      "bot",
    ),
    { env: releaseEnvironment(contract, image) },
  );
}

async function restoreSnapshot(
  contract,
  runtime,
  image = contract.previousImage,
) {
  await run(
    "docker",
    composeArguments(
      contract,
      runtime,
      image,
      "run",
      "--rm",
      "--no-deps",
      "bot",
      ...(runtime === "rust"
        ? ["backup:restore", "--snapshot", contract.snapshot]
        : ["npm", "run", "restore", "--", contract.snapshot]),
    ),
    { env: releaseEnvironment(contract, image) },
  );
}

export function findReleaseEvidence(logText, delivery) {
  const records = logText
    .split(/\r?\n/u)
    .map((line) => {
      const jsonStart = line.indexOf("{");
      if (jsonStart < 0) return undefined;
      try {
        return JSON.parse(line.slice(jsonStart));
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);
  const preflight = records.find(
    (record) =>
      record.event === "startup.preflight.completed" &&
      record.preflight?.status === "ready" &&
      record.preflight?.checks?.telegram === "passed",
  );
  const crawl = records.find((record) => record.event === "crawl.succeeded");
  const expectedChannel =
    delivery === "channel" || delivery === "both" ? "passed" : "skipped";

  return {
    ready: Boolean(preflight && crawl),
    preflight,
    crawl,
    telegramVerified: preflight?.preflight?.checks?.telegram === "passed",
    channelVerified: preflight?.preflight?.checks?.channel === expectedChannel,
  };
}

async function readiness(runtime) {
  if (runtime === "rust")
    return run("docker", [
      "exec",
      "rental-apartments-bot",
      "/usr/local/bin/rental-app",
      "health-check",
      "--ready",
      "--json",
    ]);
  const expression =
    'fetch("http://127.0.0.1:8787/ready").then(async response => { console.log(await response.text()); process.exitCode = response.ok ? 0 : 1 })';
  return run("docker", [
    "exec",
    "rental-apartments-bot",
    "node",
    "-e",
    expression,
  ]);
}

async function waitUntilReady(runtime, timeoutMs = 5 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await readiness(runtime);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
  throw new Error("Service did not become ready after recovery", {
    cause: lastError,
  });
}

async function waitForEvidence(contract, startedAt, runtime) {
  const deadline = Date.now() + contract.observationMs;
  let evidence;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    try {
      await readiness(runtime);
      const { stdout, stderr } = await run("docker", [
        "logs",
        "--since",
        startedAt,
        "rental-apartments-bot",
      ]);
      evidence = findReleaseEvidence(`${stdout}\n${stderr}`, contract.delivery);
      if (evidence.ready && evidence.channelVerified) break;
    } catch {
      // Readiness can legitimately be false before the first crawl.
    }
  }
  if (!evidence?.ready || !evidence.channelVerified) {
    throw new Error(
      "Candidate did not produce ready preflight, successful crawl, and expected Telegram/channel evidence",
    );
  }

  const elapsed = Date.now() - Date.parse(startedAt);
  if (elapsed < contract.observationMs) {
    await new Promise((resolve) =>
      setTimeout(resolve, contract.observationMs - elapsed),
    );
  }
  await readiness(runtime);
  return evidence;
}

async function writeEvidence(contract, runtime, evidence, startedAt) {
  const receipt = {
    schemaVersion: 1,
    operation: contract.operation,
    environment: contract.environment,
    actor: contract.actor,
    image: contract.image,
    previousImage: contract.previousImage,
    retainedPreviousArtifact: true,
    snapshot: contract.snapshot,
    dataVolume: runtime.dataVolume,
    pollIntervalMs: contract.pollIntervalMs,
    observationMinutes: contract.observationMinutes,
    delivery: contract.delivery,
    stateStrategy: contract.stateStrategy,
    startedAt,
    completedAt: new Date().toISOString(),
    preflightStatus: evidence.preflight.preflight.status,
    telegramVerified: evidence.telegramVerified,
    channelVerified: evidence.channelVerified,
    crawl: {
      crawlId: evidence.crawl.crawlId,
      durationMs: evidence.crawl.durationMs,
      notified: evidence.crawl.notified,
      channelSent: evidence.crawl.channelSent,
      channelEdited: evidence.crawl.channelEdited,
    },
  };
  await mkdir(path.dirname(contract.evidenceFile), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(
    contract.evidenceFile,
    `${JSON.stringify(receipt, null, 2)}\n`,
    {
      flag: "wx",
    },
  );
  return receipt;
}

async function confirmSingletonStopped(role) {
  let stopped;
  try {
    const { stdout } = await run("docker", [
      "inspect",
      "--format",
      "{{.State.Running}}",
      "rental-apartments-bot",
    ]);
    stopped = stdout.trim() === "false";
  } catch {
    // A failed Compose recreate can remove the old container before it creates
    // the candidate. Confirm the singleton name is absent before recovery.
    const { stdout } = await run("docker", [
      "ps",
      "--all",
      "--format",
      "{{.Names}}",
      "--filter",
      "name=^/rental-apartments-bot$",
    ]);
    stopped = stdout.trim() === "";
  }
  if (!stopped) {
    throw new Error(
      `The ${role} container is still running; refusing recovery overlap`,
    );
  }
}

async function recoverPrevious(contract, runtime, previousMetadata) {
  await run(
    "docker",
    composeArguments(contract, runtime, contract.image, "stop", "bot"),
    {
      env: releaseEnvironment(contract, contract.image),
    },
  );
  await confirmSingletonStopped("candidate");
  const preserveLiveState =
    contract.stateStrategy === "compatible" &&
    (contract.operation === "rollback" ||
      (contract.operation === "deploy" &&
        runtime === "rust" &&
        previousMetadata.runtime === "node"));
  if (preserveLiveState) {
    assertRollbackStateCompatibility({
      stateStrategy: "compatible",
      targetMetadata: previousMetadata,
      liveState: await inspectStoppedState(contract, previousMetadata.runtime),
    });
  } else {
    await restoreSnapshot(contract, previousMetadata.runtime);
  }
  try {
    await startImage(
      contract,
      contract.previousImage,
      previousMetadata.runtime,
    );
    await waitUntilReady(previousMetadata.runtime);
  } catch (error) {
    try {
      await run(
        "docker",
        composeArguments(
          contract,
          previousMetadata.runtime,
          contract.previousImage,
          "stop",
          "bot",
        ),
        { env: releaseEnvironment(contract, contract.previousImage) },
      );
      await confirmSingletonStopped("previous image");
    } catch (cleanupError) {
      throw new Error(
        `Previous image recovery failed: ${error.message}; stopping its container failed: ${cleanupError.message}`,
        { cause: cleanupError },
      );
    }
    throw new Error(
      `Previous image recovery failed and its container was stopped: ${error.message}`,
      { cause: error },
    );
  }
  return preserveLiveState;
}

export async function executeRelease(contract) {
  try {
    await access(contract.evidenceFile);
    throw new Error(
      `Evidence file already exists; choose a new path: ${contract.evidenceFile}`,
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const [targetMetadata, previousMetadata] = await Promise.all([
    inspectImageStateCompatibility(contract.image),
    inspectImageStateCompatibility(contract.previousImage),
    readFile(contract.composeFile, "utf8"),
  ]);
  if (
    contract.operation === "rollback" &&
    contract.stateStrategy === "restore" &&
    targetMetadata.runtime === "node"
  ) {
    await verifyHistoricalNodeRelease(contract, targetMetadata);
  }
  await inspectComposeContract(
    contract,
    previousMetadata.runtime,
    contract.previousImage,
  );
  await inspectComposeContract(
    contract,
    targetMetadata.runtime,
    contract.image,
  );
  if (
    contract.operation === "rollback" &&
    contract.stateStrategy === "restore"
  ) {
    await validateSnapshot(contract, targetMetadata.runtime, contract.image);
  } else {
    await validateSnapshot(contract, previousMetadata.runtime);
  }
  const runtime = await inspectRuntime(contract);
  if (
    contract.operation === "rollback" &&
    contract.stateStrategy === "compatible"
  ) {
    assertRollbackStateCompatibility({
      stateStrategy: contract.stateStrategy,
      targetMetadata,
      liveState: await inspectLiveState(previousMetadata.runtime),
    });
  }
  await stopAndConfirm(contract, previousMetadata.runtime);

  if (
    contract.operation === "rollback" &&
    contract.stateStrategy === "restore"
  ) {
    await restoreSnapshot(contract, targetMetadata.runtime, contract.image);
  }

  const startedAt = new Date().toISOString();
  try {
    await startImage(contract, contract.image, targetMetadata.runtime);
    const evidence = await waitForEvidence(
      contract,
      startedAt,
      targetMetadata.runtime,
    );
    return writeEvidence(contract, runtime, evidence, startedAt);
  } catch (error) {
    let preservedLiveState;
    try {
      preservedLiveState = await recoverPrevious(
        contract,
        targetMetadata.runtime,
        previousMetadata,
      );
    } catch (recoveryError) {
      throw new Error(
        `Release failed: ${error.message}; recovery failed: ${recoveryError.message}. Stop and review the live volume before any snapshot restore`,
        { cause: recoveryError },
      );
    }
    throw new Error(
      preservedLiveState
        ? `Release failed and the previous image restarted on compatible live SQLite state without snapshot restore: ${error.message}`
        : `Release failed and the verified snapshot plus previous image were restored: ${error.message}`,
      { cause: error },
    );
  }
}

export async function main(arguments_ = process.argv.slice(2)) {
  const contract = createReleaseContract(parseArguments(arguments_));
  if (contract.dryRun) {
    console.log(
      JSON.stringify(
        {
          status: "validated",
          mutation: "none",
          contract,
          plan: commandPlan(contract),
        },
        null,
        2,
      ),
    );
    return;
  }

  const receipt = await executeRelease(contract);
  console.log(JSON.stringify({ status: "completed", receipt }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(`release operation failed: ${error.message}`);
    process.exitCode = 1;
  }
}

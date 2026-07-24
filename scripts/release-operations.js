import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const executeFile = promisify(execFile);
const DIGEST_REFERENCE =
  /^(?:sha256:[a-f0-9]{64}|[a-z0-9][a-z0-9._/-]*(?::[a-z0-9._-]+)?@sha256:[a-f0-9]{64})$/u;
const SNAPSHOT_PATH =
  /^\/app-backups\/(?:daily|weekly)\/[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u;
const OPERATIONS = new Set(["validate", "deploy", "rollback", "rehearse"]);
const DELIVERY_MODES = new Set(["private", "channel", "both"]);
const STATE_STRATEGIES = new Set(["compatible", "restore"]);
const ARGUMENT_NAMES = new Set([
  "environment",
  "operator",
  "image",
  "previous-image",
  "snapshot",
  "poll-interval-ms",
  "observation-minutes",
  "delivery",
  "state-strategy",
  "evidence-file",
  "compose-file",
  "project-name",
]);

function usage() {
  return [
    "Usage:",
    "  node scripts/release-operations.js validate|deploy|rollback|rehearse \\",
    "    --environment production|staging --operator NAME \\",
    "    --image IMMUTABLE_REF --previous-image IMMUTABLE_REF \\",
    "    --snapshot /app-backups/daily/ID --poll-interval-ms MS \\",
    "    --observation-minutes MINUTES --delivery private|channel|both \\",
    "    [--state-strategy compatible|restore] [--evidence-file PATH] [--dry-run]",
    "",
    "rehearse requires --environment staging. validate and --dry-run never invoke Docker.",
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
export function createReleaseContract(raw) {
  const environment = requiredString(raw.environment, "environment");
  if (!new Set(["production", "staging"]).has(environment)) {
    throw new Error("--environment must be production or staging");
  }
  if (raw.operation === "rehearse" && environment !== "staging") {
    throw new Error("rehearse is restricted to --environment staging");
  }

  const operator = requiredString(raw.operator, "operator");
  if (
    operator.length < 3 ||
    /^(?:unknown|n\/a|none|operator|automation)$/iu.test(operator)
  ) {
    throw new Error("--operator must name the accountable human operator");
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
  const projectName =
    raw["project-name"] ||
    (environment === "production"
      ? "rental-apartments"
      : "rental-apartments-staging");

  return {
    schemaVersion: 1,
    operation: raw.operation,
    environment,
    operator,
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
    evidenceFile,
    dryRun: raw.dryRun || raw.operation === "validate",
  };
}

function composeArguments(contract, ...arguments_) {
  return [
    "compose",
    "--project-name",
    contract.projectName,
    "--file",
    contract.composeFile,
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
    `validate verified snapshot ${contract.snapshot} with ${contract.previousImage}`,
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
    DEPLOYMENT_ENVIRONMENT: contract.environment,
  };
}

async function inspectComposeContract(contract) {
  const { stdout } = await run(
    "docker",
    composeArguments(contract, "config", "--format", "json"),
    { env: releaseEnvironment(contract, contract.previousImage) },
  );
  const configuration = JSON.parse(stdout);
  const bot = configuration.services?.bot;
  const dataMounts = (bot?.volumes || []).filter(
    (mount) => mount.target === "/app/.data",
  );

  if (
    bot?.container_name !== "rental-apartments-bot" ||
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

async function validateSnapshot(contract) {
  await run(
    "docker",
    composeArguments(
      contract,
      "run",
      "--rm",
      "--no-deps",
      "bot",
      "npm",
      "run",
      "backup:validate",
      "--",
      contract.snapshot,
    ),
    { env: releaseEnvironment(contract, contract.previousImage) },
  );
}

async function stopAndConfirm(contract) {
  await run("docker", composeArguments(contract, "stop", "bot"), {
    env: releaseEnvironment(contract, contract.previousImage),
  });
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

async function startImage(contract, image) {
  await run(
    "docker",
    composeArguments(contract, "up", "--detach", "--force-recreate", "bot"),
    { env: releaseEnvironment(contract, image) },
  );
}

async function restoreSnapshot(contract) {
  await run(
    "docker",
    composeArguments(
      contract,
      "run",
      "--rm",
      "--no-deps",
      "bot",
      "npm",
      "run",
      "restore",
      "--",
      contract.snapshot,
    ),
    { env: releaseEnvironment(contract, contract.previousImage) },
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

async function readiness() {
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

async function waitUntilReady(timeoutMs = 5 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await readiness();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
  throw new Error("Service did not become ready after recovery", {
    cause: lastError,
  });
}

async function waitForEvidence(contract, startedAt) {
  const deadline = Date.now() + contract.observationMs;
  let evidence;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    try {
      await readiness();
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
  await readiness();
  return evidence;
}

async function writeEvidence(contract, runtime, evidence, startedAt) {
  const receipt = {
    schemaVersion: 1,
    operation: contract.operation,
    environment: contract.environment,
    operator: contract.operator,
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

async function recoverPrevious(contract) {
  await run("docker", composeArguments(contract, "stop", "bot"), {
    env: releaseEnvironment(contract, contract.image),
  });
  await restoreSnapshot(contract);
  await startImage(contract, contract.previousImage);
  await waitUntilReady();
}

async function executeRelease(contract) {
  try {
    await access(contract.evidenceFile);
    throw new Error(
      `Evidence file already exists; choose a new path: ${contract.evidenceFile}`,
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await Promise.all([
    run("docker", ["image", "inspect", contract.image]),
    run("docker", ["image", "inspect", contract.previousImage]),
    readFile(contract.composeFile, "utf8"),
  ]);
  await inspectComposeContract(contract);
  await validateSnapshot(contract);
  const runtime = await inspectRuntime(contract);
  await stopAndConfirm(contract);

  if (
    contract.operation === "rollback" &&
    contract.stateStrategy === "restore"
  ) {
    await restoreSnapshot(contract);
  }

  const startedAt = new Date().toISOString();
  try {
    await startImage(contract, contract.image);
    const evidence = await waitForEvidence(contract, startedAt);
    if (contract.operation === "rehearse") {
      await recoverPrevious(contract);
    }
    return writeEvidence(contract, runtime, evidence, startedAt);
  } catch (error) {
    // Candidate preflight may update the Chrome profile or a rate snapshot.
    // Restoring the already-verified snapshot makes failed rollout state exact.
    await recoverPrevious(contract);
    throw new Error(
      `Release failed and the verified snapshot plus previous image were restored: ${error.message}`,
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

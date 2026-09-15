import { request } from "node:http";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHealthEndpointConfig } from "./environment-config.js";

// Docker runs this command on every probe, 30 seconds apart, and reports the
// container unhealthy after the Compose `retries: 2`. Terminating on a run of
// three keeps the kill strictly behind that unhealthy report: the application
// must have failed to answer `/live` across two full intervals, roughly 60-75
// seconds including each probe's own budget, before anything is signalled. A
// single transient stall — the kind a blocked event loop produces during a
// delivery burst — therefore recovers on its own. The earliest a fresh
// container can reach three failures is its 90-second probe, 30 seconds past
// the 60-second `start_period` reserved for preflight.
const CONSECUTIVE_FAILURES_BEFORE_TERMINATION = 3;

// The failure run must outlive one probe process and never outlive one
// container. Compose mounts the image read-only apart from the persistent
// `/app/.data` volume — where a counter would carry a dying container's
// failures into its replacement — and two tmpfs mounts the kernel recreates
// empty at every container start, which is exactly the lifetime this state
// should have. `os.tmpdir()` is the container's 128 MiB `/tmp` tmpfs, mounted
// `nosuid,nodev,noexec` so a counter is all it can ever hold. `/tmp` itself is
// shared sticky-bit 1777 space, so the counter lives in a private directory.
const LIVENESS_STATE_DIRECTORY = join(tmpdir(), "rental-apartments-health");
const LIVENESS_FAILURE_COUNTER = "consecutive-liveness-failures";
const PROCESS_TABLE = "/proc";

export async function probeLiveness(options = {}) {
  return probeEndpoint("/live", options);
}

// Readiness is a separate judgement from liveness: a responsive process that
// cannot crawl is live but not ready. Probing it must never restart anything,
// so this stays distinct from the supervised liveness path below.
export async function probeReadiness(options = {}) {
  return probeEndpoint("/ready", options);
}

export async function probeReadinessSummary(options = {}) {
  try {
    return await probeEndpoint("/ready", { ...options, summary: true });
  } catch (error) {
    const reason =
      error.code === "READINESS_PROBE_TIMEOUT"
        ? error.code
        : error.code === "READINESS_RESPONSE_INVALID"
          ? error.code
          : "READINESS_PROBE_FAILED";
    return { status: "not_ready", reasons: [reason], alertReasons: [reason] };
  }
}

function readinessSummary(response, body) {
  const invalid = () => {
    const error = new Error("Invalid readiness response");
    error.code = "READINESS_RESPONSE_INVALID";
    return error;
  };
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    throw invalid();
  }
  const validReasons = (reasons) =>
    Array.isArray(reasons) &&
    reasons.length <= 8 &&
    reasons.every(
      (reason) =>
        typeof reason === "string" && /^[A-Z][A-Z0-9_]{0,79}$/u.test(reason),
    );
  if (
    !value ||
    typeof value.ready !== "boolean" ||
    !validReasons(value.reasons) ||
    !validReasons(value.alertReasons) ||
    !value.alertReasons.every((reason) => value.reasons.includes(reason)) ||
    !value.reasons.every(
      (reason) =>
        reason === "LIST_AM_CHALLENGE" || value.alertReasons.includes(reason),
    ) ||
    value.ready !== (value.reasons.length === 0) ||
    response.statusCode !== (value.ready ? 200 : 503)
  )
    throw invalid();
  return {
    status: value.ready ? "ready" : "not_ready",
    reasons: value.reasons,
    alertReasons: value.alertReasons,
  };
}

function probeEndpoint(endpointPath, options = {}) {
  const endpoint = getHealthEndpointConfig(options.env);
  const host = options.host ?? endpoint.host;
  const port = options.port ?? endpoint.port;
  // Three seconds against Compose's `timeout: 5s`. The probe must fail, record
  // the failure and exit within Docker's budget; a wider probe timeout risks
  // Docker killing the check first, which would leave the consecutive-failure
  // count permanently at zero and disable recovery altogether. Around 260 ms
  // of `docker exec` and Node startup surrounds the probe, so this leaves well
  // over a second of headroom.
  const timeoutMs = options.timeoutMs ?? 3_000;
  return new Promise((resolve, reject) => {
    const probe = request(
      {
        host,
        port,
        path: endpointPath,
        method: "GET",
        timeout: timeoutMs,
      },
      (response) => {
        if (options.summary) {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
            if (body.length > 16_384) {
              const error = new Error("Readiness response exceeds its bound");
              error.code = "READINESS_RESPONSE_INVALID";
              reject(error);
              response.destroy();
              probe.destroy();
            }
          });
          response.once("error", reject);
          response.once("end", () => {
            try {
              resolve(readinessSummary(response, body));
            } catch (error) {
              reject(error);
            }
          });
          return;
        }
        response.resume();
        if (response.statusCode === 200) resolve();
        else
          reject(
            new Error(
              `Probe of ${endpointPath} returned ${response.statusCode}`,
            ),
          );
      },
    );
    probe.once("timeout", () => {
      const error = new Error(`Probe of ${endpointPath} timed out`);
      error.code = "READINESS_PROBE_TIMEOUT";
      probe.destroy(error);
    });
    probe.once("error", reject);
    probe.end();
  });
}

function isNodeExecutable(argument = "") {
  return /^(?:.*\/)?node(?:js)?$/u.test(argument);
}

// `node src/index.js` — the image CMD — puts the Node executable in argv[0] and
// the script in the first argument that is not an option. PID 1 under the
// container's minimal init reads
// `/sbin/docker-init -- docker-entrypoint.sh node src/index.js`: it carries the
// application's script too, but as a trailing argument of a different
// executable. Anchoring both positions is what distinguishes the process that
// *is* the application from every wrapper that merely names it. A Node option
// taking a separate value would hide the script and match nothing, which fails
// closed by refusing to kill rather than by killing the wrong process.
export function isApplicationCommand(commandLine) {
  const [executable, ...arguments_] = commandLine.split("\0").filter(Boolean);
  if (!isNodeExecutable(executable)) return false;
  const script = arguments_.find((argument) => !argument.startsWith("-"));
  return (
    script === "src/index.js" || Boolean(script?.endsWith("/src/index.js"))
  );
}

function counterPath(stateDirectory) {
  return join(stateDirectory, LIVENESS_FAILURE_COUNTER);
}

async function readFailureRun(stateDirectory) {
  let recorded;
  try {
    recorded = await readFile(counterPath(stateDirectory), "utf8");
  } catch {
    // No counter is the normal state of a container that has not failed a
    // probe since it started.
    return 0;
  }
  // Only a plain decimal count is believed. A truncated write, a foreign file
  // or an impossible value reads as "no run in progress", because a counter
  // that cannot be trusted must never be the reason production is killed.
  const failures = /^\d+$/u.test(recorded.trim())
    ? Number(recorded.trim())
    : NaN;
  return Number.isSafeInteger(failures) ? failures : 0;
}

async function recordFailureRun(stateDirectory) {
  const failures = (await readFailureRun(stateDirectory)) + 1;
  try {
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(counterPath(stateDirectory), `${failures}\n`, {
      mode: 0o600,
    });
  } catch {
    // A run that cannot be persisted is not a run the next probe will see, so
    // report none rather than acting on a length nothing else can corroborate.
    return 0;
  }
  return failures;
}

async function clearFailureRun(stateDirectory) {
  try {
    await rm(counterPath(stateDirectory), { force: true });
  } catch {
    // A successful probe is not worth failing over an unremovable counter;
    // the next success clears it again.
  }
}

async function terminateApplication(options = {}) {
  const processTable = options.processTable ?? PROCESS_TABLE;
  const entries = await readdir(processTable);
  for (const entry of entries) {
    const processId = Number(entry);
    if (!Number.isSafeInteger(processId) || processId === process.pid) continue;
    // A PID namespace's init receives no signal raised inside that namespace
    // unless it handles it, and SIGKILL can never be handled, so the kernel
    // always discards this one. Killing PID 1 cannot restart anything.
    if (processId === 1) continue;

    let commandLine;
    try {
      commandLine = await readFile(
        join(processTable, entry, "cmdline"),
        "utf8",
      );
    } catch {
      // The process exited between reading the table and reading its command.
      continue;
    }
    if (!isApplicationCommand(commandLine)) continue;

    process.kill(processId, "SIGKILL");
    return processId;
  }
  throw new Error("Application process was not found");
}

// The supervised form of the liveness probe: it owns the failure run and is
// the only path that may terminate anything.
export async function superviseLiveness(options = {}) {
  const stateDirectory = options.stateDirectory ?? LIVENESS_STATE_DIRECTORY;
  let live = true;
  try {
    await probeLiveness(options);
  } catch {
    live = false;
  }

  if (live) {
    // One success ends the run. Only an uninterrupted sequence of failures
    // describes a process that has genuinely stopped answering.
    await clearFailureRun(stateDirectory);
    return { live: true, failures: 0, terminated: false };
  }

  const failures = await recordFailureRun(stateDirectory);
  if (failures < CONSECUTIVE_FAILURES_BEFORE_TERMINATION)
    return { live: false, failures, terminated: false };

  // The probe is a sibling process under the container's minimal init. Killing
  // the unresponsive Node child makes init exit non-zero, engaging Docker's
  // bounded restart policy.
  await terminateApplication(options);
  return { live: false, failures, terminated: true };
}

async function main() {
  // --ready reports whether the application can do its job; the default
  // liveness probe reports only whether the process still answers. Restarting
  // on readiness would loop the container through failures a restart cannot
  // fix, so the two never share the recovery path.
  const readinessMode = process.argv.includes("--ready");
  if (readinessMode && process.argv.includes("--json")) {
    const summary = await probeReadinessSummary();
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    if (summary.status !== "ready") process.exitCode = 1;
    return;
  }
  // Only the supervised healthcheck keeps the failure run. An operator probing
  // by hand must neither arm the termination path nor reset one that is
  // already counting towards it.
  if (!readinessMode && process.argv.includes("--restart-unresponsive")) {
    const { live } = await superviseLiveness();
    if (!live) process.exitCode = 1;
    return;
  }
  try {
    await (readinessMode ? probeReadiness() : probeLiveness());
  } catch {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();

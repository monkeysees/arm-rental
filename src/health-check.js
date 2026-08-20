import { request } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { getHealthEndpointConfig } from "./environment-config.js";

export async function probeLiveness(options = {}) {
  return probeEndpoint("/live", options);
}

// Readiness is a separate judgement from liveness: a responsive process that
// cannot crawl is live but not ready. Probing it must never restart anything,
// so this stays distinct from the supervised liveness path below.
export async function probeReadiness(options = {}) {
  return probeEndpoint("/ready", options);
}

function probeEndpoint(endpointPath, options = {}) {
  const endpoint = getHealthEndpointConfig(options.env);
  const host = options.host ?? endpoint.host;
  const port = options.port ?? endpoint.port;
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
      probe.destroy(new Error(`Probe of ${endpointPath} timed out`));
    });
    probe.once("error", reject);
    probe.end();
  });
}

export function isApplicationCommand(commandLine) {
  const arguments_ = commandLine.split("\0").filter(Boolean);
  return arguments_.some(
    (argument) =>
      argument === "src/index.js" || argument.endsWith("/src/index.js"),
  );
}

async function terminateApplication() {
  const entries = await readdir("/proc");
  for (const entry of entries) {
    const processId = Number(entry);
    if (!Number.isSafeInteger(processId) || processId === process.pid) continue;

    let commandLine;
    try {
      commandLine = await readFile(`/proc/${processId}/cmdline`, "utf8");
    } catch {
      continue;
    }
    if (!isApplicationCommand(commandLine)) continue;

    process.kill(processId, "SIGKILL");
    return;
  }
  throw new Error("Application process was not found");
}

async function main() {
  // --ready reports whether the application can do its job; the default
  // liveness probe reports only whether the process still answers. Restarting
  // on readiness would loop the container through failures a restart cannot
  // fix, so the two never share the recovery path.
  const readinessMode = process.argv.includes("--ready");
  try {
    await (readinessMode ? probeReadiness() : probeLiveness());
  } catch {
    if (!readinessMode && process.argv.includes("--restart-unresponsive")) {
      // The probe is a sibling process under the container's minimal init.
      // Killing the unresponsive Node child makes init exit non-zero, engaging
      // Docker's bounded restart policy.
      await terminateApplication();
    }
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();

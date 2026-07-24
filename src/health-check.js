import { request } from "node:http";
import { readFile, readdir } from "node:fs/promises";

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function probeLiveness({
  host = process.env.HEALTH_HOST || "127.0.0.1",
  port = positiveInteger(process.env.HEALTH_PORT, 8_787),
  timeoutMs = 3_000,
} = {}) {
  return new Promise((resolve, reject) => {
    const probe = request(
      {
        host,
        port,
        path: "/live",
        method: "GET",
        timeout: timeoutMs,
      },
      (response) => {
        response.resume();
        if (response.statusCode === 200) resolve();
        else
          reject(new Error(`Liveness probe returned ${response.statusCode}`));
      },
    );
    probe.once("timeout", () => {
      probe.destroy(new Error("Liveness probe timed out"));
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
  try {
    await probeLiveness();
  } catch {
    if (process.argv.includes("--restart-unresponsive")) {
      // The probe is a sibling process under the container's minimal init.
      // Killing the unresponsive Node child makes init exit non-zero, engaging
      // Docker's bounded restart policy.
      await terminateApplication();
    }
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();

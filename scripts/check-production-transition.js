import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/**
 * Decides whether the production discovery pointer may advance to a candidate.
 *
 * The host runs whatever release the pointer names, and it deploys the next
 * candidate using the operations bundle of the release it is *already*
 * running. A candidate whose state backend or runtime that release cannot
 * deploy is undeployable the moment the pointer moves.
 */
export function classifyProductionTransition({ current, candidate }) {
  if (!candidate?.stateBackend) {
    throw new Error("candidate metadata must declare a state backend");
  }
  // Releases predating the Rust candidate had no runtime field and ran Node.
  const candidateRuntime = candidate.runtime ?? "node";
  if (!["node", "rust"].includes(candidateRuntime)) {
    throw new Error(`unsupported candidate runtime: ${candidateRuntime}`);
  }
  if (!current) {
    return {
      allowed: true,
      cutover: false,
      reason: "no production pointer exists yet",
    };
  }
  if (!current.stateBackend) {
    throw new Error("current production metadata must declare a state backend");
  }
  const currentRuntime = current.runtime ?? "node";
  if (!["node", "rust"].includes(currentRuntime)) {
    throw new Error(`unsupported current runtime: ${currentRuntime}`);
  }
  if (
    current.stateBackend === candidate.stateBackend &&
    currentRuntime === candidateRuntime
  ) {
    return {
      allowed: true,
      cutover: false,
      reason: `production already runs stateBackend ${candidate.stateBackend} and runtime ${candidateRuntime}`,
    };
  }
  // A release predating either field can deploy only its own contract.
  const deployableBackends = current.deployableStateBackends ?? [
    current.stateBackend,
  ];
  const deployableRuntimes = current.deployableRuntimes ?? [currentRuntime];
  if (!deployableBackends.includes(candidate.stateBackend)) {
    return {
      allowed: false,
      cutover: true,
      reason:
        `production runs ${current.sourceRevision ?? "an unknown revision"} ` +
        `(stateBackend ${current.stateBackend}), which deploys only ` +
        `${deployableBackends.join(", ")}. Publish the bridge release that deploys ` +
        `${candidate.stateBackend} and let the host take it first.`,
    };
  }
  if (!deployableRuntimes.includes(candidateRuntime)) {
    return {
      allowed: false,
      cutover: true,
      reason:
        `production runs ${current.sourceRevision ?? "an unknown revision"} ` +
        `(runtime ${currentRuntime}), which deploys only ` +
        `${deployableRuntimes.join(", ")}. Publish the bridge release that deploys ` +
        `${candidateRuntime} and let the host take it first.`,
    };
  }
  return {
    allowed: true,
    cutover: true,
    reason:
      `production changes from ${current.stateBackend}/${currentRuntime} to ` +
      `${candidate.stateBackend}/${candidateRuntime}. The bridge release is published, but only ` +
      `the host knows whether it is deployed, so the pointer must be ` +
      `advanced by promote-production once that is confirmed.`,
  };
}

const readOptionalJson = async (file) => {
  if (!file) {
    return undefined;
  }
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
};

async function main() {
  const [candidateFile, currentFile] = process.argv.slice(2);
  if (!candidateFile) {
    throw new Error(
      "Usage: check-production-transition CANDIDATE_METADATA [CURRENT_METADATA]",
    );
  }
  const [candidate, current] = await Promise.all([
    readOptionalJson(candidateFile),
    readOptionalJson(currentFile),
  ]);
  const result = classifyProductionTransition({ current, candidate });
  process.stdout.write(`${result.reason}\n`);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `cutover=${result.cutover}\nallowed=${result.allowed}\n`,
    );
  }
  if (!result.allowed) {
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}

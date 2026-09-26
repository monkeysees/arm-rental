import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const revision = "b".repeat(40);
const image = `ghcr.io/example/arm-rental@sha256:${"a".repeat(64)}`;

test("Rust publisher rejects unbridged or inconsistent pointers before any push", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "rust-publication-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin");
  await mkdir(bin);
  const docker = join(bin, "docker");
  await writeFile(
    docker,
    `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$DOCKER_LOG"
case "$1 $2" in
  'pull --quiet')
    if [[ $3 == *:production && $POINTER_STATUS != present ]]; then
      if [[ $POINTER_STATUS == missing ]]; then printf 'manifest unknown\\n' >&2; else printf 'denied\\n' >&2; fi
      exit 1
    fi ;;
  'image inspect')
    case "$*" in
      *org.opencontainers.image.revision*) printf '%s\\n' "$CURRENT_REVISION" ;;
      *.RepoDigests*) printf '%s\\n' "$CURRENT_REFERENCE" ;;
      *com.rental-apartments.runtime*) printf '%s\\n' "$CURRENT_RUNTIME" ;;
      *) exit 9 ;;
    esac ;;
  'create '*) printf 'synthetic-metadata-container\\n' ;;
  'cp '*) cp "$CURRENT_METADATA" "$3" ;;
  'rm '*) ;;
  'push '*) ;;
  *) exit 9 ;;
esac
`,
  );
  await chmod(docker, 0o755);
  const workflow = await readFile(
    new URL("../.github/workflows/publish-production.yml", import.meta.url),
    "utf8",
  );
  const step = workflow
    .split(
      "      - name: Refuse an unbridged Rust publication before any registry push\n",
    )[1]
    ?.split("\n      - name:")[0];
  const preflight = step
    ?.split("        run: |\n")[1]
    ?.replace(/^ {10}/gmu, "");
  assert.ok(preflight, "publication must include an executable pre-push guard");
  const checker = new URL(
    "../scripts/check-production-transition.js",
    import.meta.url,
  ).pathname;
  const script = `${preflight.replace(
    "node scripts/check-production-transition.js",
    `node '${checker}'`,
  )}\ndocker push ghcr.io/example/arm-rental:revision-test\n`;
  const metadata = join(directory, "current.json");
  const log = join(directory, "docker.log");

  async function runCase({
    pointer = "present",
    runtime = "<no value>",
    current,
  }) {
    await writeFile(metadata, `${JSON.stringify(current)}\n`);
    await writeFile(log, "");
    let passed = true;
    let failure;
    try {
      execFileSync("bash", ["-e", "-o", "pipefail", "-c", script], {
        cwd: directory,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GITHUB_REPOSITORY: "example/arm-rental",
          POINTER_STATUS: pointer,
          CURRENT_REVISION: revision,
          CURRENT_REFERENCE: image,
          CURRENT_RUNTIME: runtime,
          CURRENT_METADATA: metadata,
          DOCKER_LOG: log,
        },
        stdio: "pipe",
      });
    } catch (error) {
      passed = false;
      failure = error.stderr?.toString();
    }
    const calls = await readFile(log, "utf8");
    return { passed, pushed: calls.includes("push ghcr.io/"), failure };
  }

  const bridge = {
    sourceRevision: revision,
    imageReference: image,
    stateBackend: "sqlite",
    runtime: "node",
    deployableRuntimes: ["node", "rust"],
  };
  for (const scenario of [
    { pointer: "missing", current: bridge },
    { pointer: "denied", current: bridge },
    { current: { ...bridge, deployableRuntimes: undefined } },
    {
      current: {
        ...bridge,
        imageReference: image.replace(/a{64}$/u, "c".repeat(64)),
      },
    },
    { current: bridge, runtime: "rust" },
    { current: bridge, runtime: "unknown" },
  ]) {
    const result = await runCase(scenario);
    assert.equal(result.passed, false);
    assert.equal(result.pushed, false);
  }
  const accepted = await runCase({ current: bridge });
  assert.equal(accepted.passed, true, accepted.failure);
  assert.equal(accepted.pushed, true);
});

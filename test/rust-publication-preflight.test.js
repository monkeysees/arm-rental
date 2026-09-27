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

test("Cargo publisher gates the first registry push on current host verification", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cargo-publication-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin");
  await mkdir(bin);
  const log = join(directory, "calls.log");
  const docker = join(bin, "docker");
  await writeFile(
    docker,
    `#!/usr/bin/env bash
set -eu
printf 'docker %s\\n' "$*" >> "$CALL_LOG"
case "$1 $2" in
  'pull --quiet') [[ $PULL_STATUS == success ]] ;;
  'image inspect')
    case "$*" in
      *org.opencontainers.image.revision*) printf '%s\\n' "$CURRENT_REVISION" ;;
      *.RepoDigests*) printf '%s\\n' "$CURRENT_REFERENCE" ;;
      *) exit 9 ;;
    esac ;;
  'create '*) printf 'metadata-container\\n' ;;
  'cp '*) ;;
  'rm '*) ;;
  'push '*) ;;
  *) exit 9 ;;
esac
`,
  );
  const python = join(bin, "python3");
  await writeFile(
    python,
    `#!/usr/bin/env bash
set -eu
printf 'python %s\\n' "$*" >> "$CALL_LOG"
[[ $GATE_STATUS == success ]]
`,
  );
  await Promise.all([chmod(docker, 0o755), chmod(python, 0o755)]);
  const workflow = await readFile(
    new URL("../.github/workflows/publish-production.yml", import.meta.url),
    "utf8",
  );
  const step = workflow
    .split(
      "      - name: Verify the deployed Cargo-capable bridge before any registry push\n",
    )[1]
    ?.split("\n      - name:")[0];
  const preflight = step
    ?.split("        run: |\n")[1]
    ?.replace(/^ {10}/gmu, "");
  assert.ok(preflight, "publication must include an executable pre-push guard");
  assert.match(preflight, /--current-bundle preflight/u);
  assert.match(
    preflight,
    /--receipt-record docs\/evidence\/issue49-stage1-receipt\.json/u,
  );

  async function runCase({ pull = "success", gate = "success" } = {}) {
    await writeFile(log, "");
    let passed = true;
    try {
      execFileSync(
        "bash",
        [
          "-e",
          "-o",
          "pipefail",
          "-c",
          `${preflight}\ndocker push candidate-registry-tag`,
        ],
        {
          cwd: directory,
          env: {
            PATH: `${bin}:${process.env.PATH}`,
            GITHUB_REPOSITORY: "example/arm-rental",
            CURRENT_REVISION: "a".repeat(40),
            CURRENT_REFERENCE: `ghcr.io/example/arm-rental@sha256:${"b".repeat(64)}`,
            PULL_STATUS: pull,
            GATE_STATUS: gate,
            CALL_LOG: log,
          },
          stdio: "pipe",
        },
      );
    } catch {
      passed = false;
    }
    const calls = await readFile(log, "utf8");
    return { passed, calls };
  }

  const absentPointer = await runCase({ pull: "failure" });
  assert.equal(absentPointer.passed, false);
  assert.doesNotMatch(absentPointer.calls, /docker push/u);
  const refusedHost = await runCase({ gate: "failure" });
  assert.equal(refusedHost.passed, false);
  assert.match(refusedHost.calls, /python scripts\/native-release\.py gate/u);
  assert.doesNotMatch(refusedHost.calls, /docker push/u);
  const acceptedHost = await runCase();
  assert.equal(acceptedHost.passed, true);
  assert.ok(
    acceptedHost.calls.indexOf("python scripts/native-release.py gate") <
      acceptedHost.calls.indexOf("docker push"),
  );
});

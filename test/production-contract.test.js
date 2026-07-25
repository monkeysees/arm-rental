import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const validator = path.join(
  repositoryRoot,
  "scripts",
  "validate-production-contract",
);

async function executable(filename, source) {
  await writeFile(filename, source, { mode: 0o755 });
  await chmod(filename, 0o755);
}

test("one static command aggregates shell, systemd, Compose, workflow, environment, and observability contracts", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "production-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = path.join(root, "commands.log");
  const prelude = `#!/usr/bin/env bash
set -eu
printf '%s %s\\n' "\${0##*/}" "$*" >>"$FAKE_CONTRACT_LOG"
`;
  await executable(
    path.join(root, "shellcheck"),
    `${prelude}
exit 0
`,
  );
  await executable(
    path.join(root, "systemd-analyze"),
    `${prelude}
[[ "\${1:-}" == "verify" ]]
`,
  );
  await executable(
    path.join(root, "docker"),
    `${prelude}
cat <<'EOF'
{
  "services": {
    "bot": {
      "container_name": "rental-apartments-bot",
      "labels": {"com.rental-apartments.environment": "production"},
      "environment": {"NODE_ENV": "production"},
      "read_only": true,
      "deploy": {
        "replicas": 1,
        "update_config": {"order": "stop-first"}
      },
      "ports": [],
      "logging": {"driver": "journald"}
    }
  }
}
EOF
`,
  );

  const result = await new Promise((resolve) => {
    const child = spawn(validator, [], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        FAKE_CONTRACT_LOG: log,
      },
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

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Production deployment contract validated/u);
  const commands = await readFile(log, "utf8");
  assert.match(commands, /shellcheck --external-sources/u);
  assert.match(commands, /systemd-analyze verify/u);
  assert.match(
    commands,
    /docker compose .*config --no-env-resolution --format json/u,
  );
});

test("required CI invokes the aggregate production contract gate", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/quality.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /name: Validate production deployment contract/u);
  assert.match(workflow, /run: npm run check:production-contract/u);
});

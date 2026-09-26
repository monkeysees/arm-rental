import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const repository = path.resolve(import.meta.dirname, "..");
const image = `ghcr.io/example/rental-apartments@sha256:${"a".repeat(64)}`;

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "rust-maintenance-wrapper-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  const release = path.join(root, "release");
  const state = path.join(root, "state");
  const backup = path.join(root, "backup");
  const snapshot = path.join(backup, "daily", "2026-09-26T00-00-00-000Z");
  for (const directory of [bin, path.join(release, "ops"), state, snapshot]) {
    mkdirSync(directory, { recursive: true });
  }
  const log = path.join(root, "commands.log");
  for (const [name, source] of Object.entries({
    docker: `#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_COMMAND_LOG"
if [[ "$*" == *com.rental-apartments.runtime* ]]; then
  printf '%s\n' rust
elif [[ "$*" == *maintenance:report* || "$*" == *storage:check* ]]; then
  exit "$FAKE_APP_STATUS"
elif [[ "$*" == *'inspect --format'* ]]; then
  printf '%s\n' healthy
fi
`,
    systemctl: `#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >>"$FAKE_COMMAND_LOG"
`,
    "systemd-cat": `#!/usr/bin/env bash
IFS= read -r record || true
printf '%s\n' "$record" >>"$FAKE_COMMAND_LOG"
`,
  })) {
    const filename = path.join(bin, name);
    writeFileSync(filename, source);
    chmodSync(filename, 0o755);
  }
  writeFileSync(
    path.join(release, "compose.production.yaml"),
    "services: {}\n",
  );
  writeFileSync(
    path.join(release, "ops", "compose.native.yaml"),
    "services: {}\n",
  );
  writeFileSync(path.join(root, "production.env"), "TELEGRAM_OWNER_ID=42\n");
  writeFileSync(
    path.join(state, "current-image.env"),
    `RENTAL_APARTMENTS_IMAGE=${image}\n`,
  );
  writeFileSync(
    path.join(snapshot, "manifest.json"),
    JSON.stringify({ createdAt: new Date().toISOString() }),
  );
  const environment = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_COMMAND_LOG: log,
    RENTAL_RELEASE_DIR: release,
    RENTAL_COMPOSE_FILE: path.join(release, "compose.production.yaml"),
    RENTAL_ENV_FILE: path.join(root, "production.env"),
    RENTAL_IMAGE_ENV_FILE: path.join(state, "current-image.env"),
    RENTAL_OPS_STATE_DIR: state,
    RENTAL_BACKUP_ROOT: backup,
    RENTAL_REQUIRE_BACKUP_MOUNT: "0",
    RENTAL_READY_ATTEMPTS: "1",
    RENTAL_READY_INTERVAL_SECONDS: "0",
  };
  return { environment, log };
}

test("native operation wrappers preserve healthy and threshold exit statuses", (t) => {
  const { environment, log } = fixture(t);
  for (const [operation, command] of [
    ["storage-check", "storage:check"],
    ["maintain", "maintenance:report"],
  ]) {
    for (const status of [0, 2]) {
      const result = spawnSync(path.join(repository, "ops", operation), {
        cwd: repository,
        env: { ...environment, FAKE_APP_STATUS: String(status) },
        encoding: "utf8",
      });
      assert.equal(result.status, status, result.stderr);
      const commands = readFileSync(log, "utf8");
      assert.ok(commands.includes(command), commands);
      const event = operation === "maintain" ? "maintenance" : operation;
      assert.match(
        commands,
        new RegExp(
          `"event":"${event}\\.${status === 0 ? "completed" : "failed"}"[^\\n]+"exitCode":${status}`,
          "u",
        ),
      );
      if (operation === "maintain") {
        assert.match(commands, /systemctl start rental-apartments.service/u);
      }
    }
  }
});

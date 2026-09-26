import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
function invoke(label, action, extra = []) {
  const script = `set -Eeuo pipefail
source ops/lib/runtime.sh
docker() { printf '%s\\n' "$LABEL"; }
ops_app_command test-image "$1" "\${@:2}"
printf '%s\\n' "\${OPS_APP_COMMAND[@]}"`;
  return execFileSync("bash", ["-c", script, "test", action, ...extra], {
    env: { ...process.env, LABEL: label },
    encoding: "utf8",
  })
    .trim()
    .split("\n");
}
test("native image labels select native maintenance commands without a Node executable", () => {
  assert.deepEqual(invoke("rust", "backup"), ["backup:create"]);
  assert.deepEqual(invoke("rust", "restore", ["/app-backups/daily/fixture"]), [
    "backup:restore",
    "--snapshot",
    "/app-backups/daily/fixture",
  ]);
  assert.deepEqual(invoke("rust", "initialize"), ["state:init"]);
  assert.deepEqual(invoke("rust", "maintenance"), ["maintenance:report"]);
});
test("published images without a runtime label preserve their Node CLI contract", () => {
  assert.deepEqual(invoke("<no value>", "backup"), [
    "node",
    "src/recovery-cli.js",
    "backup",
  ]);
  assert.deepEqual(invoke("", "restore", ["/snapshot"]), [
    "node",
    "src/recovery-cli.js",
    "restore",
    "/snapshot",
  ]);
  assert.throws(() => invoke("unknown", "backup"));
});

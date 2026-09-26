import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifyReplayResult } from "../node-replay/verify.js";

const [output] = process.argv.slice(2);
assert(output, "Usage: smoke-artifacts.js NEW_REPORT.json");
const directory = mkdtempSync(path.join(tmpdir(), "runtime-artifact-smoke-"));
const results = {};
try {
  const fixtures = path.join(directory, "fixtures");
  execFileSync(process.execPath, [
    "experiments/node-replay/export.js",
    fixtures,
  ]);
  for (const runtime of ["go", "rust"]) {
    const state = path.join(directory, runtime);
    mkdirSync(state, { mode: 0o777 });
    const workers = [];
    for (const stage of ["exercise", "resume"]) {
      const args = [
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--cpus",
        "1",
        "--memory",
        "512m",
        "--memory-swap",
        "512m",
        "--tmpfs",
        "/tmp:rw,nosuid,size=64m",
        "-v",
        `${fixtures}:/fixtures:ro`,
        "-v",
        `${state}:/data`,
        `arm-rental-comparison-${runtime}:local`,
        "--fixtures",
        "/fixtures",
        "--database",
        "/data/state.sqlite3",
        "--users",
        "4",
        "--mode",
        "virtual",
        "--stage",
        stage,
      ];
      const child = spawnSync("docker", args, {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
      assert.equal(child.status, stage === "exercise" ? 23 : 0, child.stderr);
      workers.push(JSON.parse(child.stdout));
    }
    const result = {
      ...workers[1],
      phases: workers.flatMap((worker) => worker.phases),
    };
    verifyReplayResult(result);
    const curl = execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--entrypoint",
        "/usr/local/bin/curl-impersonate",
        `arm-rental-comparison-${runtime}:local`,
        "--version",
      ],
      { encoding: "utf8" },
    );
    results[runtime] = {
      status: "passed",
      users: 4,
      interruptionExitCode: 23,
      oracle: "shared full-contract verifier",
      curl,
    };
  }
  writeFileSync(output, JSON.stringify(results, null, 2), { flag: "wx" });
} finally {
  rmSync(directory, { recursive: true, force: true });
}

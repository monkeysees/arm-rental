import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

test("the recovery exercise candidate fails before production configuration", async () => {
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/index.js"], {
      cwd: repositoryRoot,
      env: { ...process.env, NODE_ENV: "production" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("close", (status, signal) => resolve({ output, signal, status }));
  });

  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.match(result.output, /"event":"application\.started"/u);
  assert.match(result.output, /"event":"application\.failed"/u);
  assert.match(result.output, /ERR_INTENTIONAL_RECOVERY_EXERCISE/u);
  assert.doesNotMatch(
    result.output,
    /DATA_DIRECTORY is required|TELEGRAM_BOT_TOKEN is required/u,
  );
});

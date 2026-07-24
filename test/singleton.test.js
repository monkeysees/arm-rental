import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectDirectory = fileURLToPath(new URL("..", import.meta.url));
const fixture = path.join(projectDirectory, "test-support/service-process.js");

function startService(dataDirectory) {
  const child = spawn(process.execPath, [fixture, dataDirectory], {
    cwd: projectDirectory,
    env: { PATH: process.env.PATH },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  return {
    child,
    output: () => ({ stdout, stderr }),
    exited: new Promise((resolve) => {
      child.once("exit", (code, signal) =>
        resolve({ code, signal, stdout, stderr }),
      );
    }),
  };
}

async function waitForOutput(service, pattern, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const output = service.output();
    if (pattern.test(`${output.stdout}\n${output.stderr}`)) return output;
    if (service.child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const output = service.output();
  throw new Error(
    `Timed out waiting for ${pattern}; stdout=${output.stdout}; stderr=${output.stderr}`,
  );
}

async function temporaryDataDirectory(testContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ra-"));
  testContext.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function stopAfterTest(testContext, service) {
  testContext.after(async () => {
    if (service.child.exitCode === null && service.child.signalCode === null) {
      service.child.kill("SIGKILL");
      await service.exited;
    }
  });
}

test("a second process fails before Telegram polling against the same data directory", async (testContext) => {
  const dataDirectory = await temporaryDataDirectory(testContext);
  const first = startService(dataDirectory);
  stopAfterTest(testContext, first);
  await waitForOutput(first, /SERVICE_READY/u);

  const contender = startService(dataDirectory);
  stopAfterTest(testContext, contender);
  const result = await contender.exited;

  assert.equal(result.code, 1);
  assert.match(result.stderr, /ERR_SINGLETON_LOCKED/u);
  assert.match(result.stderr, /already locked by process/u);
  assert.doesNotMatch(result.stdout, /POLLING_STARTED/u);

  first.child.kill("SIGTERM");
  assert.deepEqual(
    await first.exited.then(({ code, signal }) => ({ code, signal })),
    {
      code: 0,
      signal: null,
    },
  );
});

test("SIGTERM flushes delivery state, closes the Chrome profile, and releases the lease", async (testContext) => {
  const dataDirectory = await temporaryDataDirectory(testContext);
  const first = startService(dataDirectory);
  stopAfterTest(testContext, first);
  await waitForOutput(first, /SERVICE_READY/u);

  first.child.kill("SIGTERM");
  const firstExit = await first.exited;
  assert.equal(firstExit.code, 0);
  assert.match(firstExit.stdout, /Graceful shutdown completed/u);

  const deliveryState = JSON.parse(
    await readFile(path.join(dataDirectory, "fixture-deliveries.json"), "utf8"),
  );
  assert.deepEqual(deliveryState.pending, {});
  assert.deepEqual(deliveryState.notified, { 101: "delivered" });
  assert.equal(deliveryState.runningPid, null);
  assert.equal(deliveryState.shutdownComplete, true);
  await assert.rejects(
    access(path.join(dataDirectory, ".singleton.sock")),
    /ENOENT/u,
  );
  await assert.rejects(
    access(path.join(dataDirectory, "chrome-profile", "SingletonLock")),
    /ENOENT/u,
  );

  const restarted = startService(dataDirectory);
  stopAfterTest(testContext, restarted);
  const restartedOutput = await waitForOutput(restarted, /SERVICE_READY/u);
  assert.doesNotMatch(restartedOutput.stdout, /DELIVERY_BACKLOG/u);
  restarted.child.kill("SIGTERM");
  assert.equal((await restarted.exited).code, 0);
});

test("an unclean exit leaves a safely recoverable stale lease", async (testContext) => {
  const dataDirectory = await temporaryDataDirectory(testContext);
  const crashed = startService(dataDirectory);
  stopAfterTest(testContext, crashed);
  await waitForOutput(crashed, /SERVICE_READY/u);
  crashed.child.kill("SIGKILL");
  assert.equal((await crashed.exited).signal, "SIGKILL");

  const restarted = startService(dataDirectory);
  stopAfterTest(testContext, restarted);
  await waitForOutput(restarted, /SERVICE_READY/u);
  restarted.child.kill("SIGTERM");
  assert.equal((await restarted.exited).code, 0);
});

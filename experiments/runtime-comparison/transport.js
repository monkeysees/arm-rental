import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { memory, cgroup } from "../node-replay/metrics.js";

const payload = readFileSync(
  "test/fixtures/list-am-real-shape/regular-page.html",
);
const hash = (buffer) => createHash("sha256").update(buffer).digest("hex");
const executable = "/usr/local/bin/curl-impersonate";
const server = createServer(async (request, response) => {
  await sleep(100); // Keep the real child observable without external networking.
  response.writeHead(200, {
    "content-type": "text/html",
    "set-cookie": "replay=1; Path=/",
  });
  response.end(payload);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const samples = [],
  runs = [];
try {
  const idle = memory();
  const cpuBefore = cgroup("cpu.stat");
  for (let i = 0; i < 20; i++) {
    const started = performance.now();
    const args = [
      "--impersonate",
      "safari2601",
      "--silent",
      "--show-error",
      "--fail",
      "--cookie",
      "/tmp/comparison-cookies",
      "--cookie-jar",
      "/tmp/comparison-cookies",
      `http://127.0.0.1:${server.address().port}/fixture`,
    ];
    const child = spawn(executable, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let childPeakRssBytes = 0;
    const sample = setInterval(() => {
      try {
        const status = readFileSync(`/proc/${child.pid}/status`, "utf8");
        childPeakRssBytes = Math.max(
          childPeakRssBytes,
          Number(status.match(/^VmHWM:\s+(\d+)/m)?.[1] ?? 0) * 1024,
        );
        samples.push(memory());
      } catch {
        /* Child may exit between the timer and /proc read. */
      }
    }, 5);
    const body = [],
      errors = [];
    child.stdout.on("data", (chunk) => body.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    }).finally(() => clearInterval(sample));
    assert.equal(code, 0, Buffer.concat(errors).toString());
    assert.equal(hash(Buffer.concat(body)), hash(payload));
    runs.push({ wallMs: performance.now() - started, childPeakRssBytes });
    if (i < 19) await sleep(Math.max(0, 2000 - (performance.now() - started)));
  }
  assert.match(readFileSync("/tmp/comparison-cookies", "utf8"), /replay\s+1/);
  // Freeze counters before reading the whole executable for its identity hash.
  const after = memory();
  const cpuAfter = cgroup("cpu.stat");
  const memoryStat = cgroup("memory.stat");
  console.log(
    JSON.stringify(
      {
        status: "passed",
        curlVersion: execFileSync(executable, ["--version"], {
          encoding: "utf8",
        }),
        binarySha256: hash(readFileSync(executable)),
        payloadSha256: hash(payload),
        payloadBytes: payload.length,
        boundary:
          "Dedicated offline container with Node loopback fixture peer and real sequential curl children; 100ms peer delay and 2s request spacing. Separate from replay; not a production TLS measurement.",
        idle,
        after,
        cpuBefore,
        cpuAfter,
        memoryStat,
        runs,
        sampledServicePeakBytes: Math.max(
          ...samples.map((s) => s.serviceCurrentBytes),
        ),
        childPeakRssBytes: Math.max(...runs.map((r) => r.childPeakRssBytes)),
      },
      null,
      2,
    ),
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
}

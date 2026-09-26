import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const binary = process.env.RENTAL_APP_BINARY;
test(
  "native Telegram transport honors a local peer's retry and returns its result",
  { skip: !binary },
  async (t) => {
    let attempts = 0;
    const requests = [];
    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push({
        url: request.url,
        body: JSON.parse(Buffer.concat(chunks)),
      });
      attempts++;
      response.setHeader("content-type", "application/json");
      if (attempts === 1) {
        response.writeHead(429);
        response.end(
          JSON.stringify({
            ok: false,
            error_code: 429,
            parameters: { retry_after: 1 },
          }),
        );
      } else
        response.end(JSON.stringify({ ok: true, result: { message_id: 71 } }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const directory = await mkdtemp(path.join(tmpdir(), "rust-transport-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const child = spawn(binary, ["contract"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const started = performance.now();
    child.stdin.end(
      `${JSON.stringify({ op: "telegram", endpoint: `http://127.0.0.1:${server.address().port}`, directory, executable: "/usr/bin/curl", method: "sendMessage", payload: { chat_id: 123, text: "Привет" } })}\n`,
    );
    assert.equal(
      await new Promise((resolve) => child.on("exit", resolve)),
      0,
      stderr,
    );
    assert.deepEqual(JSON.parse(stdout), { message_id: 71 });
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0], requests[1]);
    assert.ok(performance.now() - started >= 1000);
  },
);

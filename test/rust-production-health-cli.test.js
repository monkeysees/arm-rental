import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";

const binary = process.env.RENTAL_APP_BINARY;
test(
  "native readiness CLI preserves safe readiness and alert reason output",
  { skip: !binary },
  async (t) => {
    let body = {
      ready: false,
      reasons: ["LIST_AM_CHALLENGE"],
      alertReasons: [],
    };
    const server = createServer((_request, response) => {
      response.writeHead(body.ready ? 200 : 503);
      response.end(JSON.stringify(body));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    async function probe() {
      const child = spawn(binary, ["health-check", "--ready", "--json"], {
        env: {
          HEALTH_HOST: "127.0.0.1",
          HEALTH_PORT: String(server.address().port),
        },
      });
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      const status = await new Promise((resolve) => child.on("exit", resolve));
      return { status, output: JSON.parse(stdout) };
    }
    assert.deepEqual(await probe(), {
      status: 1,
      output: {
        status: "not_ready",
        reasons: ["LIST_AM_CHALLENGE"],
        alertReasons: [],
      },
    });
    body = { ready: true, reasons: [], alertReasons: [] };
    assert.deepEqual(await probe(), {
      status: 0,
      output: { status: "ready", reasons: [], alertReasons: [] },
    });
    body = {
      ready: false,
      reasons: ["secret:do-not-project"],
      alertReasons: [],
    };
    assert.deepEqual(await probe(), {
      status: 1,
      output: {
        status: "not_ready",
        reasons: ["READINESS_RESPONSE_INVALID"],
        alertReasons: ["READINESS_RESPONSE_INVALID"],
      },
    });
  },
);

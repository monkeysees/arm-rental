import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readdir, rm, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
const binary = process.env.RENTAL_APP_BINARY;
test(
  "native source smoke cancels its HTTP child and releases its singleton",
  { skip: !binary, timeout: 10000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "native-smoke-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    let received;
    const request = new Promise((resolve) => {
      received = resolve;
    });
    const server = createServer(() => received());
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    });
    const child = spawn(
      binary,
      [
        "source:smoke",
        "--source-origin",
        `http://127.0.0.1:${server.address().port}`,
      ],
      {
        env: {
          NODE_ENV: "test",
          TELEGRAM_BOT_TOKEN: "123:test",
          TELEGRAM_OWNER_ID: "123",
          DATA_DIRECTORY: path.join(root, "data"),
          CURL_IMPERSONATE_PATH: "/usr/bin/curl",
        },
        stdio: "pipe",
      },
    );
    t.after(() => child.kill("SIGKILL"));
    const exited = new Promise((resolve) =>
      child.on("exit", (code, signal) => resolve({ code, signal })),
    );
    await request;
    child.kill("SIGTERM");
    assert.deepEqual(await exited, { code: 1, signal: null });
    assert.ok(
      !(await readdir(path.join(root, "data"))).some((name) =>
        name.startsWith(".singleton"),
      ),
    );
  },
);
test(
  "native startup refuses managed sentinel symlinks before external requests",
  { skip: !binary },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "native-path-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const data = path.join(root, "data");
    await mkdir(data);
    await symlink("/dev/null", path.join(data, "apartments.json"));
    const child = spawn(binary, ["serve"], {
      env: {
        NODE_ENV: "test",
        TELEGRAM_BOT_TOKEN: "123:test",
        TELEGRAM_OWNER_ID: "123",
        DATA_DIRECTORY: data,
      },
      stdio: "pipe",
    });
    let error = "";
    child.stderr.on("data", (chunk) => {
      error += chunk;
    });
    const status = await new Promise((resolve) => child.on("exit", resolve));
    assert.equal(status, 1);
    assert.match(error, /safe regular file/);
  },
);

test(
  "native source transport preserves cookies, redirect boundaries, pacing and challenge isolation",
  { skip: !binary, timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "native-source-http-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    let mode = "success";
    const requests = [];
    const server = createServer((request, response) => {
      requests.push({
        url: request.url,
        cookie: request.headers.cookie,
        at: performance.now(),
      });
      if (mode === "challenge") {
        response.writeHead(403, {
          "cf-mitigated": "challenge",
          "set-cookie": "session=poison",
        });
        response.end("Just a moment /cdn-cgi/challenge-platform/");
      } else if (mode === "cross-origin") {
        response.writeHead(302, {
          location: "https://example.invalid/forbidden",
        });
        response.end();
      } else if (request.url.includes("/56/")) {
        response.writeHead(302, {
          location: "/apartment-final",
          "set-cookie": "session=trusted; Path=/",
        });
        response.end();
      } else {
        const house = request.url.includes("/1377/");
        response.end(
          `<div id="contentr"><a class="category-data-list-card__destination" href="/ru/item/${house ? 200 : 100}"><div class="pt">Квартира</div><div class="p">200000 ֏</div><div class="l">Кентрон</div><div class="at">2 ком. · 60 кв.м. · 2/5</div><div class="d">Сегодня, 00:00</div></a></div>`,
        );
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const data = path.join(root, "data");
    async function smoke() {
      const child = spawn(
        binary,
        [
          "source:smoke",
          "--source-origin",
          `http://127.0.0.1:${server.address().port}`,
        ],
        {
          env: {
            NODE_ENV: "test",
            TELEGRAM_BOT_TOKEN: "123:test",
            TELEGRAM_OWNER_ID: "123",
            DATA_DIRECTORY: data,
            CURL_IMPERSONATE_PATH: "/usr/bin/curl",
          },
        },
      );
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const status = await new Promise((resolve) => child.on("exit", resolve));
      return { status, stdout, stderr };
    }
    const success = await smoke();
    assert.equal(success.status, 0, success.stderr);
    assert.equal(JSON.parse(success.stdout).pages.length, 2);
    assert.equal(requests[1].cookie, "session=trusted");
    assert.equal(requests[2].cookie, "session=trusted");
    assert.ok(requests[2].at - requests[0].at >= 1900);
    const { readFile } = await import("node:fs/promises");
    const before = await readFile(path.join(data, "list-am-cookies.txt"));
    mode = "challenge";
    const challenge = await smoke();
    assert.equal(challenge.status, 1);
    assert.match(challenge.stderr, /ERR_LIST_AM_CHALLENGE/);
    assert.deepEqual(
      await readFile(path.join(data, "list-am-cookies.txt")),
      before,
    );
    mode = "cross-origin";
    assert.match((await smoke()).stderr, /crossed origin/);
    assert.ok(
      (await readdir(data)).every(
        (name) =>
          !name.startsWith(".native-http-") &&
          !name.startsWith(".source-cookie-"),
      ),
    );
  },
);

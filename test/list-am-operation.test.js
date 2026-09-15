import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ListAmChallengeError } from "../src/list-am-http.js";
import { runSourceSmoke } from "../src/list-am-operation.js";

const html = await readFile(
  new URL(
    "./fixtures/list-am-real-shape/regular-page-redesign.html",
    import.meta.url,
  ),
  "utf8",
);

function fixture(fetch = async () => new Response(html)) {
  const calls = [];
  return {
    calls,
    options: {
      validateConfig: async () => calls.push("validate"),
      acquireLock: async () => ({ release: async () => calls.push("release") }),
      sourceFetcherFactory: () => ({
        start: async () => calls.push("start"),
        fetch: async (url) => {
          calls.push(url);
          return fetch(url);
        },
        close: async () => calls.push("close"),
      }),
    },
  };
}

test("source smoke validates both categories and releases the shared lease", async () => {
  const { calls, options } = fixture();
  const result = await runSourceSmoke({ dataDirectory: "/data" }, options);
  assert.deepEqual(
    result.pages.map((page) => page.kind),
    ["apartment", "house"],
  );
  assert.ok(result.pages.every((page) => page.parsedCount > 0));
  assert.match(calls[2], /\/56\/1\?/u);
  assert.match(calls[3], /\/1377\/1\?/u);
  assert.deepEqual(calls.slice(-2), ["close", "release"]);
});

test("source smoke stops on a challenge and always closes before releasing", async () => {
  const { calls, options } = fixture(async () => {
    throw new ListAmChallengeError(403, "edge");
  });
  await assert.rejects(runSourceSmoke({ dataDirectory: "/data" }, options), {
    code: "ERR_LIST_AM_CHALLENGE",
  });
  assert.equal(calls.filter((call) => call.startsWith("https:")).length, 1);
  assert.deepEqual(calls.slice(-2), ["close", "release"]);
});

test("source smoke cannot start a transport when the service holds its lease", async () => {
  const { calls, options } = fixture();
  options.acquireLock = async () => {
    throw new Error("already running");
  };
  await assert.rejects(runSourceSmoke({}, options), /already running/u);
  assert.deepEqual(calls, ["validate"]);
});

test("source smoke rejects HTTP failures and invalid source content", async () => {
  for (const response of [
    new Response("unavailable", { status: 503 }),
    new Response("<html></html>"),
  ]) {
    const { calls, options } = fixture(async () => response);
    await assert.rejects(runSourceSmoke({}, options));
    assert.deepEqual(calls.slice(-2), ["close", "release"]);
  }
});

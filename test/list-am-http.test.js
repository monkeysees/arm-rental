import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  ListAmChallengeError,
  ListAmHttpFetcher,
  ListAmTransportError,
} from "../src/list-am-http.js";

const URL = "https://www.list.am/ru/category/56/1";

async function fixture(t, scenario = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "list-am-http-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, "curl-impersonate");
  const log = path.join(directory, "requests.jsonl");
  const settings = path.join(directory, "scenario.json");
  await writeFile(settings, JSON.stringify(scenario));
  await writeFile(
    binary,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(${JSON.stringify(settings)}));
if (args.includes('--version')) {
  process.stdout.write(config.version || 'curl 8.21.0-IMPERSONATE (Linux)');
  process.exit(0);
}
const value = name => args[args.indexOf(name) + 1];
const cookieFile = value('--cookie');
const cookie = fs.readFileSync(cookieFile, 'utf8');
const calls = fs.existsSync(${JSON.stringify(log)}) ? fs.readFileSync(${JSON.stringify(log)}, 'utf8').trim().split('\\n').length : 0;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args, cookie, pid: process.pid}) + '\\n');
const response = config.requireNavigationReferer && value('--referer') !== 'https://www.list.am/ru/'
  ? { status: 403, headers: { 'cf-mitigated': 'challenge' }, body: 'Security verification' }
  : config.responses?.[calls] || config;
if (response.wait) {
  setInterval(() => {}, 1000);
} else if (response.exit) {
  process.stderr.write('SECRET raw connection details');
  process.exit(response.exit);
} else {
  fs.writeFileSync(value('--cookie-jar'), response.cookie || 'session=updated');
  process.stdout.write((response.prefix || '') + 'HTTP/2 ' + (response.status || 200) + ' OK\\r\\n' + Object.entries(response.headers || {}).map(([key,value]) => key + ': ' + value + '\\r\\n').join('') + '\\r\\n' + (response.large ? 'x'.repeat(9 * 1024 * 1024) : response.body || '<div id="contentr">listing</div>'));
}
`,
    { mode: 0o700 },
  );
  const config = {
    curlImpersonatePath: binary,
    listAmCookieFile: path.join(directory, "cookies"),
    timeoutMs: 3000,
  };
  const events = [];
  const fetcher = new ListAmHttpFetcher(config, {
    onEvent: (event) => events.push(event),
    sleep: async () => {},
  });
  t.after(() => fetcher.close());
  const requests = async () =>
    (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  return { config, fetcher, events, requests, directory, settings };
}

async function waitForRequest(requests) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return await requests();
    } catch {
      await delay(10);
    }
  }
  assert.fail("Child process did not start");
}

test("uses pinned Safari profile, ignores curlrc, and persists private cookies across restarts", async (t) => {
  const { fetcher, config, requests, directory } = await fixture(t);
  const first = await fetcher.fetch(URL);
  assert.equal(first.ok, true);
  assert.match(await first.text(), /contentr/u);
  await fetcher.close();
  const restarted = new ListAmHttpFetcher(config);
  t.after(() => restarted.close());
  await restarted.fetch(URL);
  const calls = await requests();
  assert.equal(calls[0].args[0], "--disable");
  assert.equal(
    calls[0].args[calls[0].args.indexOf("--impersonate") + 1],
    "safari2601",
  );
  assert.equal(calls[1].cookie, "session=updated");
  assert.equal((await stat(config.listAmCookieFile)).mode & 0o777, 0o600);
  assert.equal(
    (await readdir(directory)).some((name) =>
      name.startsWith(".list-am-http-"),
    ),
    false,
  );
});

test("loads protected category pages with the List.am navigation referrer", async (t) => {
  const { fetcher, events } = await fixture(t, {
    requireNavigationReferer: true,
  });
  for (const category of [56, 1377]) {
    const response = await fetcher.fetch(
      `https://www.list.am/ru/category/${category}/1`,
    );
    assert.equal(response.status, 200);
    assert.match(await response.text(), /contentr/u);
  }
  assert.deepEqual(events, []);
});

test("ordinary curl and unavailable binaries fail startup", async (t) => {
  const { fetcher, config } = await fixture(t, { version: "curl 8.21.0" });
  await assert.rejects(fetcher.start(), /requires curl-impersonate/u);
  const missing = new ListAmHttpFetcher({
    ...config,
    curlImpersonatePath: "/nonexistent/curl-impersonate",
  });
  await assert.rejects(missing.start(), ListAmTransportError);
});

test("preserves status and retry-after without classifying upstream errors as challenges", async (t) => {
  const { fetcher, events } = await fixture(t, {
    status: 429,
    headers: { "Retry-After": "120" },
    body: "Please wait",
  });
  const response = await fetcher.fetch(URL);
  assert.equal(response.status, 429);
  assert.equal(response.ok, false);
  assert.equal(response.headers.get("retry-after"), "120");
  assert.equal(await response.text(), "Please wait");
  assert.deepEqual(events, []);
});

for (const status of [200, 403]) {
  test(`detects explicit challenge headers at HTTP ${status} without exposing bodies`, async (t) => {
    const { fetcher, events } = await fixture(t, {
      status,
      headers: { "Cf-Mitigated": "challenge" },
      body: "SECRET",
    });
    await assert.rejects(fetcher.fetch(URL), (error) => {
      assert.ok(error instanceof ListAmChallengeError);
      assert.equal(error.httpStatus, status);
      assert.equal(error.challengeSource, "edge");
      assert.doesNotMatch(error.message, /SECRET/u);
      return true;
    });
    assert.deepEqual(events, [
      {
        name: "list_am.challenge",
        severity: "warning",
        component: "list_am",
        code: "ERR_LIST_AM_CHALLENGE",
        httpStatus: status,
        challengeSource: "edge",
      },
    ]);
  });
}

test("recognizes challenge interstitial but leaves arbitrary missing content to integrity checks", async (t) => {
  const { fetcher, events } = await fixture(t, {
    responses: [
      {
        body: '<title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/h/g"></script>',
      },
      { body: "<title>Maintenance</title>" },
      {
        body: '<script src="/cdn-cgi/challenge-platform/analytics"></script>ordinary listing',
      },
    ],
  });
  await assert.rejects(
    fetcher.fetch(URL),
    (error) => error.challengeSource === "interstitial",
  );
  assert.equal((await fetcher.fetch(URL)).ok, true);
  assert.equal((await fetcher.fetch(URL)).ok, true);
  assert.equal(events.length, 1);
});

test("follows relative pagination redirect with cookies and returns the repeated page", async (t) => {
  const { fetcher, requests } = await fixture(t, {
    responses: [
      {
        status: 302,
        headers: { Location: "/ru/category/56" },
        cookie: "redirect=session",
      },
      {
        body: "same page one listings",
        prefix:
          "HTTP/1.1 200 Connection established\r\n\r\nHTTP/2 103 Early Hints\r\nLink: </style>\r\n\r\n",
      },
    ],
  });
  assert.equal(
    await (await fetcher.fetch(URL)).text(),
    "same page one listings",
  );
  const calls = await requests();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].cookie, "redirect=session");
  assert.equal(calls[1].args.at(-1), "https://www.list.am/ru/category/56");
});

for (const location of [
  "https://evil.example/",
  "http://www.list.am/",
  "https://www.list.am:444/",
  "https://user:secret@www.list.am/",
]) {
  test(`rejects redirect outside the permitted origin: ${new globalThis.URL(location).origin}`, async (t) => {
    const { fetcher, requests } = await fixture(t, {
      status: 302,
      headers: { location },
    });
    await assert.rejects(
      fetcher.fetch(URL),
      /outside the permitted HTTPS origin/u,
    );
    assert.equal((await requests()).length, 1);
  });
}

test("bounds redirect loops", async (t) => {
  const { fetcher, requests } = await fixture(t, {
    status: 302,
    headers: { location: URL },
  });
  await assert.rejects(fetcher.fetch(URL), /redirect limit/u);
  assert.equal((await requests()).length, 6);
});

test("rejects invalid request URLs before launching a request", async (t) => {
  const { fetcher } = await fixture(t);
  await assert.rejects(
    fetcher.fetch("https://evil.example/"),
    ListAmTransportError,
  );
  await assert.rejects(fetcher.fetch("invalid"), ListAmTransportError);
});

test("rejects symlink cookie jars without touching their targets", async (t) => {
  const { fetcher, config, directory } = await fixture(t);
  const target = path.join(directory, "other");
  await writeFile(target, "untouched", { mode: 0o644 });
  await symlink(target, config.listAmCookieFile);
  await assert.rejects(fetcher.start(), /private List.am cookie jar/u);
  assert.equal(await readFile(target, "utf8"), "untouched");
  assert.equal((await stat(target)).mode & 0o777, 0o644);
});

test("bounds response size and suppresses subprocess stderr", async (t) => {
  const { fetcher } = await fixture(t, {
    responses: [{ large: true }, { exit: 7 }],
  });
  await assert.rejects(fetcher.fetch(URL), /exceeds size limit/u);
  await assert.rejects(fetcher.fetch(URL), (error) => {
    assert.ok(error instanceof ListAmTransportError);
    assert.doesNotMatch(error.message, /SECRET/u);
    return true;
  });
});

test("timeout kills and reaps the child and removes temporary cookies", async (t) => {
  const { fetcher, config, requests, directory } = await fixture(t, {
    wait: true,
  });
  await fetcher.start();
  config.timeoutMs = 1000;
  await assert.rejects(fetcher.fetch(URL), /timed out/u);
  const [{ pid }] = await requests();
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.equal(
    (await readdir(directory)).some((name) =>
      name.startsWith(".list-am-http-"),
    ),
    false,
  );
});

test("close aborts and reaps an active request and rejects concurrent fetches", async (t) => {
  const { fetcher, requests } = await fixture(t, { wait: true });
  const pending = assert.rejects(fetcher.fetch(URL), { name: "AbortError" });
  const [{ pid }] = await waitForRequest(requests);
  await assert.rejects(fetcher.fetch(URL), /Concurrent/u);
  await fetcher.close();
  await pending;
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await assert.rejects(fetcher.fetch(URL), { name: "AbortError" });
});

test("external cancellation stops a running child", async (t) => {
  const { config, requests } = await fixture(t, { wait: true });
  const controller = new AbortController();
  const fetcher = new ListAmHttpFetcher(config, { signal: controller.signal });
  t.after(() => fetcher.close());
  const pending = assert.rejects(fetcher.fetch(URL), { name: "AbortError" });
  const [{ pid }] = await waitForRequest(requests);
  controller.abort();
  await pending;
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("failed requests leave the persisted cookie jar unchanged", async (t) => {
  const { fetcher, config } = await fixture(t, {
    responses: [
      { cookie: "known-good" },
      { headers: { "cf-mitigated": "challenge" }, cookie: "challenged" },
    ],
  });
  await fetcher.fetch(URL);
  await assert.rejects(fetcher.fetch(URL), ListAmChallengeError);
  assert.equal(await readFile(config.listAmCookieFile, "utf8"), "known-good");
});

test("null-body HTTP statuses remain valid responses", async (t) => {
  const { fetcher } = await fixture(t, { status: 304 });
  const response = await fetcher.fetch(URL);
  assert.equal(response.status, 304);
  assert.equal(await response.text(), "");
});

test("challenge responses retain the server Retry-After cooldown", async (t) => {
  const { fetcher } = await fixture(t, {
    status: 429,
    headers: { "cf-mitigated": "challenge", "retry-after": "180" },
  });
  await assert.rejects(fetcher.fetch(URL), (error) => {
    assert.equal(error.code, "ERR_LIST_AM_CHALLENGE");
    assert.equal(error.retryAfterMs, 180_000);
    return true;
  });
});

test("sequential requests wait between pages and close aborts the pacing wait", async (t) => {
  const { config } = await fixture(t);
  let enteredWait;
  const waiting = new Promise((resolve) => {
    enteredWait = resolve;
  });
  const fetcher = new ListAmHttpFetcher(config, {
    sleep: async (ms, value, options) => {
      assert.ok(ms > 0 && ms <= 2000);
      enteredWait();
      await delay(ms, value, options);
    },
  });
  t.after(() => fetcher.close());
  await fetcher.fetch(URL);
  const pending = fetcher.fetch(URL);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await waiting;
  await fetcher.close();
  await rejected;
});

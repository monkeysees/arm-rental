import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BROWSER_CHALLENGE_EVENT,
  BROWSER_FORCED_EXIT_EVENT,
  BrowserContentTimeoutError,
  BrowserPageFetcher,
  BrowserVerificationRequiredError,
  findChromeExecutable,
  terminateChromeProcess,
} from "../src/browser-fetch.js";

async function temporaryConfig(testContext, overrides = {}) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rental-browser-test-"),
  );
  testContext.after(() => rm(directory, { recursive: true, force: true }));
  return {
    browserChallengeTimeoutMs: 100,
    browserHeadless: true,
    browserProfileDir: path.join(directory, "profile"),
    browserProtocolTimeoutMs: 100,
    browserStartMinimized: true,
    chromeExecutablePath: process.execPath,
    timeoutMs: 100,
    ...overrides,
  };
}

function browserPage(overrides = {}) {
  return {
    $: async () => ({ id: "contentr" }),
    content: async () => '<div id="contentr"></div>',
    evaluate: async () => {},
    evaluateOnNewDocument: async () => {},
    goto: async () => {},
    isClosed: () => false,
    setDefaultNavigationTimeout: () => {},
    setUserAgent: async () => {},
    url: () => "https://www.list.am/",
    ...overrides,
  };
}

function navigationResponse({ status = 200, statusText = "", headers = {} }) {
  return {
    status: () => status,
    statusText: () => statusText,
    headers: () => headers,
  };
}

function launchedBrowser(page, onClose = () => {}) {
  return {
    close: async () => onClose(),
    connected: true,
    pages: async () => [page],
    version: async () => "HeadlessChrome/161.0.9001.4",
    process: () => undefined,
  };
}

async function assertMissing(filename) {
  await assert.rejects(access(filename), { code: "ENOENT" });
}

test("launch failure removes the isolated Chrome runtime directory", async (t) => {
  const config = await temporaryConfig(t, { browserHeadless: false });
  let launchOptions;
  const launchError = new Error("Chrome failed after spawning");
  const fetcher = new BrowserPageFetcher(config, {
    puppeteerImpl: {
      launch: async (options) => {
        launchOptions = options;
        throw launchError;
      },
    },
    platform: "linux",
  });

  await assert.rejects(fetcher.start(), launchError);

  assert.equal(launchOptions.userDataDir, config.browserProfileDir);
  assert.equal(launchOptions.headless, false);
  assert.equal(launchOptions.dumpio, false);
  assert.equal(launchOptions.pipe, false);
  assert.ok(launchOptions.args.includes("--disk-cache-size=67108864"));
  assert.ok(
    launchOptions.args.includes("--blink-settings=imagesEnabled=false"),
  );
  assert.ok(launchOptions.args.includes("--disable-breakpad"));
  assert.ok(launchOptions.args.includes("--disable-crash-reporter"));
  assert.ok(
    launchOptions.args.includes("--remote-debugging-address=127.0.0.1"),
  );
  assert.ok(launchOptions.args.includes("--remote-debugging-port=0"));
  assert.ok(
    launchOptions.args.every(
      (argument) => !argument.startsWith("--crash-dumps-dir="),
    ),
  );
  assert.equal(launchOptions.env.HOME, launchOptions.env.TMPDIR);
  assert.equal(launchOptions.env.SQLITE_TMPDIR, launchOptions.env.TMPDIR);
  assert.equal(
    launchOptions.env.XDG_CACHE_HOME,
    path.join(launchOptions.env.TMPDIR, "cache"),
  );
  assert.equal(
    launchOptions.env.XDG_CONFIG_HOME,
    path.join(launchOptions.env.TMPDIR, "config"),
  );
  assert.equal(launchOptions.env.TMPDIR, launchOptions.env.XDG_RUNTIME_DIR);
  await assertMissing(path.dirname(launchOptions.env.TMPDIR));
});

test("executable discovery fails clearly when the configured path is absent", async () => {
  await assert.rejects(
    findChromeExecutable("/definitely/missing/chrome", "unsupported"),
    /Chrome was not found/u,
  );
});

test("launch removes only stale Chromium singleton symlinks", async (t) => {
  const config = await temporaryConfig(t);
  await mkdir(config.browserProfileDir, { recursive: true });
  for (const [name, target] of [
    ["SingletonLock", "stale-container-99999999"],
    ["SingletonCookie", "stale-cookie"],
    ["SingletonSocket", "/tmp/stale-chromium-socket"],
  ]) {
    await symlink(target, path.join(config.browserProfileDir, name));
  }
  const fetcher = new BrowserPageFetcher(config, {
    puppeteerImpl: {
      launch: async () => launchedBrowser(browserPage()),
    },
  });

  await fetcher.start();
  await fetcher.close();

  for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    await assertMissing(path.join(config.browserProfileDir, name));
  }
});

test("launch refuses to remove unexpected singleton files", async (t) => {
  const config = await temporaryConfig(t);
  await mkdir(config.browserProfileDir, { recursive: true });
  await writeFile(path.join(config.browserProfileDir, "SingletonCookie"), "");
  let launched = false;
  const fetcher = new BrowserPageFetcher(config, {
    puppeteerImpl: {
      launch: async () => {
        launched = true;
        return launchedBrowser(browserPage());
      },
    },
  });

  await assert.rejects(fetcher.start(), /is not a symbolic link/u);
  assert.equal(launched, false);
});

test("background macOS launch keeps remote control on loopback", async (t) => {
  const config = await temporaryConfig(t, {
    browserDebugPort: 49_222,
    browserHeadless: false,
    browserStartMinimized: true,
  });
  const page = browserPage();
  const browser = launchedBrowser(page);
  const commands = [];
  let connectionAttempts = 0;
  const fetcher = new BrowserPageFetcher(config, {
    platform: "darwin",
    executeFileImpl: async (command, args) => commands.push([command, args]),
    puppeteerImpl: {
      connect: async () => {
        connectionAttempts += 1;
        if (connectionAttempts === 1) throw new Error("not launched yet");
        return browser;
      },
      defaultArgs: async () => [
        "--enable-automation",
        "--remote-debugging-pipe",
        "about:blank",
        "--lang=ru-RU",
      ],
    },
  });

  await fetcher.start();
  await fetcher.close();

  assert.equal(connectionAttempts, 2);
  assert.equal(commands.length, 1);
  assert.equal(commands[0][0], "open");
  assert.ok(commands[0][1].includes("--remote-debugging-address=127.0.0.1"));
  assert.ok(commands[0][1].includes("--remote-debugging-port=49222"));
  assert.equal(commands[0][1].includes("--remote-debugging-pipe"), false);
});

test("BROWSER_LOAD_IMAGES restores image loading without a rebuild", async (t) => {
  const config = await temporaryConfig(t, { browserLoadImages: true });
  let launchOptions;
  const fetcher = new BrowserPageFetcher(config, {
    puppeteerImpl: {
      launch: async (options) => {
        launchOptions = options;
        return launchedBrowser(browserPage());
      },
    },
  });

  await fetcher.start();
  await fetcher.close();

  assert.equal(
    launchOptions.args.some((argument) =>
      argument.startsWith("--blink-settings="),
    ),
    false,
  );
});

test("the user agent and client hints follow the installed Chromium version", async (t) => {
  const config = await temporaryConfig(t);
  const assigned = [];
  let launchOptions;
  const page = browserPage({
    setUserAgent: async (userAgent, metadata) =>
      assigned.push({ userAgent, metadata }),
  });
  const fetcher = new BrowserPageFetcher(config, {
    platform: "linux",
    puppeteerImpl: {
      launch: async (options) => {
        launchOptions = options;
        return launchedBrowser(page);
      },
    },
  });

  await fetcher.start();
  await fetcher.close();

  assert.equal(assigned.length, 1);
  const [{ userAgent, metadata }] = assigned;
  assert.equal(
    userAgent,
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/161.0.9001.4 Safari/537.36",
    "an upgraded runtime browser must present its installed version",
  );
  assert.equal(
    userAgent.includes("Headless"),
    false,
    "the headless product token must not reach List.am",
  );
  const major = "161.0.9001.4".split(".")[0];
  assert.deepEqual(
    metadata.brands.find(({ brand }) => brand === "Chromium"),
    { brand: "Chromium", version: major },
    "client hints carry the version a second time and must agree",
  );
  assert.deepEqual(
    metadata.fullVersionList.find(({ brand }) => brand === "Chromium"),
    { brand: "Chromium", version: "161.0.9001.4" },
  );
  assert.equal(metadata.fullVersion, "161.0.9001.4");
  assert.equal(metadata.platform, "Linux");
  assert.equal(metadata.mobile, false);
  assert.equal(
    launchOptions.args.includes("--start-minimized"),
    false,
    "headless Chromium must remain visible to its renderer scheduler",
  );
});

test("the interactive verifier presents the identity the crawl will reuse", async (t) => {
  const identities = [];
  for (const browserHeadless of [false, true]) {
    const config = await temporaryConfig(t, {
      browserHeadless,
      browserStartMinimized: false,
    });
    const page = browserPage({
      setUserAgent: async (userAgent, metadata) =>
        identities.push({ userAgent, metadata }),
    });
    const fetcher = new BrowserPageFetcher(config, {
      platform: "linux",
      puppeteerImpl: { launch: async () => launchedBrowser(page) },
    });

    await fetcher.start();
    await fetcher.close();
  }

  assert.equal(identities.length, 2);
  assert.deepEqual(
    identities[0],
    identities[1],
    "a cookie minted headfully is only honoured for the session that minted it",
  );
});

test("a stale browser identity override cannot mask the installed version", async (t) => {
  const config = await temporaryConfig(t, {
    browserUserAgentVersion: "153.0.8000.11",
  });
  const assigned = [];
  const page = browserPage({
    setUserAgent: async (userAgent, metadata) =>
      assigned.push({ userAgent, metadata }),
  });
  const fetcher = new BrowserPageFetcher(config, {
    platform: "linux",
    puppeteerImpl: { launch: async () => launchedBrowser(page) },
  });

  await fetcher.start();
  await fetcher.close();

  assert.match(assigned[0].userAgent, /Chrome\/161\.0\.9001\.4 Safari/u);
  assert.equal(assigned[0].metadata.fullVersion, "161.0.9001.4");
  assert.equal(
    assigned[0].metadata.brands.find(({ brand }) => brand === "Chromium")
      ?.version,
    "161",
  );
});

test("an invalid installed browser version closes Chrome before navigation", async (t) => {
  const config = await temporaryConfig(t);
  let closes = 0;
  let assignments = 0;
  const browser = launchedBrowser(
    browserPage({ setUserAgent: async () => (assignments += 1) }),
    () => (closes += 1),
  );
  browser.version = async () => "Chrome/unknown";
  const fetcher = new BrowserPageFetcher(config, {
    puppeteerImpl: { launch: async () => browser },
  });

  await assert.rejects(
    fetcher.start(),
    /did not report a full Chromium version/u,
  );
  assert.equal(closes, 1);
  assert.equal(assignments, 0);
});

test("challenge detection emits an alertable event and closes Chrome", async (t) => {
  const config = await temporaryConfig(t);
  const events = [];
  let closeCount = 0;
  let launchOptions;
  const page = browserPage({ $: async () => null });
  const fetcher = new BrowserPageFetcher(config, {
    onEvent: async (event) => events.push(event),
    puppeteerImpl: {
      launch: async (options) => {
        launchOptions = options;
        return launchedBrowser(page, () => {
          closeCount += 1;
        });
      },
    },
  });

  await assert.rejects(
    fetcher.fetch("https://www.list.am/ru/category/56/1"),
    BrowserVerificationRequiredError,
  );

  assert.deepEqual(events, [
    {
      name: BROWSER_CHALLENGE_EVENT,
      severity: "warning",
      component: "browser",
      code: "ERR_BROWSER_VERIFICATION_REQUIRED",
      remediationCommand: "npm run browser:verify",
      // Which category was challenged, and that nothing but the missing
      // container said so — the navigation reported no status at all.
      url: "https://www.list.am/ru/category/56/1",
      challengeSource: "missing_content",
    },
  ]);
  assert.equal(closeCount, 1);
  await assertMissing(path.dirname(launchOptions.env.TMPDIR));
});

test("the edge naming a mitigation is a challenge even when the page rendered", async (t) => {
  const config = await temporaryConfig(t);
  const events = [];
  // A listing container is present, so the pre-existing selector test would
  // have called this a healthy page and returned the interstitial as listings.
  const page = browserPage({
    goto: async () =>
      navigationResponse({
        status: 403,
        statusText: "Forbidden",
        headers: { "cf-mitigated": "challenge", "cf-ray": "9a1b2c3d4e5f" },
      }),
  });
  const fetcher = new BrowserPageFetcher(config, {
    onEvent: async (event) => events.push(event),
    puppeteerImpl: { launch: async () => launchedBrowser(page) },
  });

  await assert.rejects(
    fetcher.fetch("https://www.list.am/ru/category/1377/1"),
    BrowserVerificationRequiredError,
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].url, "https://www.list.am/ru/category/1377/1");
  assert.equal(events[0].httpStatus, 403);
  assert.equal(
    events[0].challengeSource,
    "edge",
    "a labelled mitigation is proof, not an inference from a missing selector",
  );
});

test("an origin failure is reported as itself rather than as a challenge", async (t) => {
  const config = await temporaryConfig(t);
  const events = [];
  const page = browserPage({
    $: async () => null,
    goto: async () =>
      navigationResponse({ status: 502, statusText: "Bad Gateway" }),
  });
  const fetcher = new BrowserPageFetcher(config, {
    onEvent: async (event) => events.push(event),
    puppeteerImpl: { launch: async () => launchedBrowser(page) },
  });

  const response = await fetcher.fetch("https://www.list.am/ru/category/56/1");

  assert.equal(response.ok, false);
  assert.equal(response.status, 502);
  assert.deepEqual(
    events,
    [],
    "a bad gateway must not send an operator to the verification runbook",
  );
});

test("an interstitial served as 200 is still caught by the missing container", async (t) => {
  const config = await temporaryConfig(t);
  const events = [];
  const page = browserPage({
    $: async () => null,
    goto: async () => navigationResponse({ status: 200 }),
  });
  const fetcher = new BrowserPageFetcher(config, {
    onEvent: async (event) => events.push(event),
    puppeteerImpl: { launch: async () => launchedBrowser(page) },
  });

  await assert.rejects(
    fetcher.fetch("https://www.list.am/ru/category/56/1"),
    BrowserVerificationRequiredError,
  );

  assert.equal(events[0].httpStatus, 200);
  assert.equal(events[0].challengeSource, "missing_content");
});

test("a crawl's later pages say which page they came from", async (t) => {
  const config = await temporaryConfig(t);
  const navigations = [];
  const page = browserPage({
    goto: async (url, options) => {
      navigations.push({ url, referer: options?.referer });
      return navigationResponse({ status: 200 });
    },
  });
  const fetcher = new BrowserPageFetcher(config, {
    puppeteerImpl: { launch: async () => launchedBrowser(page) },
  });

  await fetcher.fetch("https://www.list.am/ru/category/56/1");
  await fetcher.fetch("https://www.list.am/ru/category/56/2");
  await fetcher.endSession();
  await fetcher.fetch("https://www.list.am/ru/category/56/1");
  await fetcher.close();

  assert.deepEqual(navigations, [
    { url: "https://www.list.am/ru/category/56/1", referer: undefined },
    {
      url: "https://www.list.am/ru/category/56/2",
      referer: "https://www.list.am/ru/category/56/1",
    },
    // A new session has no history behind it and must not borrow the last
    // one's, which would claim a click that never happened.
    { url: "https://www.list.am/ru/category/56/1", referer: undefined },
  ]);
});

test("a challenged page does not become the next page's referer", async (t) => {
  const config = await temporaryConfig(t);
  const navigations = [];
  let challenged = true;
  const page = browserPage({
    $: async () => (challenged ? null : { id: "contentr" }),
    goto: async (url, options) => {
      navigations.push(options?.referer);
      return navigationResponse({ status: 200 });
    },
  });
  const fetcher = new BrowserPageFetcher(config, {
    puppeteerImpl: { launch: async () => launchedBrowser(page) },
  });

  await assert.rejects(
    fetcher.fetch("https://www.list.am/ru/category/56/1"),
    BrowserVerificationRequiredError,
  );
  challenged = false;
  await fetcher.fetch("https://www.list.am/ru/category/56/1");
  await fetcher.close();

  assert.deepEqual(navigations, [undefined, undefined]);
});

test("a Chrome that ignores SIGTERM is killed and reported", async () => {
  const events = [];
  const signals = [];
  const wedged = {
    exitCode: null,
    signalCode: null,
    kill: (signal) => {
      signals.push(signal);
      // Only SIGKILL ends it, which is what loses the unwritten cookie store.
      if (signal === "SIGKILL") wedged.exitCode = 137;
    },
  };

  await terminateChromeProcess(wedged, (event) => events.push(event), {
    termTimeoutMs: 60,
    killTimeoutMs: 60,
  });

  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(events, [
    {
      name: BROWSER_FORCED_EXIT_EVENT,
      severity: "warning",
      component: "browser",
      code: "ERR_BROWSER_FORCED_EXIT",
      gracefulTimeoutMs: 60,
      exited: true,
    },
  ]);
});

test("a Chrome that exits on SIGTERM is not reported as forced", async () => {
  const events = [];
  const child = {
    exitCode: null,
    signalCode: null,
    kill: () => {
      child.exitCode = 0;
    },
  };

  await terminateChromeProcess(child, (event) => events.push(event), {
    termTimeoutMs: 60,
    killTimeoutMs: 60,
  });

  assert.deepEqual(events, []);
});

test("interactive challenge completion returns the verified page", async (t) => {
  const config = await temporaryConfig(t, {
    browserHeadless: false,
    browserStartMinimized: false,
  });
  const statuses = [];
  let selectorWaited = false;
  const page = browserPage({
    $: async () => null,
    waitForSelector: async () => {
      selectorWaited = true;
    },
  });
  const fetcher = new BrowserPageFetcher(config, {
    onStatus: async (message) => statuses.push(message),
    platform: "linux",
    puppeteerImpl: {
      launch: async () => launchedBrowser(page),
    },
  });

  const response = await fetcher.fetch("https://www.list.am/");
  await fetcher.close();

  assert.equal(response.ok, true);
  assert.equal(selectorWaited, true);
  assert.match(statuses[0], /Complete it there once/u);
});

test("browser interaction pacing does not depend on throttled page timers", async (t) => {
  const config = await temporaryConfig(t, { browserHeadless: false });
  const evaluations = [];
  const page = browserPage({
    evaluate: async (callback) => {
      evaluations.push(callback.toString());
      return evaluations.length === 1 ? 640 : undefined;
    },
  });
  const fetcher = new BrowserPageFetcher(config, {
    platform: "linux",
    puppeteerImpl: {
      launch: async () => launchedBrowser(page),
    },
  });

  await fetcher.fetch("https://www.list.am/");
  await fetcher.close();

  assert.equal(evaluations.length, 4);
  assert.equal(
    evaluations.some((source) => source.includes("setTimeout")),
    false,
  );
  assert.equal(
    evaluations.some((source) => source.includes('"smooth"')),
    false,
  );
  assert.equal(
    evaluations.filter((source) => source.includes("scrollBy")).length,
    2,
  );
  assert.equal(
    evaluations.filter((source) => source.includes("scrollTo")).length,
    1,
  );
});

test("a stalled scroll simulation is abandoned without failing the fetch", async (t) => {
  const config = await temporaryConfig(t, {
    browserHeadless: false,
    browserProtocolTimeoutMs: 300,
  });
  const statuses = [];
  let resolveStalled;
  const stalled = new Promise((resolve) => {
    resolveStalled = resolve;
  });
  t.after(() => resolveStalled?.());
  const page = browserPage({
    // The first evaluation never settles, exactly as a stalled CDP call
    // behaves until the protocol timeout eventually rejects it.
    evaluate: async () => stalled,
    content: async () => '<div id="contentr">listing</div>',
  });
  const fetcher = new BrowserPageFetcher(config, {
    platform: "linux",
    onStatus: (message) => statuses.push(message),
    puppeteerImpl: { launch: async () => launchedBrowser(page) },
  });

  const started = Date.now();
  const response = await fetcher.fetch("https://www.list.am/");
  const elapsed = Date.now() - started;
  await fetcher.close();

  // The page still comes back, and the optional step gave up on a third of
  // the protocol budget rather than consuming all of it.
  assert.equal(await response.text(), '<div id="contentr">listing</div>');
  assert.equal(
    statuses.some((message) =>
      message.includes("Browser interaction skipped: interaction budget"),
    ),
    true,
  );
  assert.ok(
    elapsed < config.browserProtocolTimeoutMs,
    `expected the interaction to be abandoned early, took ${elapsed} ms`,
  );
});

test("a stalled page read fails the fetch early and disposes the browser", async (t) => {
  const config = await temporaryConfig(t, { browserProtocolTimeoutMs: 300 });
  let closes = 0;
  let resolveStalled;
  const stalled = new Promise((resolve) => {
    resolveStalled = resolve;
  });
  t.after(() => resolveStalled?.());
  const page = browserPage({
    // No scrolling to perform, so the optional step cannot absorb any of the
    // budget this test is measuring.
    evaluate: async () => 0,
    // The read never settles, exactly as a stalled renderer behaves until the
    // protocol timeout eventually rejects it.
    content: async () => stalled,
  });
  const fetcher = new BrowserPageFetcher(config, {
    platform: "linux",
    puppeteerImpl: {
      launch: async () => launchedBrowser(page, () => (closes += 1)),
    },
  });

  const started = Date.now();
  await assert.rejects(fetcher.fetch("https://www.list.am/"), (error) => {
    assert.ok(error instanceof BrowserContentTimeoutError);
    assert.equal(error.name, "BrowserContentTimeoutError");
    assert.equal(error.code, "ERR_BROWSER_CONTENT_TIMEOUT");
    return true;
  });
  const elapsed = Date.now() - started;
  await fetcher.close();

  // The stall is abandoned inside the protocol budget rather than consuming
  // it, and the unusable browser is gone so the retry starts from a fresh one.
  assert.ok(
    elapsed < config.browserProtocolTimeoutMs,
    `expected the page read to be abandoned early, took ${elapsed} ms`,
  );
  assert.equal(closes, 1);
});

test("a runtime failure is cleaned up and the next fetch launches a fresh browser", async (t) => {
  const config = await temporaryConfig(t);
  const launchOptions = [];
  const closeCounts = [0, 0];
  let launchCount = 0;
  const pages = [
    browserPage({
      goto: async () => {
        throw new Error("renderer crashed");
      },
    }),
    browserPage({
      content: async () => '<div id="contentr"><a href="/ru/item/1"></a></div>',
    }),
  ];
  const fetcher = new BrowserPageFetcher(config, {
    puppeteerImpl: {
      launch: async (options) => {
        const index = launchCount;
        launchCount += 1;
        launchOptions.push(options);
        return launchedBrowser(pages[index], () => {
          closeCounts[index] += 1;
        });
      },
    },
  });

  await assert.rejects(
    fetcher.fetch("https://www.list.am/ru/category/56/1"),
    /renderer crashed/u,
  );
  const response = await fetcher.fetch("https://www.list.am/ru/category/56/1");
  await fetcher.close();

  assert.equal(response.ok, true);
  assert.equal(launchCount, 2);
  assert.deepEqual(closeCounts, [1, 1]);
  for (const options of launchOptions) {
    await assertMissing(path.dirname(options.env.TMPDIR));
  }
});

test("the pages of one crawl share a browsing session", async (t) => {
  const config = await temporaryConfig(t);
  let launchCount = 0;
  let closeCount = 0;
  const fetcher = new BrowserPageFetcher(config, {
    puppeteerImpl: {
      launch: async () => {
        launchCount += 1;
        return launchedBrowser(browserPage(), () => {
          closeCount += 1;
        });
      },
    },
  });

  await fetcher.fetch("https://www.list.am/ru/category/56/1");
  await fetcher.fetch("https://www.list.am/ru/category/56/2");
  assert.equal(launchCount, 1, "a crawl's later pages continue the session");
  assert.equal(closeCount, 0);

  await fetcher.endSession();
  assert.equal(closeCount, 1, "the crawl boundary releases the browser");

  await fetcher.fetch("https://www.list.am/ru/category/56/1");
  await fetcher.close();

  assert.equal(launchCount, 2, "the next crawl starts a fresh browser");
  assert.equal(closeCount, 2);
});

test("headful interactive operation keeps its visible browser across sessions", async (t) => {
  const config = await temporaryConfig(t, {
    browserHeadless: false,
    browserStartMinimized: false,
  });
  let closeCount = 0;
  const fetcher = new BrowserPageFetcher(config, {
    puppeteerImpl: {
      launch: async () =>
        launchedBrowser(browserPage(), () => {
          closeCount += 1;
        }),
    },
  });

  await fetcher.fetch("https://www.list.am/ru/category/56/1");
  await fetcher.endSession();

  assert.equal(closeCount, 0);
  await fetcher.close();
  assert.equal(closeCount, 1);
});

test("cleanup terminates an owned Chrome process when protocol close fails", async (t) => {
  const config = await temporaryConfig(t);
  const closeError = new Error("protocol disconnected");
  const signals = [];
  let launchOptions;
  const child = {
    exitCode: null,
    signalCode: null,
    kill: (signal) => {
      signals.push(signal);
      child.exitCode = 0;
    },
  };
  const browser = {
    close: async () => {
      throw closeError;
    },
    connected: true,
    pages: async () => [browserPage()],
    version: async () => "Chrome/161.0.9001.4",
    process: () => child,
  };
  const fetcher = new BrowserPageFetcher(config, {
    puppeteerImpl: {
      launch: async (options) => {
        launchOptions = options;
        return browser;
      },
    },
  });

  await fetcher.start();
  await assert.rejects(fetcher.close(), closeError);

  assert.deepEqual(signals, ["SIGTERM"]);
  await assertMissing(path.dirname(launchOptions.env.TMPDIR));
});

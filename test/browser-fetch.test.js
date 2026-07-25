import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BROWSER_CHALLENGE_EVENT,
  BrowserPageFetcher,
  BrowserVerificationRequiredError,
  findChromeExecutable,
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
    url: () => "https://www.list.am/",
    ...overrides,
  };
}

function launchedBrowser(page, onClose = () => {}) {
  return {
    close: async () => onClose(),
    connected: true,
    pages: async () => [page],
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

test("headless launch normalizes only Chromium's headless user-agent token", async (t) => {
  const config = await temporaryConfig(t);
  const assignedUserAgents = [];
  const page = browserPage({
    evaluate: async () =>
      "Mozilla/5.0 Chrome-compatible HeadlessChrome/150.0.7871.181 Safari/537.36",
    setUserAgent: async (userAgent) => assignedUserAgents.push(userAgent),
  });
  const fetcher = new BrowserPageFetcher(config, {
    puppeteerImpl: {
      launch: async () => launchedBrowser(page),
    },
  });

  await fetcher.start();
  await fetcher.close();

  assert.deepEqual(assignedUserAgents, [
    "Mozilla/5.0 Chrome-compatible Chrome/150.0.7871.181 Safari/537.36",
  ]);
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
    },
  ]);
  assert.equal(closeCount, 1);
  await assertMissing(path.dirname(launchOptions.env.TMPDIR));
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
    evaluations.filter((source) => source.includes("scrollBy")).length,
    2,
  );
  assert.equal(
    evaluations.filter((source) => source.includes("scrollTo")).length,
    1,
  );
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

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { BrowserPageFetcher } from "../src/browser-fetch.js";

const readProjectFile = (file) =>
  readFile(new URL(`../${file}`, import.meta.url), "utf8");

test("container build context excludes local and development artifacts", async () => {
  const dockerIgnore = await readProjectFile(".dockerignore");
  const patterns = new Set(
    dockerIgnore
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#")),
  );

  for (const requiredPattern of [
    ".env",
    ".env.*",
    ".data/",
    "node_modules/",
    "coverage/",
    ".git/",
    "*.log",
    "logs/",
  ]) {
    assert.ok(
      patterns.has(requiredPattern),
      `${requiredPattern} must be excluded from the container build context`,
    );
  }
});

test("production container has a non-root immutable runtime with bounded writable mounts", async () => {
  const [dockerfile, deployment] = await Promise.all([
    readProjectFile("Dockerfile"),
    readProjectFile("compose.production.yaml"),
  ]);

  assert.match(dockerfile, /^USER node$/mu);
  assert.match(dockerfile, /chrome_sandbox[\s\S]*?chmod 4755/u);
  assert.doesNotMatch(dockerfile, /^COPY\s+\.\s/u);
  assert.doesNotMatch(dockerfile, /--env-file/u);
  assert.match(deployment, /^\s+user: "node"$/mu);
  assert.match(deployment, /^\s+read_only: true$/mu);
  assert.match(deployment, /^\s+- rental-apartments-data:\/app\/\.data$/mu);
  assert.match(
    deployment,
    /^\s+- \/tmp:size=134217728,mode=1777,nosuid,nodev,noexec$/mu,
  );
  assert.match(
    deployment,
    /^\s+- \/dev\/shm:size=268435456,mode=1777,nosuid,nodev,noexec$/mu,
  );
  assert.doesNotMatch(deployment, /^\s+ports:/mu);
  assert.match(deployment, /^\s+driver: fluentd$/mu);
  assert.match(deployment, /LOG_COLLECTOR_ADDRESS:\?/u);
});

test("production observability requires external retention and alert routing", async () => {
  const runbook = await readProjectFile("docs/observability.md");

  assert.match(runbook, /outside the application host/iu);
  assert.match(runbook, /minimum\s+14-day/iu);
  for (const alertName of [
    "process_restart_loop",
    "readiness_failure",
    "browser_challenge",
    "invalid_telegram_credentials",
    "invalid_telegram_channel_permissions",
    "five_consecutive_crawl_failures",
    "stale_exchange_rates",
    "backup_failure",
    "restore_test_failure",
    "low_disk",
  ]) {
    assert.match(runbook, new RegExp(`\\b${alertName}\\b`, "u"));
  }
});

test("production browser launch keeps the sandbox and restricts debugging to loopback", async () => {
  let launchOptions;
  const page = {
    close: async () => {},
    evaluateOnNewDocument: async () => {},
    isClosed: () => false,
    setDefaultNavigationTimeout: () => {},
    url: () => "about:blank",
  };
  const browser = {
    close: async () => {},
    connected: true,
    pages: async () => [page],
  };
  const fetcher = new BrowserPageFetcher(
    {
      browserHeadless: true,
      browserProfileDir: "/persistent/chrome-profile",
      browserProtocolTimeoutMs: 30_000,
      browserStartMinimized: true,
      chromeExecutablePath: process.execPath,
      timeoutMs: 30_000,
    },
    {
      puppeteerImpl: {
        launch: async (options) => {
          launchOptions = options;
          return browser;
        },
      },
    },
  );

  await fetcher.start();

  assert.equal(launchOptions.headless, true);
  assert.ok(
    launchOptions.args.includes("--remote-debugging-address=127.0.0.1"),
  );
  assert.ok(
    launchOptions.args.every((argument) => argument !== "--no-sandbox"),
    "Chrome's sandbox must not be disabled",
  );
});

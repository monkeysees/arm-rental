import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  assert.match(
    dockerfile,
    /chromium-sandbox[\s\S]*?\/usr\/lib\/chromium\/chrome-sandbox[\s\S]*?root:root:4755/u,
  );
  assert.doesNotMatch(dockerfile, /^COPY\s+\.\s/u);
  assert.doesNotMatch(dockerfile, /--env-file/u);
  assert.match(deployment, /^\s+user: "node"$/mu);
  assert.match(deployment, /^\s+cap_add:\n\s+- SYS_ADMIN$/mu);
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
  assert.match(deployment, /^\s+driver: journald$/mu);
  assert.match(deployment, /^\s+tag: rental-apartments\.production$/mu);
  assert.match(
    deployment,
    /^\s+labels: com\.rental-apartments\.environment$/mu,
  );
  assert.doesNotMatch(deployment, /fluentd|LOG_COLLECTOR_ADDRESS/iu);
});

test("production observability is local, bounded, and operator accessible", async () => {
  const runbook = await readProjectFile("docs/observability.md");

  assert.match(runbook, /Storage=persistent/u);
  assert.match(runbook, /SystemMaxUse=1G/u);
  assert.match(runbook, /MaxRetentionSec=14day/u);
  assert.match(runbook, /rentalctl logs --since 30m --follow/u);
  assert.match(runbook, /rentalctl metrics --since 24h --json/u);
  assert.doesNotMatch(runbook, /Fluentd|LOG_COLLECTOR_ADDRESS/iu);
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

test("removed deployment-environment paths cannot return unnoticed", async () => {
  const manifest = JSON.parse(await readProjectFile("package.json"));
  for (const command of ["staging:smoke", "staging:soak", "release:rehearse"]) {
    assert.equal(manifest.scripts[command], undefined);
  }

  for (const file of [
    "src/staging-guard.js",
    "src/staging-smoke-cli.js",
    "src/staging-smoke.js",
    "src/staging-soak-cli.js",
    "src/staging-soak-runtime.js",
    "src/staging-soak.js",
    "test/staging.test.js",
  ]) {
    await assert.rejects(readProjectFile(file), { code: "ENOENT" });
  }

  const docsDirectory = new URL("../docs/", import.meta.url);
  const operationalDocs = (await readdir(docsDirectory))
    .filter((file) => file.endsWith(".md") && file !== "architecture.md")
    .map((file) => `docs/${file}`);
  for (const file of ["README.md", ...operationalDocs]) {
    const document = await readProjectFile(file);
    assert.doesNotMatch(
      document,
      /\bstaging\b|\brehears(?:al|e|ed|ing)?\b|\b24-hour soak\b/iu,
      `${file} must describe the production-only deployment model`,
    );
  }
});

test("production browser launch keeps the sandbox and restricts debugging to loopback", async (t) => {
  const persistentDirectory = await mkdtemp(
    path.join(os.tmpdir(), "rental-deployment-isolation-"),
  );
  t.after(() => rm(persistentDirectory, { recursive: true, force: true }));
  let launchOptions;
  let assignedUserAgent;
  const page = {
    close: async () => {},
    evaluate: async () =>
      "Mozilla/5.0 HeadlessChrome/150.0.7871.181 Safari/537.36",
    evaluateOnNewDocument: async () => {},
    isClosed: () => false,
    setDefaultNavigationTimeout: () => {},
    setUserAgent: async (userAgent) => {
      assignedUserAgent = userAgent;
    },
    url: () => "about:blank",
  };
  const browser = {
    close: async () => {},
    connected: true,
    pages: async () => [page],
    version: async () => "Chrome/150.0.7871.181",
  };
  const fetcher = new BrowserPageFetcher(
    {
      browserHeadless: true,
      browserProfileDir: path.join(persistentDirectory, "chrome-profile"),
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
  assert.equal(launchOptions.pipe, true);
  assert.ok(
    launchOptions.args.every(
      (argument) => !argument.startsWith("--remote-debugging-"),
    ),
    "production leaves the remote-debugging pipe under Puppeteer control",
  );
  assert.ok(
    launchOptions.args.every((argument) => argument !== "--no-sandbox"),
    "Chrome's sandbox must not be disabled",
  );
  assert.equal(
    assignedUserAgent,
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/150.0.7871.181 Safari/537.36",
  );
});

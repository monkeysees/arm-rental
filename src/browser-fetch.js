import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import puppeteer from "puppeteer-core";

const executeFile = promisify(execFile);

const LOOPBACK_DEBUG_ADDRESS = "127.0.0.1";
const PROCESS_EXIT_TIMEOUT_MS = 2_000;
const DEFAULT_DISK_CACHE_MAX_BYTES = 64 * 1024 * 1024;
export const BROWSER_VERIFICATION_COMMAND = "npm run browser:verify";
export const BROWSER_CHALLENGE_EVENT = "browser.challenge";

export class BrowserVerificationRequiredError extends Error {
  constructor(
    message = `List.am requires security verification. Run ${BROWSER_VERIFICATION_COMMAND}.`,
  ) {
    super(message);
    this.name = "BrowserVerificationRequiredError";
    this.code = "ERR_BROWSER_VERIFICATION_REQUIRED";
    this.remediationCommand = BROWSER_VERIFICATION_COMMAND;
  }
}

const CHROME_PATHS = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
};

async function activeProfileProcessId(profileDirectory) {
  try {
    const lockTarget = await readlink(
      path.join(profileDirectory, "SingletonLock"),
    );
    const processId = Number(lockTarget.match(/-(\d+)$/u)?.[1]);
    if (!Number.isSafeInteger(processId) || processId <= 0) return undefined;

    try {
      process.kill(processId, 0);
      return processId;
    } catch (error) {
      return error.code === "EPERM" ? processId : undefined;
    }
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EINVAL") return undefined;
    throw error;
  }
}

function runtimeRoot(profileDirectory) {
  const profileHash = createHash("sha256")
    .update(path.resolve(profileDirectory))
    .digest("hex")
    .slice(0, 16);
  return path.join(os.tmpdir(), `rental-apartments-browser-${profileHash}`);
}

async function createRuntimeDirectory(profileDirectory) {
  const root = runtimeRoot(profileDirectory);

  // The application singleton makes this root exclusive to one profile user.
  // Clearing it before launch also removes resources left by a browser crash or
  // supervisor restart.
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const directory = await mkdtemp(path.join(root, "launch-"));
  await chmod(directory, 0o700);
  return { directory, root };
}

function childIsRunning(child) {
  return child && child.exitCode === null && child.signalCode === null;
}

async function waitForChildExit(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (childIsRunning(child) && Date.now() < deadline) {
    await delay(25);
  }
  return !childIsRunning(child);
}

async function terminateChromeProcess(child) {
  if (!childIsRunning(child) || typeof child.kill !== "function") return;

  child.kill("SIGTERM");
  if (await waitForChildExit(child, PROCESS_EXIT_TIMEOUT_MS)) return;

  child.kill("SIGKILL");
  await waitForChildExit(child, PROCESS_EXIT_TIMEOUT_MS);
}

export async function findChromeExecutable(
  configuredPath,
  platform = process.platform,
) {
  const candidates = configuredPath
    ? [configuredPath]
    : CHROME_PATHS[platform] || [];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue through the small list of known installation paths.
    }
  }

  throw new Error(
    "Chrome was not found. Set CHROME_EXECUTABLE_PATH to the Chrome executable.",
  );
}

async function launchHiddenMacChrome(
  puppeteerImpl,
  executablePath,
  config,
  chromeArgs,
  signal,
  executeFileImpl,
) {
  await mkdir(config.browserProfileDir, { recursive: true, mode: 0o700 });
  const browserURL = `http://127.0.0.1:${config.browserDebugPort}`;
  const connect = async () => {
    try {
      return await puppeteerImpl.connect({
        browserURL,
        protocolTimeout: config.browserProtocolTimeoutMs,
      });
    } catch {
      return undefined;
    }
  };
  const existingBrowser = await connect();
  if (existingBrowser) return existingBrowser;

  const profileProcessId = await activeProfileProcessId(
    config.browserProfileDir,
  );
  if (profileProcessId) {
    throw new Error(
      `Chrome profile is in use by process ${profileProcessId}, but remote control is unavailable. Close that Chrome process before retrying.`,
    );
  }

  const bundleIdentifier = executablePath.includes("Chromium.app")
    ? "org.chromium.Chromium"
    : "com.google.Chrome";
  const defaultArgs = await puppeteerImpl.defaultArgs({
    headless: false,
    userDataDir: config.browserProfileDir,
    args: chromeArgs,
  });
  const args = defaultArgs.filter(
    (argument) =>
      argument !== "about:blank" &&
      argument !== "--enable-automation" &&
      !argument.startsWith("--remote-debugging-"),
  );

  await executeFileImpl("open", [
    "-g",
    "-j",
    "-F",
    "-n",
    "-b",
    bundleIdentifier,
    "--args",
    ...args,
    `--remote-debugging-port=${config.browserDebugPort}`,
    `--remote-debugging-address=${LOOPBACK_DEBUG_ADDRESS}`,
  ]);

  const deadline = Date.now() + config.timeoutMs;
  while (Date.now() < deadline && !signal?.aborted) {
    const browser = await connect();
    if (browser) return browser;
    await delay(100, undefined, { signal }).catch((error) => {
      if (error.name !== "AbortError") throw error;
    });
  }

  if (signal?.aborted) throw signal.reason;
  throw new Error(
    `Could not connect to background Chrome on port ${config.browserDebugPort}.`,
  );
}

async function simulateUserActions(page) {
  await page.evaluate(async () => {
    const wait = (milliseconds) =>
      new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
      });
    const maximumScroll = Math.min(
      Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
      1_600,
    );

    for (let scrolled = 0; scrolled < maximumScroll; scrolled += 320) {
      window.scrollBy({ top: 320, behavior: "smooth" });
      await wait(150);
    }
    if (maximumScroll > 0) window.scrollTo({ top: 0, behavior: "instant" });
  });
}

export class BrowserPageFetcher {
  constructor(
    config,
    {
      puppeteerImpl = puppeteer,
      signal,
      onStatus = () => {},
      onEvent = () => {},
      platform = process.platform,
      executeFileImpl = executeFile,
    } = {},
  ) {
    this.config = config;
    this.puppeteer = puppeteerImpl;
    this.signal = signal;
    this.onStatus = onStatus;
    this.onEvent = onEvent;
    this.platform = platform;
    this.executeFile = executeFileImpl;
    this.browser = undefined;
    this.browserProcess = undefined;
    this.page = undefined;
    this.runtimeDirectory = undefined;
    this.runtimeRoot = undefined;
    this.cleanupPromise = undefined;
  }

  async start() {
    if (this.browser?.connected && this.page && !this.page.isClosed()) return;

    await this.dispose({ suppressCloseError: true });
    const executablePath = await findChromeExecutable(
      this.config.chromeExecutablePath,
    );
    const runtime = await createRuntimeDirectory(this.config.browserProfileDir);
    this.runtimeDirectory = runtime.directory;
    this.runtimeRoot = runtime.root;
    const headfulLinux =
      this.platform === "linux" && !this.config.browserHeadless;
    const args = [
      `--disk-cache-size=${this.config.browserCacheMaxBytes || DEFAULT_DISK_CACHE_MAX_BYTES}`,
      "--disable-blink-features=AutomationControlled",
      "--disable-backgrounding-occluded-windows",
      // Chrome for Testing's crash reporter trips its CFI guard in the
      // sandboxed headful Linux container. Application-owned structured logs
      // still report browser exits without starting that unstable subprocess.
      "--disable-breakpad",
      "--disable-crash-reporter",
      "--disable-renderer-backgrounding",
      "--lang=ru-RU",
      "--no-default-browser-check",
      "--no-first-run",
      ...(headfulLinux
        ? [
            "--disable-crashpad-for-testing",
            `--remote-debugging-address=${LOOPBACK_DEBUG_ADDRESS}`,
          ]
        : []),
      ...(this.config.browserStartMinimized === false
        ? []
        : ["--start-minimized"]),
      "--window-size=1365,900",
    ];
    const hiddenMacChrome =
      this.platform === "darwin" &&
      !this.config.browserHeadless &&
      this.config.browserStartMinimized !== false;

    try {
      this.browser = hiddenMacChrome
        ? await launchHiddenMacChrome(
            this.puppeteer,
            executablePath,
            this.config,
            args,
            this.signal,
            this.executeFile,
          )
        : await this.puppeteer.launch({
            executablePath,
            headless: this.config.browserHeadless,
            dumpio: this.config.browserDumpIo === true,
            pipe: !headfulLinux,
            userDataDir: this.config.browserProfileDir,
            defaultViewport: null,
            ignoreDefaultArgs: ["--enable-automation"],
            args,
            env: {
              ...process.env,
              // XDG caches otherwise target the read-only image home. Keep
              // them in the launch-scoped tmpfs.
              HOME: runtime.directory,
              TMPDIR: runtime.directory,
              XDG_CACHE_HOME: path.join(runtime.directory, "cache"),
              XDG_CONFIG_HOME: path.join(runtime.directory, "config"),
              XDG_RUNTIME_DIR: runtime.directory,
            },
            protocolTimeout: this.config.browserProtocolTimeoutMs,
            signal: this.signal,
          });
      this.browserProcess = this.browser.process?.();

      const pages = await this.browser.pages();
      this.page =
        pages.find((page) => page.url() !== "about:blank") ||
        pages[0] ||
        (await this.browser.newPage());
      for (const page of pages) {
        if (page !== this.page && page.url() === "about:blank") {
          await page.close();
        }
      }

      this.page.setDefaultNavigationTimeout(this.config.timeoutMs);
      await this.page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, "webdriver", {
          configurable: true,
          get: () => undefined,
        });
      });
    } catch (error) {
      await this.dispose({ suppressCloseError: true });
      throw error;
    }
  }

  async fetch(url) {
    try {
      await this.start();
      await this.page.goto(url, { waitUntil: "domcontentloaded" });

      if (!(await this.page.$("#contentr"))) {
        const verificationMessage = this.config.browserHeadless
          ? "List.am requires security verification. Run npm run browser:verify."
          : "List.am security verification is open in Chrome. Complete it there once.";
        const challenge = new BrowserVerificationRequiredError(
          verificationMessage,
        );
        await this.onStatus(verificationMessage);
        await this.onEvent({
          name: BROWSER_CHALLENGE_EVENT,
          severity: "warning",
          component: "browser",
          code: challenge.code,
          remediationCommand: challenge.remediationCommand,
        });

        if (this.config.browserHeadless) throw challenge;

        try {
          await this.page.waitForSelector("#contentr", {
            timeout: this.config.browserChallengeTimeoutMs,
            signal: this.signal,
          });
        } catch (error) {
          if (this.signal?.aborted) throw error;
          throw new BrowserVerificationRequiredError(
            "List.am security verification was not completed in the Chrome window.",
          );
        }
      }

      try {
        await simulateUserActions(this.page);
      } catch (error) {
        await this.onStatus(`Browser interaction skipped: ${error.message}`);
      }

      return new Response(await this.page.content(), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    } catch (error) {
      await this.dispose({ suppressCloseError: true });
      throw error;
    }
  }

  async dispose({ suppressCloseError = false } = {}) {
    if (this.cleanupPromise) return this.cleanupPromise;

    const browser = this.browser;
    const browserProcess = this.browserProcess;
    const temporaryRoot = this.runtimeRoot;
    this.browser = undefined;
    this.browserProcess = undefined;
    this.page = undefined;
    this.runtimeDirectory = undefined;
    this.runtimeRoot = undefined;

    this.cleanupPromise = (async () => {
      let closeError;
      try {
        await browser?.close();
      } catch (error) {
        closeError = error;
      }
      await terminateChromeProcess(browserProcess);
      if (temporaryRoot) {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
      if (closeError && !suppressCloseError) throw closeError;
    })();

    try {
      await this.cleanupPromise;
    } finally {
      this.cleanupPromise = undefined;
    }
  }

  async close() {
    await this.dispose();
  }
}

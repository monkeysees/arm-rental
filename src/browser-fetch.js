import { execFile } from "node:child_process";
import { access, mkdir, readlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import puppeteer from "puppeteer-core";

const executeFile = promisify(execFile);

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
) {
  await mkdir(config.browserProfileDir, { recursive: true });
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

  await executeFile("open", [
    "-g",
    "-j",
    "-F",
    "-n",
    "-b",
    bundleIdentifier,
    "--args",
    ...args,
    `--remote-debugging-port=${config.browserDebugPort}`,
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
    { puppeteerImpl = puppeteer, signal, onStatus = () => {} } = {},
  ) {
    this.config = config;
    this.puppeteer = puppeteerImpl;
    this.signal = signal;
    this.onStatus = onStatus;
    this.browser = undefined;
    this.page = undefined;
  }

  async start() {
    if (this.browser?.connected && this.page && !this.page.isClosed()) return;

    const executablePath = await findChromeExecutable(
      this.config.chromeExecutablePath,
    );
    const args = [
      "--disable-blink-features=AutomationControlled",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--lang=ru-RU",
      "--no-default-browser-check",
      "--no-first-run",
      ...(this.config.browserStartMinimized === false
        ? []
        : ["--start-minimized"]),
      "--window-size=1365,900",
    ];
    const hiddenMacChrome =
      process.platform === "darwin" &&
      !this.config.browserHeadless &&
      this.config.browserStartMinimized !== false;

    this.browser = hiddenMacChrome
      ? await launchHiddenMacChrome(
          this.puppeteer,
          executablePath,
          this.config,
          args,
          this.signal,
        )
      : await this.puppeteer.launch({
          executablePath,
          headless: this.config.browserHeadless,
          userDataDir: this.config.browserProfileDir,
          defaultViewport: null,
          ignoreDefaultArgs: ["--enable-automation"],
          args,
          protocolTimeout: this.config.browserProtocolTimeoutMs,
          signal: this.signal,
        });

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
  }

  async fetch(url) {
    await this.start();
    await this.page.goto(url, { waitUntil: "domcontentloaded" });

    if (!(await this.page.$("#contentr"))) {
      const verificationMessage = this.config.browserHeadless
        ? "List.am requires security verification. Run npm run browser:verify."
        : "List.am security verification is open in Chrome. Complete it there once.";
      await this.onStatus(verificationMessage);

      if (this.config.browserHeadless) {
        throw new Error(verificationMessage);
      }

      try {
        await this.page.waitForSelector("#contentr", {
          timeout: this.config.browserChallengeTimeoutMs,
          signal: this.signal,
        });
      } catch (error) {
        if (this.signal?.aborted) throw error;
        throw new Error(
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
  }

  async close() {
    if (this.browser?.connected) await this.browser.close();
  }
}

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  rm,
  unlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import puppeteer from "puppeteer-core";

const executeFile = promisify(execFile);

const LOOPBACK_DEBUG_ADDRESS = "127.0.0.1";
// Chrome flushes its cookie store on a clean exit, and the crawl's List.am
// clearance lives there. Killing the process mid-flush discards a cookie that
// was just minted, so the next launch is challenged again and mints another —
// a loop the operator sees as a challenge every few minutes. The graceful
// window is therefore generous relative to the milliseconds a 20 KB cookie
// database needs; only a browser that is genuinely wedged reaches SIGKILL.
const PROCESS_TERM_TIMEOUT_MS = 10_000;
const PROCESS_KILL_TIMEOUT_MS = 2_000;
const DEFAULT_DISK_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const CHROME_SINGLETON_NAMES = [
  "SingletonLock",
  "SingletonCookie",
  "SingletonSocket",
];
export const BROWSER_VERIFICATION_COMMAND = "npm run browser:verify";
export const BROWSER_CHALLENGE_EVENT = "browser.challenge";
export const BROWSER_FORCED_EXIT_EVENT = "browser.forced_exit";

// List.am answers a challenge through its edge provider rather than from the
// application, so the interstitial arrives as a status the page never shows.
// Reading it names the challenge outright instead of inferring one from a
// missing selector, which a slow render or an origin error produces too.
const CHALLENGE_HTTP_STATUSES = new Set([403, 429, 503]);
const CLOUDFLARE_CHALLENGE_HEADERS = ["cf-mitigated", "cf-chl-bypass"];

// Reading the page HTML is the one CDP call a fetch cannot do without, and a
// stalled renderer makes it hang rather than fail. Naming that stall lets the
// caller retry against a fresh browser instead of waiting out the protocol
// timeout, which is a dead wait: the renderer never recovers in place.
export class BrowserContentTimeoutError extends Error {
  constructor(budgetMs) {
    super(`Reading the page HTML exceeded its ${budgetMs} ms budget.`);
    this.name = "BrowserContentTimeoutError";
    this.code = "ERR_BROWSER_CONTENT_TIMEOUT";
    this.budgetMs = budgetMs;
  }
}

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

async function removeStaleProfileSingletons(profileDirectory) {
  const processId = await activeProfileProcessId(profileDirectory);
  if (processId) {
    throw new Error(
      `Chrome profile is in use by process ${processId}. Close that Chrome process before retrying.`,
    );
  }

  for (const name of CHROME_SINGLETON_NAMES) {
    const singletonPath = path.join(profileDirectory, name);
    let metadata;
    try {
      metadata = await lstat(singletonPath);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!metadata.isSymbolicLink()) {
      throw new Error(
        `Chrome profile singleton ${name} is not a symbolic link; refusing to remove it.`,
      );
    }
    await unlink(singletonPath);
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

/**
 * Ends Chrome's own process after Puppeteer has already asked it to close.
 *
 * Reaching SIGKILL means the browser never finished its own shutdown, so
 * whatever it had not yet written — the cookie store included — is lost. That
 * is worth reporting rather than absorbing: a run of forced exits explains a
 * run of challenges, and nothing else in the logs would connect the two.
 *
 * The waits are arguments so the forced path can be exercised without spending
 * the graceful window; production always passes the module's own timeouts.
 */
export async function terminateChromeProcess(
  child,
  onEvent = () => {},
  {
    termTimeoutMs = PROCESS_TERM_TIMEOUT_MS,
    killTimeoutMs = PROCESS_KILL_TIMEOUT_MS,
  } = {},
) {
  if (!childIsRunning(child) || typeof child.kill !== "function") return;

  child.kill("SIGTERM");
  if (await waitForChildExit(child, termTimeoutMs)) return;

  child.kill("SIGKILL");
  const exited = await waitForChildExit(child, killTimeoutMs);
  await onEvent({
    name: BROWSER_FORCED_EXIT_EVENT,
    severity: "warning",
    component: "browser",
    code: "ERR_BROWSER_FORCED_EXIT",
    gracefulTimeoutMs: termTimeoutMs,
    exited,
  });
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

// The scroll simulation is optional: a caller catches its failure and the
// fetch still returns the page. It must not be able to spend the whole
// protocol timeout before being abandoned, because the page.content() call
// that actually produces the result holds its own budget, and both together
// have to fit the deployment candidate observation window. On a host where a
// CDP call can stall past the protocol timeout, an unbounded optional step
// turns one stall into a failed crawl.
const INTERACTION_BUDGET_MS = 10_000;

// At most a third of the protocol budget, so a stalled optional step always
// leaves the essential page.content() call the larger share of it.
function interactionBudgetMs({ browserProtocolTimeoutMs }) {
  return Math.max(
    1,
    Math.min(INTERACTION_BUDGET_MS, Math.floor(browserProtocolTimeoutMs / 3)),
  );
}

// A healthy page read returns in a couple of seconds; a stalled one never
// returns at all. Production timings are bimodal with nothing in between, so
// this budget is generous against the healthy case while still cutting the
// dead wait an order of magnitude below the protocol timeout.
const CONTENT_BUDGET_MS = 20_000;

// Twice the optional step's share and still inside the protocol timeout, so a
// stalled renderer trips this budget rather than the CDP backstop. Keeping the
// backstop strictly larger is what makes the failure retryable in time to
// matter.
function contentBudgetMs({ browserProtocolTimeoutMs }) {
  return Math.max(
    1,
    Math.min(CONTENT_BUDGET_MS, Math.floor((browserProtocolTimeoutMs * 2) / 3)),
  );
}

// Production shows the renderer stalling in two places, so both bounded waits
// share one guard: the optional scroll simulation, whose failure the caller
// swallows, and the page read, whose failure has to reach the retry.
const interactionBudgetExhausted = () =>
  new Error("interaction budget exhausted");

async function withinBudget(
  operation,
  remainingMs,
  createError = interactionBudgetExhausted,
) {
  if (remainingMs <= 0) throw createError();
  const pending = operation();
  // Only the wait is bounded; an abandoned evaluation keeps running in the
  // page until the browser is disposed. Observe it so giving up on the wait
  // cannot surface as an unhandled rejection.
  pending.catch(() => {});
  let timer;
  try {
    return await Promise.race([
      pending,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(createError()), remainingMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function simulateUserActions(page, budgetMs = INTERACTION_BUDGET_MS) {
  // The budget covers time spent waiting on the page, not the pacing between
  // scrolls, which is deliberate and already bounded.
  let waited = 0;
  const bounded = async (operation) => {
    const started = Date.now();
    try {
      return await withinBudget(operation, budgetMs - waited);
    } finally {
      waited += Date.now() - started;
    }
  };

  const maximumScroll = await bounded(() =>
    page.evaluate(() =>
      Math.min(
        Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
        1_600,
      ),
    ),
  );

  for (let scrolled = 0; scrolled < maximumScroll; scrolled += 320) {
    await bounded(() =>
      page.evaluate(() => {
        window.scrollBy({ top: 320, behavior: "instant" });
      }),
    );
    // Browser-page timers can be throttled heavily in headless mode. Keep the
    // pacing delay in Node so this optional interaction remains bounded.
    await delay(150);
  }
  if (maximumScroll > 0) {
    await bounded(() =>
      page.evaluate(() => {
        window.scrollTo({ top: 0, behavior: "instant" });
      }),
    );
  }
}

// Chrome's reduced user agent freezes everything except the product token, so
// the platform strings below are the complete set a desktop Chrome reports.
const USER_AGENT_PLATFORMS = {
  darwin: {
    hint: "macOS",
    token: "Macintosh; Intel Mac OS X 10_15_7",
    architecture: "arm",
  },
  win32: {
    hint: "Windows",
    token: "Windows NT 10.0; Win64; x64",
    architecture: "x86",
  },
  linux: {
    hint: "Linux",
    token: "X11; Linux x86_64",
    architecture: "x86",
  },
};

function userAgentPlatform(platform) {
  return USER_AGENT_PLATFORMS[platform] || USER_AGENT_PLATFORMS.linux;
}

// Keep client hints and the user agent on the same installed browser version.
function userAgentMetadata(version, platform) {
  const major = version.split(".")[0];
  const brands = [
    // Chromium's own GREASE entry varies between builds and is defined to be
    // ignored, so a fixed placeholder keeps the header stable without
    // claiming a brand the browser does not have.
    { brand: "Not:A-Brand", version: "24" },
    { brand: "Chromium", version: major },
  ];
  return {
    brands,
    fullVersionList: brands.map((brand) => ({
      ...brand,
      version: brand.brand === "Chromium" ? version : "24.0.0.0",
    })),
    fullVersion: version,
    platform: userAgentPlatform(platform).hint,
    platformVersion: "",
    architecture: userAgentPlatform(platform).architecture,
    bitness: "64",
    model: "",
    mobile: false,
  };
}

// Desktop Chrome reduces the UA version; full build details belong in hints.
async function applyUserAgent(page, version, platform) {
  const { token } = userAgentPlatform(platform);
  const major = version.split(".")[0];
  await page.setUserAgent(
    `Mozilla/5.0 (${token}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
      `Chrome/${major}.0.0.0 Safari/537.36`,
    userAgentMetadata(version, platform),
  );
}

/**
 * Reads what a navigation actually returned, tolerating its absence.
 *
 * Puppeteer legitimately resolves `goto` to null — a same-document navigation
 * returns no response — so every field here is optional and the caller must
 * still be able to judge the page without one.
 */
function navigationOutcome(response) {
  if (!response || typeof response.status !== "function") return {};
  const headers =
    typeof response.headers === "function" ? response.headers() || {} : {};
  return {
    httpStatus: response.status(),
    statusText:
      typeof response.statusText === "function" ? response.statusText() : "",
    // A challenge marker is proof; its absence proves nothing, because the
    // edge does not label every mitigation it serves.
    edgeChallenge: CLOUDFLARE_CHALLENGE_HEADERS.some((header) =>
      Object.hasOwn(headers, header),
    ),
    // A status the origin itself failed with, rather than one the edge uses to
    // withhold the page. Treating these as challenges sent an operator to the
    // verification runbook for what was a 404 or a bad gateway.
    originFailure:
      response.status() >= 400 &&
      !CHALLENGE_HTTP_STATUSES.has(response.status()),
  };
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
    this.lastNavigatedUrl = undefined;
  }

  async start() {
    if (this.browser?.connected && this.page && !this.page.isClosed()) return;

    await this.dispose({ suppressCloseError: true });
    await mkdir(this.config.browserProfileDir, {
      recursive: true,
      mode: 0o700,
    });
    await removeStaleProfileSingletons(this.config.browserProfileDir);
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
      // Nothing downstream reads an image element or its source: the crawl
      // wants the HTML. Suppressing the fetch and decode through Blink costs
      // nothing at runtime, unlike aborting each request over CDP, which
      // would add round trips to the event loop a stall already starves.
      // Image elements and their attributes stay in the document, so the
      // HTML page.content() returns is unchanged.
      ...(this.config.browserLoadImages
        ? []
        : ["--blink-settings=imagesEnabled=false"]),
      "--disable-backgrounding-occluded-windows",
      // Browser-owned crash reporters require mutable or tracing facilities
      // outside the container contract. Application logs still report exits.
      "--disable-breakpad",
      "--disable-crash-reporter",
      "--disable-renderer-backgrounding",
      "--lang=ru-RU",
      "--no-default-browser-check",
      "--no-first-run",
      ...(headfulLinux
        ? [
            `--remote-debugging-address=${LOOPBACK_DEBUG_ADDRESS}`,
            "--remote-debugging-port=0",
          ]
        : []),
      ...(!this.config.browserHeadless &&
      this.config.browserStartMinimized !== false
        ? ["--start-minimized"]
        : []),
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
              // Chrome also uses SQLite; keep its scratch files off the
              // application's dedicated SQLite mount.
              SQLITE_TMPDIR: runtime.directory,
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
      const browserVersion = await this.browser.version();
      const version = browserVersion.match(
        /^(?:HeadlessChrome|Chrome|Chromium)\/(\d+(?:\.\d+){3})$/u,
      )?.[1];
      if (!version) {
        throw new Error(
          "Installed browser did not report a full Chromium version",
        );
      }
      await applyUserAgent(this.page, version, this.platform);
    } catch (error) {
      await this.dispose({ suppressCloseError: true });
      throw error;
    }
  }

  async fetch(url) {
    try {
      await this.start();
      // Pages reached by clicking carry where they were clicked from. The
      // crawl's later pages are its own earlier ones, which is only true now
      // that a session outlives a single page.
      const response = await this.page.goto(url, {
        waitUntil: "domcontentloaded",
        ...(this.lastNavigatedUrl ? { referer: this.lastNavigatedUrl } : {}),
      });
      const { httpStatus, statusText, edgeChallenge, originFailure } =
        navigationOutcome(response);
      const contentPresent = Boolean(await this.page.$("#contentr"));
      // The edge labelling a mitigation settles it. Otherwise a page that
      // never rendered the listing container is still treated as challenged,
      // which is what this has always done and catches an interstitial served
      // as 200. A status alone does not decide: List.am returns 403 for
      // reasons that are not a challenge, and those deserve their own error.
      const challenged = edgeChallenge || (!contentPresent && !originFailure);

      if (challenged) {
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
          // Which page was challenged, and whether the edge said so or the
          // missing container inferred it. Without the first there is no way
          // to tell one category from the other; without the second there is
          // no way to separate a real interstitial from a page that failed to
          // render for some other reason.
          url,
          ...(httpStatus === undefined ? {} : { httpStatus }),
          challengeSource: edgeChallenge ? "edge" : "missing_content",
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

      // An origin failure is reported as itself. The page is not worth
      // scrolling or reading, and the caller already turns a non-2xx into a
      // crawl failure that names the status.
      if (originFailure) {
        return new Response("", {
          status: httpStatus,
          statusText: statusText || "",
        });
      }

      try {
        await simulateUserActions(this.page, interactionBudgetMs(this.config));
      } catch (error) {
        await this.onStatus(`Browser interaction skipped: ${error.message}`);
      }

      // Unlike the scroll simulation, giving up here has to fail the fetch:
      // there is no page to return. The caller disposes this browser and
      // retries against a fresh one, which is what actually recovers the page.
      const contentBudget = contentBudgetMs(this.config);
      const html = await withinBudget(
        () => this.page.content(),
        contentBudget,
        () => new BrowserContentTimeoutError(contentBudget),
      );
      // A successful page keeps the browser. Tearing it down here made every
      // page load a brand-new session with no navigation history behind it,
      // which is the shape List.am challenges: the profile carried the
      // verification cookie but nothing else. Renderer and compositor state
      // is still kept from accumulating indefinitely, one crawl at a time,
      // by the session boundary the caller closes in `endSession`.
      //
      // Only a page that actually delivered its listing becomes the referer
      // for the next one: a challenge or an origin error is not somewhere a
      // reader would have been coming from.
      this.lastNavigatedUrl = url;
      return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    } catch (error) {
      await this.dispose({ suppressCloseError: true });
      throw error;
    }
  }

  /**
   * Ends the run of pages that belong together — one crawl, or the startup
   * preflight — and releases the browser that served them. Headless callers
   * get a fresh Chrome for the next run against the same durable profile, so
   * renderer and compositor work cannot accumulate across the poll interval.
   * Headful interactive operation keeps its visible browser, as it always has.
   */
  async endSession() {
    if (!this.config.browserHeadless) return;
    await this.dispose();
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
    // The next session opens with no history behind it, so it must not claim
    // to have come from a page the previous browser read.
    this.lastNavigatedUrl = undefined;

    this.cleanupPromise = (async () => {
      let closeError;
      try {
        await browser?.close();
      } catch (error) {
        closeError = error;
      }
      await terminateChromeProcess(browserProcess, this.onEvent);
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

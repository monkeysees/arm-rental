import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { retryAfterMilliseconds } from "./retry.js";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const PROFILE = "safari2601";

export class ListAmTransportError extends Error {
  constructor(message) {
    super(message);
    this.name = "ListAmTransportError";
    this.code = "ERR_LIST_AM_TRANSPORT";
  }
}

export class ListAmChallengeError extends Error {
  constructor(httpStatus, challengeSource) {
    super("List.am requested security verification");
    this.name = "ListAmChallengeError";
    this.code = "ERR_LIST_AM_CHALLENGE";
    this.httpStatus = httpStatus;
    this.challengeSource = challengeSource;
  }
}

function sourceUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ListAmTransportError("Invalid List.am URL");
  }
  if (url.origin !== "https://www.list.am" || url.username || url.password) {
    throw new ListAmTransportError(
      "List.am requests require the configured HTTPS origin",
    );
  }
  return url;
}

function parseResponse(output) {
  let offset = 0;
  let status;
  let headers;
  do {
    const end = output.indexOf("\r\n\r\n", offset);
    if (end < 0 || end - offset > 64 * 1024) {
      throw new ListAmTransportError("Invalid List.am response headers");
    }
    const [line, ...fields] = output
      .subarray(offset, end)
      .toString("utf8")
      .split("\r\n");
    const match = /^HTTP\/[\d.]+ (\d{3})(?: |$)/u.exec(line);
    if (!match)
      throw new ListAmTransportError("Invalid List.am response status");
    status = Number(match[1]);
    headers = new Headers();
    try {
      for (const field of fields) {
        const colon = field.indexOf(":");
        if (colon < 1) throw new Error();
        headers.append(field.slice(0, colon), field.slice(colon + 1).trim());
      }
    } catch {
      throw new ListAmTransportError("Invalid List.am response headers");
    }
    offset = end + 4;
    // HTTPS proxies can prepend CONNECT success; informational headers precede the final response.
    if (
      status >= 200 &&
      !/^HTTP\/[\d.]+ 200 Connection established$/iu.test(line)
    )
      break;
  } while (offset < output.length);
  if (status < 200 || status > 599) {
    throw new ListAmTransportError("Invalid List.am response status");
  }
  return { status, headers, body: output.subarray(offset) };
}

async function privateCookieFile(filename, { create = false } = {}) {
  const handle = await open(
    filename,
    constants.O_RDWR | constants.O_NOFOLLOW | (create ? constants.O_CREAT : 0),
    0o600,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.()) {
      throw new ListAmTransportError(
        "List.am cookie jar must be a private regular file",
      );
    }
    await handle.chmod(0o600);
    if (stat.size > MAX_RESPONSE_BYTES)
      throw new ListAmTransportError("List.am cookie jar exceeds size limit");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export class ListAmHttpFetcher {
  constructor(config, { signal, onEvent = () => {}, sleep = delay } = {}) {
    this.config = config;
    this.onEvent = onEvent;
    this.sleep = sleep;
    this.nextRequestAt = 0;
    this.controller = new AbortController();
    this.signal = signal
      ? AbortSignal.any([signal, this.controller.signal])
      : this.controller.signal;
    this.starting = null;
    this.active = null;
  }

  start() {
    this.signal.throwIfAborted();
    this.starting ??= this.initialize();
    return this.starting;
  }

  async initialize() {
    const { curlImpersonatePath, listAmCookieFile } = this.config;
    if (
      !path.isAbsolute(curlImpersonatePath || "") ||
      !path.isAbsolute(listAmCookieFile || "")
    ) {
      throw new ListAmTransportError(
        "List.am executable and cookie jar paths must be absolute",
      );
    }
    try {
      const directory = path.dirname(listAmCookieFile);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if ((await realpath(directory)) !== directory) throw new Error();
      await privateCookieFile(listAmCookieFile, { create: true });
    } catch {
      throw new ListAmTransportError(
        "Cannot initialize the private List.am cookie jar",
      );
    }
    const version = await this.run(["--disable", "--version"]);
    if (!/^curl \S+-IMPERSONATE\b/mu.test(version.toString("utf8"))) {
      throw new ListAmTransportError(
        "List.am requires curl-impersonate, not ordinary curl",
      );
    }
  }

  run(args, timeoutMs = this.config.timeoutMs) {
    this.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.curlImpersonatePath, args, {
        stdio: ["ignore", "pipe", "ignore"],
      });
      const chunks = [];
      let bytes = 0;
      let failure;
      const stop = (error) => {
        failure ??= error;
        child.kill("SIGKILL");
      };
      const abort = () =>
        stop(new DOMException("List.am request aborted", "AbortError"));
      const timer = setTimeout(
        () => stop(new ListAmTransportError("List.am request timed out")),
        timeoutMs,
      );
      this.signal.addEventListener("abort", abort, { once: true });
      if (this.signal.aborted) abort();
      child.on("error", () => {
        failure ??= new ListAmTransportError(
          "Could not start curl-impersonate",
        );
      });
      child.stdout.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES)
          stop(new ListAmTransportError("List.am response exceeds size limit"));
        else chunks.push(chunk);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        this.signal.removeEventListener("abort", abort);
        if (failure) reject(failure);
        else if (code !== 0)
          reject(
            new ListAmTransportError(
              `curl-impersonate exited unsuccessfully (${code})`,
            ),
          );
        else resolve(Buffer.concat(chunks));
      });
    });
  }

  async fetch(value) {
    if (this.active)
      throw new ListAmTransportError(
        "Concurrent List.am requests are not supported",
      );
    const url = sourceUrl(value);
    this.active = this.fetchPage(url);
    try {
      return await this.active;
    } finally {
      this.nextRequestAt = performance.now() + 2000;
      this.active = null;
    }
  }

  async fetchPage(url) {
    await this.start();
    const waitMs = this.nextRequestAt - performance.now();
    if (waitMs > 0)
      await this.sleep(waitMs, undefined, { signal: this.signal });
    const { listAmCookieFile, timeoutMs } = this.config;
    const deadline = Date.now() + timeoutMs;
    const directory = await mkdtemp(
      path.join(path.dirname(listAmCookieFile), ".list-am-http-"),
    );
    const cookieFile = path.join(directory, "cookies");
    try {
      const cookies = await privateCookieFile(listAmCookieFile);
      const temporary = await open(cookieFile, "wx", 0o600);
      try {
        await temporary.writeFile(cookies);
      } finally {
        await temporary.close();
      }
      for (let redirects = 0; ; redirects += 1) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0)
          throw new ListAmTransportError("List.am request timed out");
        const output = await this.run(
          [
            "--disable",
            "--impersonate",
            PROFILE,
            // Category navigation without this referrer can receive an edge challenge.
            "--referer",
            "https://www.list.am/ru/",
            "--compressed",
            "--silent",
            "--proto",
            "=https",
            "--max-time",
            String(remainingMs / 1000),
            "--cookie",
            cookieFile,
            "--cookie-jar",
            cookieFile,
            "--include",
            "--output",
            "-",
            "--url",
            url.href,
          ],
          remainingMs,
        );
        const { status, headers, body } = parseResponse(output);
        const html = body.toString("utf8");
        const challengeSource =
          headers.get("cf-mitigated")?.toLowerCase() === "challenge"
            ? "edge"
            : /(?:\/cdn-cgi\/challenge-platform\/|\b_cf_chl_opt\b)/iu.test(
                  html,
                ) &&
                /(?:Just a moment|Verify you are human|Checking your browser|Enable JavaScript and cookies)/iu.test(
                  html,
                )
              ? "interstitial"
              : null;
        if (challengeSource) {
          const error = new ListAmChallengeError(status, challengeSource);
          error.retryAfterMs = retryAfterMilliseconds(
            headers.get("retry-after"),
          );
          await this.onEvent({
            name: "list_am.challenge",
            severity: "warning",
            component: "list_am",
            code: error.code,
            httpStatus: status,
            challengeSource,
          });
          throw error;
        }
        if (
          [301, 302, 303, 307, 308].includes(status) &&
          headers.has("location")
        ) {
          if (redirects >= MAX_REDIRECTS)
            throw new ListAmTransportError("List.am redirect limit exceeded");
          try {
            url = sourceUrl(new URL(headers.get("location"), url));
          } catch {
            throw new ListAmTransportError(
              "List.am redirected outside the permitted HTTPS origin",
            );
          }
          continue;
        }
        await privateCookieFile(cookieFile);
        const destination = await lstat(listAmCookieFile);
        if (!destination.isFile() || destination.nlink !== 1)
          throw new ListAmTransportError(
            "List.am cookie jar changed unexpectedly",
          );
        await rename(cookieFile, listAmCookieFile);
        // curl has already decompressed the body; these wire headers no longer describe it.
        headers.delete("content-encoding");
        headers.delete("content-length");
        return new Response([204, 205, 304].includes(status) ? null : body, {
          status,
          headers,
        });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async close() {
    this.controller.abort();
    await Promise.allSettled([this.active, this.starting]);
  }
}

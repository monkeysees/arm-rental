import { createServer } from "node:http";

const TEN_MINUTES_MS = 10 * 60 * 1_000;
const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1_000;
const SOURCE_INTEGRITY_ERROR = "ERR_LIST_AM_SOURCE_INTEGRITY";
// Alert only after consecutive challenged crawls; readiness changes at once.
const SOURCE_CHALLENGE_ALERT_CRAWLS = 5;
const COMPONENT_NAMES = [
  "configuration",
  "storage",
  "telegram",
  "list_am",
  "cba",
];

function timestamp(now) {
  return now().toISOString();
}

function component(status = "unknown", updatedAt = null, code) {
  return {
    status,
    updatedAt,
    ...(code ? { code } : {}),
  };
}

function safeCode(code, fallback) {
  return /^[A-Z][A-Z0-9_]{1,80}$/u.test(code || "") ? code : fallback;
}

function preflightComponent(name) {
  if (name === "source_transport") return "list_am";
  if (name === "exchange_rates") return "cba";
  if (name === "channel") return "telegram";
  if (["state", "singleton"].includes(name)) return "storage";
  return COMPONENT_NAMES.includes(name) ? name : "configuration";
}

export function classifyRuntimeFailure(error, context = {}) {
  const explicitComponents = {
    telegram: "telegram",
    "telegram-channel": "telegram",
    cba: "cba",
    storage: "storage",
    configuration: "configuration",
    list_am: "list_am",
  };
  if (
    error?.code === "ERR_LIST_AM_CHALLENGE" ||
    error?.name === "ListAmChallengeError"
  ) {
    return "list_am_challenge";
  }
  if (
    error?.code === "ERR_TELEGRAM_API" ||
    error?.name === "TelegramApiError"
  ) {
    return "telegram";
  }
  if (error?.code === "ERR_PREFLIGHT_EXCHANGE_RATES") {
    return "cba";
  }
  if (
    [
      "EACCES",
      "EDQUOT",
      "EIO",
      "ENOSPC",
      "EROFS",
      "ERR_STATE_INVALID_JSON",
    ].includes(error?.code)
  ) {
    return "storage";
  }
  if (explicitComponents[context.component]) {
    return explicitComponents[context.component];
  }
  return "list_am";
}

export class HealthMonitor {
  constructor({
    version,
    now = () => new Date(),
    crawlStaleMs = TEN_MINUTES_MS,
    exchangeRateStaleMs = FORTY_EIGHT_HOURS_MS,
    sourceChallengeAlertCrawls = SOURCE_CHALLENGE_ALERT_CRAWLS,
    onAlert = () => {},
  }) {
    this.version = version;
    this.now = now;
    this.crawlStaleMs = crawlStaleMs;
    this.exchangeRateStaleMs = exchangeRateStaleMs;
    this.sourceChallengeAlertCrawls = sourceChallengeAlertCrawls;
    this.onAlert = onAlert;
    this.activeAlerts = new Set();
    this.startedAt = timestamp(now);
    this.preflight = {
      status: "pending",
      completedAt: null,
    };
    this.monitoring = {
      active: false,
      channelConfigured: false,
      requiredSince: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      consecutiveFailures: 0,
    };
    this.exchangeRates = {
      required: false,
      fetchedAt: null,
    };
    this.sourceChallenge = {
      // A challenge was seen by the crawl currently in flight.
      duringCrawl: false,
      // Crawls in a row that ended without clearing the challenge.
      consecutiveCrawls: 0,
    };
    this.privateAccess = {
      accessMode: "public",
      persistedUserCount: 0,
      authorizedUserCount: 0,
      suspendedUserCount: 0,
      activeUserCount: 0,
    };
    this.components = Object.fromEntries(
      COMPONENT_NAMES.map((name) => [name, component()]),
    );
  }

  setConfigurationValid() {
    this.#setComponent("configuration", "ok");
  }

  setConfigurationFailure(code = "ERR_CONFIGURATION") {
    this.#setComponent(
      "configuration",
      "failed",
      safeCode(code, "ERR_CONFIGURATION"),
    );
    this.preflight = {
      status: "failed",
      completedAt: timestamp(this.now),
    };
    this.#setAlert("readiness_failure", true, {
      reason: "PREFLIGHT_FAILED",
    });
  }

  setPreflight(result) {
    const updatedAt = timestamp(this.now);
    this.preflight = {
      status: result?.ready ? "ready" : result?.status || "failed",
      completedAt: updatedAt,
    };

    for (const [name, status] of Object.entries(result?.checks || {})) {
      if (status === "not_run") continue;
      const target = preflightComponent(name);
      const healthStatus =
        status === "passed"
          ? "ok"
          : status === "skipped"
            ? "skipped"
            : status === "source_challenge"
              ? "challenge"
              : "failed";
      if (
        healthStatus === "skipped" &&
        this.components[target].status !== "unknown"
      ) {
        continue;
      }
      this.components[target] = component(healthStatus, updatedAt);
    }

    if (result?.failure) {
      const target = preflightComponent(result.failure.component);
      const status =
        result.status === "source_challenge" ? "challenge" : "failed";
      this.components[target] = component(
        status,
        updatedAt,
        safeCode(result.failure.code, "ERR_PREFLIGHT"),
      );
      if (result.failure.code === "ERR_TELEGRAM_CREDENTIALS") {
        this.#setAlert("invalid_telegram_credentials", true);
      }
      if (result.failure.code === "ERR_TELEGRAM_CHANNEL_PERMISSIONS") {
        this.#setAlert("invalid_telegram_channel_permissions", true);
      }
      if (result.status === "source_challenge") {
        // Crawling is gated by startup preflight, so alert immediately;
        // a successful preflight retry clears the challenge.
        this.sourceChallenge = {
          duringCrawl: false,
          consecutiveCrawls: this.sourceChallengeAlertCrawls,
        };
        this.#setAlert("list_am_challenge", true, {
          reason: "LIST_AM_CHALLENGE",
        });
      }
      if (result.failure.code === SOURCE_INTEGRITY_ERROR) {
        this.#setAlert("list_am_source_integrity", true, {
          reason: "LIST_AM_SOURCE_INTEGRITY",
        });
      }
    } else if (result?.ready) {
      this.#setAlert("list_am_source_integrity", false, {
        reason: "LIST_AM_SOURCE_INTEGRITY",
      });
    }
  }

  setMonitoringState({ active, channelConfigured }) {
    const wasRequired = this.#monitoringRequired();
    this.monitoring.active = Boolean(active);
    this.monitoring.channelConfigured = Boolean(channelConfigured);
    const isRequired = this.#monitoringRequired();
    this.exchangeRates.required = isRequired;
    if (!wasRequired && isRequired) {
      this.monitoring.requiredSince = timestamp(this.now);
    } else if (!isRequired) {
      this.monitoring.requiredSince = null;
      this.monitoring.lastSuccessAt = null;
      this.monitoring.lastFailureAt = null;
      this.monitoring.consecutiveFailures = 0;
    }
  }

  setPrivateAccessState(state) {
    const accessMode = ["public", "owner", "allowlist"].includes(
      state?.accessMode,
    )
      ? state.accessMode
      : "public";
    const count = (value) =>
      Number.isSafeInteger(value) && value >= 0 ? value : 0;
    this.privateAccess = {
      accessMode,
      persistedUserCount: count(state?.persistedUserCount),
      authorizedUserCount: count(state?.authorizedUserCount),
      suspendedUserCount: count(state?.suspendedUserCount),
      activeUserCount: count(state?.activeUserCount),
    };
  }

  recordCrawlSuccess(at = this.now()) {
    const completedAt = at.toISOString();
    this.monitoring.lastSuccessAt = completedAt;
    this.monitoring.consecutiveFailures = 0;
    this.#setComponent("list_am", "ok", undefined, completedAt);
    this.sourceChallenge = { duringCrawl: false, consecutiveCrawls: 0 };
    this.#setAlert("list_am_challenge", false, {
      reason: "LIST_AM_CHALLENGE",
    });
    this.#setAlert("five_consecutive_crawl_failures", false);
    this.#setAlert("list_am_source_integrity", false, {
      reason: "LIST_AM_SOURCE_INTEGRITY",
    });
  }

  recordCrawlFailure(kind, code = "ERR_CRAWL") {
    const failedAt = timestamp(this.now);
    this.monitoring.lastFailureAt = failedAt;
    this.monitoring.consecutiveFailures += 1;
    if (this.monitoring.consecutiveFailures >= 5) {
      this.#setAlert("five_consecutive_crawl_failures", true, {
        consecutiveFailures: this.monitoring.consecutiveFailures,
      });
    }
    if (kind === "list_am_challenge") {
      this.recordSourceChallenge(failedAt);
    } else {
      this.#setComponent(
        COMPONENT_NAMES.includes(kind) ? kind : "list_am",
        "failed",
        safeCode(code, "ERR_CRAWL"),
        failedAt,
      );
      if (code === SOURCE_INTEGRITY_ERROR) {
        this.#setAlert("list_am_source_integrity", true, {
          reason: "LIST_AM_SOURCE_INTEGRITY",
        });
      }
    }
    this.#settleSourceChallenge();
  }

  recordSourceIntegritySuccess(at = this.now()) {
    const completedAt = at.toISOString();
    this.#setComponent("list_am", "ok", undefined, completedAt);
    this.sourceChallenge = { duringCrawl: false, consecutiveCrawls: 0 };
    this.#setAlert("list_am_challenge", false, {
      reason: "LIST_AM_CHALLENGE",
    });
    this.#setAlert("list_am_source_integrity", false, {
      reason: "LIST_AM_SOURCE_INTEGRITY",
    });
  }

  // Readiness changes immediately; the alert counts completed failed crawls.
  recordSourceChallenge(at = timestamp(this.now)) {
    this.#setComponent("list_am", "challenge", "ERR_LIST_AM_CHALLENGE", at);
    this.sourceChallenge.duringCrawl = true;
  }

  recordComponentSuccess(name) {
    if (COMPONENT_NAMES.includes(name)) this.#setComponent(name, "ok");
    if (name === "telegram") {
      this.#setAlert("invalid_telegram_credentials", false);
      this.#setAlert("invalid_telegram_channel_permissions", false);
    }
  }

  recordComponentFailure(name, code, { warning = false } = {}) {
    if (!COMPONENT_NAMES.includes(name)) return;
    this.#setComponent(
      name,
      warning ? "warning" : "failed",
      safeCode(code, `ERR_${name.toUpperCase()}`),
    );
    if (code === "ERR_TELEGRAM_CREDENTIALS") {
      this.#setAlert("invalid_telegram_credentials", true);
    }
    if (
      ["ERR_TELEGRAM_CHANNEL_PERMISSIONS", "ERR_TELEGRAM_CHANNEL"].includes(
        code,
      )
    ) {
      this.#setAlert("invalid_telegram_channel_permissions", true);
    }
  }

  recordExchangeRateSnapshot(snapshot) {
    const fetchedAt = Number.isNaN(Date.parse(snapshot?.fetchedAt))
      ? null
      : snapshot.fetchedAt;
    this.exchangeRates.fetchedAt = fetchedAt;
    this.#setComponent(
      "cba",
      fetchedAt ? "ok" : "failed",
      fetchedAt ? undefined : "ERR_EXCHANGE_RATES_UNAVAILABLE",
    );
  }

  recordExchangeRateFailure(snapshot) {
    if (snapshot?.fetchedAt && !Number.isNaN(Date.parse(snapshot.fetchedAt))) {
      this.exchangeRates.fetchedAt = snapshot.fetchedAt;
      this.recordComponentFailure("cba", "ERR_CBA_REFRESH", {
        warning: true,
      });
    } else {
      this.exchangeRates.fetchedAt = null;
      this.recordComponentFailure("cba", "ERR_EXCHANGE_RATES_UNAVAILABLE");
    }
  }

  liveness() {
    return {
      status: "live",
      timestamp: timestamp(this.now),
      startedAt: this.startedAt,
      version: this.version,
    };
  }

  readiness() {
    const checkedAt = this.now();
    const checkedAtIso = checkedAt.toISOString();
    const reasons = [];
    const warnings = [];
    const components = structuredClone(this.components);

    if (this.preflight.status !== "ready") {
      reasons.push(
        this.preflight.status === "pending"
          ? "PREFLIGHT_INCOMPLETE"
          : "PREFLIGHT_FAILED",
      );
    }

    if (components.list_am.status === "challenge") {
      reasons.push("LIST_AM_CHALLENGE");
    }

    if (components.list_am.code === SOURCE_INTEGRITY_ERROR) {
      reasons.push("LIST_AM_SOURCE_INTEGRITY");
    }

    const monitoringRequired = this.#monitoringRequired();
    if (monitoringRequired) {
      if (!this.monitoring.lastSuccessAt) {
        reasons.push("CRAWL_NEVER_SUCCEEDED");
      } else if (
        checkedAt.getTime() - Date.parse(this.monitoring.lastSuccessAt) >=
        this.crawlStaleMs
      ) {
        reasons.push("CRAWL_STALE");
      }
      if (this.monitoring.consecutiveFailures >= 5) {
        reasons.push("CRAWL_FAILURE_THRESHOLD");
      }

      if (!this.exchangeRates.fetchedAt) {
        reasons.push("EXCHANGE_RATES_UNAVAILABLE");
        components.cba = component(
          "failed",
          components.cba.updatedAt,
          "ERR_EXCHANGE_RATES_UNAVAILABLE",
        );
      }
    }

    if (this.exchangeRates.fetchedAt) {
      const ageMs =
        checkedAt.getTime() - Date.parse(this.exchangeRates.fetchedAt);
      if (ageMs > this.exchangeRateStaleMs) {
        warnings.push("EXCHANGE_RATES_STALE");
        components.cba = component(
          "warning",
          components.cba.updatedAt,
          "WARN_EXCHANGE_RATES_STALE",
        );
      }
    }

    const uniqueReasons = [...new Set(reasons)];
    const alertReasons = uniqueReasons.filter(
      (reason) =>
        reason !== "LIST_AM_CHALLENGE" ||
        this.preflight.status !== "ready" ||
        this.sourceChallenge.consecutiveCrawls >=
          this.sourceChallengeAlertCrawls,
    );
    if (this.preflight.status !== "pending") {
      // A readiness probe must not turn a retryable challenge into an alert
      // before the dedicated challenge threshold. Other failures still alert.
      this.#setAlert("readiness_failure", alertReasons.length > 0, {
        reasons: alertReasons,
      });
    }
    this.#setAlert(
      "stale_exchange_rates",
      warnings.includes("EXCHANGE_RATES_STALE"),
      {
        fetchedAt: this.exchangeRates.fetchedAt,
      },
    );
    return {
      status: uniqueReasons.length === 0 ? "ready" : "not_ready",
      ready: uniqueReasons.length === 0,
      timestamp: checkedAtIso,
      startedAt: this.startedAt,
      version: this.version,
      preflight: { ...this.preflight },
      monitoring: {
        required: monitoringRequired,
        active: this.monitoring.active,
        channelConfigured: this.monitoring.channelConfigured,
        requiredSince: this.monitoring.requiredSince,
        lastSuccessAt: this.monitoring.lastSuccessAt,
        lastFailureAt: this.monitoring.lastFailureAt,
        consecutiveFailures: this.monitoring.consecutiveFailures,
      },
      exchangeRates: {
        required: this.exchangeRates.required,
        fetchedAt: this.exchangeRates.fetchedAt,
      },
      privateAccess: { ...this.privateAccess },
      components,
      reasons: uniqueReasons,
      alertReasons,
      warnings,
    };
  }

  #settleSourceChallenge() {
    if (!this.sourceChallenge.duringCrawl) return;
    this.sourceChallenge.duringCrawl = false;
    this.sourceChallenge.consecutiveCrawls += 1;
    if (
      this.sourceChallenge.consecutiveCrawls < this.sourceChallengeAlertCrawls
    ) {
      return;
    }
    this.#setAlert("list_am_challenge", true, {
      reason: "LIST_AM_CHALLENGE",
      consecutiveCrawls: this.sourceChallenge.consecutiveCrawls,
    });
  }

  #monitoringRequired() {
    return this.monitoring.active || this.monitoring.channelConfigured;
  }

  #setComponent(name, status, code, updatedAt = timestamp(this.now)) {
    this.components[name] = component(status, updatedAt, code);
  }

  #setAlert(name, firing, details = {}) {
    const wasFiring = this.activeAlerts.has(name);
    if (firing === wasFiring) return;
    if (firing) this.activeAlerts.add(name);
    else this.activeAlerts.delete(name);
    this.onAlert({
      name,
      status: firing ? "firing" : "resolved",
      ...details,
    });
  }
}

function sendJson(response, statusCode, body) {
  const payload = `${JSON.stringify(body)}\n`;
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(payload);
}

export async function startHealthServer(
  monitor,
  { host = "127.0.0.1", port = 8_787 } = {},
) {
  const server = createServer((request, response) => {
    if (request.method !== "GET") {
      sendJson(response, 405, { status: "method_not_allowed" });
      return;
    }
    if (request.url === "/live") {
      sendJson(response, 200, monitor.liveness());
      return;
    }
    if (request.url === "/ready" || request.url === "/health") {
      const readiness = monitor.readiness();
      sendJson(response, readiness.ready ? 200 : 503, readiness);
      return;
    }
    sendJson(response, 404, { status: "not_found" });
  });

  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    address: server.address(),
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

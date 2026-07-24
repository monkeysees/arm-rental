import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  STAGING_MARKER_FILENAME,
  STAGING_MARKER_TYPE,
  validateStagingGuard,
} from "../src/staging-guard.js";
import { runStagingSmoke } from "../src/staging-smoke.js";
import {
  MINIMUM_SOAK_DURATION_MS,
  runSoakMonitor,
  runStagingSoak,
  soakSettings,
} from "../src/staging-soak.js";

const REGULAR_ADS_HTML = `
  <div id="contentr">
    <a class="fav-item-info-container" href="/ru/item/200">
      <div class="dltitle"><div class="pt">Apartment</div></div>
      <div class="p">220000 ֏</div>
      <div class="at">Кентрон, 2 ком., 50 кв.м., 3/5 этаж</div>
    </a>
  </div>`;

const stagingEnvironment = {
  ALLOW_STAGING_TESTS: "true",
  BROWSER_HEADLESS: "true",
  CHROME_EXECUTABLE_PATH: "/opt/chrome",
  DATA_DIRECTORY: "/srv/rental-apartments-staging",
  DEPLOYMENT_ENVIRONMENT: "staging",
  NODE_ENV: "production",
  STAGING_TELEGRAM_BOT_ID: "700",
  STAGING_TELEGRAM_CHANNEL_ID: "-100123456789",
  TELEGRAM_BOT_TOKEN: "fake-staging-token",
  TELEGRAM_OWNER_ID: "42",
};

function marker() {
  return {
    type: STAGING_MARKER_TYPE,
    version: 1,
    environment: "staging",
    botId: 700,
    channelId: -100123456789,
  };
}

function markerDetails(mode = 0o100600) {
  return {
    mode,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
}

test("staging guard requires an explicit marker bound to dedicated private Telegram resources", async () => {
  const checked = await validateStagingGuard(stagingEnvironment, {
    inspectPath: async (filename) => {
      assert.equal(
        filename,
        path.join(stagingEnvironment.DATA_DIRECTORY, STAGING_MARKER_FILENAME),
      );
      return markerDetails();
    },
    loadState: async () => marker(),
  });
  assert.deepEqual(checked, {
    botId: 700,
    channelId: -100123456789,
    dataDirectory: stagingEnvironment.DATA_DIRECTORY,
    markerFilename: path.join(
      stagingEnvironment.DATA_DIRECTORY,
      STAGING_MARKER_FILENAME,
    ),
  });

  await assert.rejects(
    validateStagingGuard(
      { ...stagingEnvironment, DEPLOYMENT_ENVIRONMENT: "production" },
      {
        inspectPath: async () => markerDetails(),
        loadState: async () => marker(),
      },
    ),
    /must be exactly staging/u,
  );
  await assert.rejects(
    validateStagingGuard(
      { ...stagingEnvironment, TELEGRAM_CHANNEL_ID: "@production_rentals" },
      {
        inspectPath: async () => markerDetails(),
        loadState: async () => marker(),
      },
    ),
    /TELEGRAM_CHANNEL_ID must be unset/u,
  );
  await assert.rejects(
    validateStagingGuard(stagingEnvironment, {
      inspectPath: async () => markerDetails(0o100644),
      loadState: async () => marker(),
    }),
    /mode 0600/u,
  );
  await assert.rejects(
    validateStagingGuard(stagingEnvironment, {
      inspectPath: async () => markerDetails(),
      loadState: async () => ({ ...marker(), botId: 701 }),
    }),
    /does not match/u,
  );

  const invalidEnvironments = [
    [{ ...stagingEnvironment, ALLOW_STAGING_TESTS: "false" }, /ALLOW/u],
    [{ ...stagingEnvironment, NODE_ENV: "test" }, /NODE_ENV/u],
    [{ ...stagingEnvironment, DATA_DIRECTORY: "relative" }, /absolute/u],
    [
      { ...stagingEnvironment, STAGING_TELEGRAM_BOT_ID: "invalid" },
      /positive/u,
    ],
    [
      { ...stagingEnvironment, STAGING_TELEGRAM_CHANNEL_ID: "@public" },
      /numeric private-channel/u,
    ],
    [
      {
        ...stagingEnvironment,
        STAGING_TELEGRAM_CHANNEL_ID: "-10012345678901234567890",
      },
      /safe range/u,
    ],
  ];
  for (const [environment, expected] of invalidEnvironments) {
    await assert.rejects(
      validateStagingGuard(environment, {
        inspectPath: async () => markerDetails(),
        loadState: async () => marker(),
      }),
      expected,
    );
  }
  await assert.rejects(
    validateStagingGuard(stagingEnvironment, {
      inspectPath: async () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
    }),
    /marker is missing/u,
  );
  await assert.rejects(
    validateStagingGuard(stagingEnvironment, {
      inspectPath: async () => ({
        ...markerDetails(),
        isFile: () => false,
      }),
    }),
    /regular file/u,
  );
});

test("staging smoke reconstructs clients and verifies external and persistence boundaries", async () => {
  const data = new Map();
  const events = [];
  const listUrlTemplate =
    "https://www.list.am/ru/category/56/{page}?n=0&cmtype=0";
  const config = {
    browserProfileDir: path.join(
      stagingEnvironment.DATA_DIRECTORY,
      "chrome-profile",
    ),
    dataDirectory: stagingEnvironment.DATA_DIRECTORY,
    exchangeRatesStateFile: path.join(
      stagingEnvironment.DATA_DIRECTORY,
      "exchange-rates.json",
    ),
    listUrlTemplate,
  };
  const snapshot = {
    type: "cba-exchange-rates",
    version: 1,
    baseCurrency: "AMD",
    fetchedAt: "2026-07-25T08:00:00.000Z",
    effectiveDate: "2026-07-25",
    rates: {
      USD: { amount: 1, rate: 382 },
      EUR: { amount: 1, rate: 448 },
      RUB: { amount: 1, rate: 4.8 },
    },
  };
  let pass = 0;

  const result = await runStagingSmoke(stagingEnvironment, {
    guard: async () => ({
      botId: 700,
      channelId: -100123456789,
      dataDirectory: stagingEnvironment.DATA_DIRECTORY,
    }),
    configFactory: () => config,
    validateConfig: async () => events.push("config"),
    acquireLock: async () => {
      pass += 1;
      events.push(`lock:${pass}`);
      return {
        release: async () => events.push(`release:${pass}`),
      };
    },
    apiFactory: () => ({
      getMe: async () => ({ id: 700, is_bot: true }),
      getChat: async () => ({
        id: -100123456789,
        type: "channel",
        title: "Rental staging",
      }),
      getChatMember: async () => ({
        status: "administrator",
        can_post_messages: true,
        can_edit_messages: true,
      }),
    }),
    browserFactory: () => ({
      fetch: async () => new Response(REGULAR_ADS_HTML),
      close: async () => events.push(`browser:close:${pass}`),
    }),
    exchangeRateServiceFactory: (_config, { forceRefresh }) => {
      events.push(`rates:${forceRefresh ? "fresh" : "persisted"}`);
      return { getSnapshot: async () => snapshot };
    },
    loadState: async (filename) => data.get(filename),
    saveState: async (filename, value) => data.set(filename, value),
    recordVerification: async (browserConfig, regularAdsCount) => {
      data.set(
        path.join(
          browserConfig.browserProfileDir,
          ".rental-apartments-verification.json",
        ),
        {
          type: "list-am-browser-verification",
          version: 1,
          urlTemplate: listUrlTemplate,
          verifiedAt: "2026-07-25T08:00:00.000Z",
          regularAdsCount,
        },
      );
    },
    now: () => new Date("2026-07-25T08:00:00.000Z"),
  });

  assert.equal(result.status, "passed");
  assert.deepEqual(result.checks, {
    dedicatedEnvironment: "passed",
    telegramAuthentication: "passed",
    privateChannelPermissions: "passed",
    cbaRetrieval: "passed",
    realListAmParse: "passed",
    persistenceAcrossRestart: "passed",
    gracefulShutdown: "passed",
  });
  assert.deepEqual(events, [
    "config",
    "lock:1",
    "rates:fresh",
    "browser:close:1",
    "release:1",
    "lock:2",
    "rates:persisted",
    "browser:close:2",
    "release:2",
  ]);
});

test("staging smoke releases its lease when private-channel validation fails", async () => {
  const events = [];
  await assert.rejects(
    runStagingSmoke(stagingEnvironment, {
      guard: async () => ({
        botId: 700,
        channelId: -100123456789,
        dataDirectory: stagingEnvironment.DATA_DIRECTORY,
      }),
      configFactory: () => ({
        browserProfileDir: path.join(
          stagingEnvironment.DATA_DIRECTORY,
          "chrome-profile",
        ),
        dataDirectory: stagingEnvironment.DATA_DIRECTORY,
      }),
      validateConfig: async () => {},
      acquireLock: async () => ({
        release: async () => events.push("release"),
      }),
      apiFactory: () => ({
        getMe: async () => ({ id: 700, is_bot: true }),
        getChat: async () => ({
          id: -100123456789,
          type: "channel",
          username: "public_channel",
        }),
      }),
    }),
    /expected private channel/u,
  );
  assert.deepEqual(events, ["release"]);
});

test("soak settings enforce 24 hours and the monitor emits bounded machine-readable results", async () => {
  const config = {
    browserCacheMaxBytes: 64 * 1024 * 1024,
    browserProfileDir: "/staging/profile",
    dataDirectory: "/staging",
    healthHost: "127.0.0.1",
    healthPort: 8787,
  };
  assert.throws(
    () =>
      soakSettings(
        { STAGING_SOAK_DURATION_MS: String(MINIMUM_SOAK_DURATION_MS - 1) },
        config,
      ),
    /at least 86400000/u,
  );
  assert.equal(soakSettings({}, config).durationMs, MINIMUM_SOAK_DURATION_MS);

  let milliseconds = 0;
  let sampleIndex = 0;
  const resources = [
    {
      rssBytes: 100,
      chromeProcessCount: 2,
      profileBytes: 1_000,
      cacheBytes: 500,
      logBytes: 100,
    },
    {
      rssBytes: 120,
      chromeProcessCount: 2,
      profileBytes: 1_010,
      cacheBytes: 505,
      logBytes: 110,
    },
    {
      rssBytes: 130,
      chromeProcessCount: 2,
      profileBytes: 1_020,
      cacheBytes: 510,
      logBytes: 120,
    },
  ];
  const settings = {
    durationMs: 20,
    sampleIntervalMs: 10,
    gracefulShutdownTimeoutMs: 100,
    thresholds: {
      memoryGrowthBytes: 50,
      chromeProcessCount: 3,
      profileGrowthBytes: 50,
      cacheGrowthBytes: 50,
      logGrowthBytes: 50,
    },
  };
  const report = await runSoakMonitor(settings, {
    launch: async () => ({
      pid: 123,
      isRunning: () => true,
      terminate: async () => ({ code: 0, signal: null, forced: false }),
    }),
    ready: async () => {},
    sample: async () => resources[sampleIndex++],
    sleep: async (duration) => {
      milliseconds += duration;
    },
    now: () => new Date(milliseconds),
  });

  assert.equal(report.status, "passed");
  assert.equal(report.summary.sampleCount, 3);
  assert.equal(report.summary.maximumMemoryGrowthBytes, 30);
  assert.equal(report.summary.maximumChromeProcessCount, 2);
  assert.equal(report.summary.gracefulShutdown, true);
  assert.deepEqual(report.violations, []);
});

test("soak monitor fails on resource growth and forced shutdown", async () => {
  let milliseconds = 0;
  let sampleIndex = 0;
  const report = await runSoakMonitor(
    {
      durationMs: 10,
      sampleIntervalMs: 10,
      gracefulShutdownTimeoutMs: 100,
      thresholds: {
        memoryGrowthBytes: 10,
        chromeProcessCount: 1,
        profileGrowthBytes: 10,
        cacheGrowthBytes: 10,
        logGrowthBytes: 10,
      },
    },
    {
      launch: async () => ({
        pid: 123,
        isRunning: () => true,
        terminate: async () => ({
          code: null,
          signal: "SIGKILL",
          forced: true,
        }),
      }),
      ready: async () => {},
      sample: async () => {
        sampleIndex += 1;
        return sampleIndex === 1
          ? {
              rssBytes: 10,
              chromeProcessCount: 1,
              profileBytes: 10,
              cacheBytes: 10,
              logBytes: 10,
            }
          : {
              rssBytes: 30,
              chromeProcessCount: 2,
              profileBytes: 30,
              cacheBytes: 30,
              logBytes: 30,
            };
      },
      sleep: async (duration) => {
        milliseconds += duration;
      },
      now: () => new Date(milliseconds),
    },
  );

  assert.equal(report.status, "failed");
  assert.deepEqual(report.violations, [
    "memory_growth",
    "profile_growth",
    "cache_growth",
    "log_growth",
    "chrome_process_count",
    "graceful_shutdown",
  ]);
});

test("staging soak orchestration binds the guarded directory to the monitored service", async () => {
  let milliseconds = 0;
  const config = {
    browserCacheMaxBytes: 64 * 1024 * 1024,
    browserProfileDir: path.join(
      stagingEnvironment.DATA_DIRECTORY,
      "chrome-profile",
    ),
    dataDirectory: stagingEnvironment.DATA_DIRECTORY,
    healthHost: "127.0.0.1",
    healthPort: 8787,
  };
  const env = {
    ...stagingEnvironment,
    STAGING_SOAK_SAMPLE_INTERVAL_MS: String(MINIMUM_SOAK_DURATION_MS),
  };
  const lifecycle = [];
  const { report, resultFilename } = await runStagingSoak(env, {
    guard: async () => ({
      dataDirectory: stagingEnvironment.DATA_DIRECTORY,
    }),
    configFactory: () => config,
    validateConfig: async () => lifecycle.push("validate"),
    launch: async (_runtimeConfig, _runtimeEnv, settings) => {
      assert.equal(settings.durationMs, MINIMUM_SOAK_DURATION_MS);
      lifecycle.push("launch");
      return {
        pid: 555,
        isRunning: () => true,
        terminate: async () => {
          lifecycle.push("terminate");
          return { code: 0, signal: null, forced: false };
        },
      };
    },
    ready: async () => lifecycle.push("ready"),
    sample: async () => ({
      rssBytes: 100,
      chromeProcessCount: 1,
      profileBytes: 100,
      cacheBytes: 50,
      logBytes: 10,
    }),
    sleep: async (duration) => {
      milliseconds += duration;
    },
    now: () => new Date(milliseconds),
  });

  assert.equal(report.status, "passed");
  assert.equal(report.durationMs, MINIMUM_SOAK_DURATION_MS);
  assert.equal(
    resultFilename,
    path.join(
      stagingEnvironment.DATA_DIRECTORY,
      ".staging-soak",
      "result.json",
    ),
  );
  assert.deepEqual(lifecycle, ["validate", "launch", "ready", "terminate"]);

  await assert.rejects(
    runStagingSoak(env, {
      guard: async () => ({ dataDirectory: "/production" }),
      configFactory: () => config,
    }),
    /different data paths/u,
  );
});

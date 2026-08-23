import assert from "node:assert/strict";
import test from "node:test";

import { runBrowserOperation } from "../src/browser-operation.js";

const REGULAR_ADS_HTML = `
  <div id="contentr">
    <a class="fav-item-info-container" href="/ru/item/200">
      <div class="dltitle"><div class="pt">Apartment</div></div>
      <div class="p">220000 ֏</div>
      <div class="at">Кентрон, 2 ком., 50 кв.м., 3/5 этаж</div>
      <div class="d">Friday, July 24, 2026, 14:31</div>
    </a>
  </div>`;

function config(overrides = {}) {
  return {
    browserHeadless: true,
    browserProfileDir: "/persistent/chrome-profile",
    dataDirectory: "/persistent",
    environmentName: "production",
    initialPageCount: 2,
    listUrlTemplate: "https://www.list.am/ru/category/56/{page}?n=0&cmtype=0",
    ...overrides,
  };
}

test("interactive verification persists in the profile consumed by a restarted headless smoke", async () => {
  const verifiedProfiles = new Set();
  const launches = [];
  const events = [];
  const acquireLock = async () => ({
    release: async () => events.push("lock:release"),
  });
  const browserFetcherFactory = (browserConfig) => {
    launches.push({
      headless: browserConfig.browserHeadless,
      loadImages: browserConfig.browserLoadImages === true,
      profileDirectory: browserConfig.browserProfileDir,
    });
    return {
      fetch: async () => {
        events.push("browser:fetch");
        if (!browserConfig.browserHeadless) {
          verifiedProfiles.add(browserConfig.browserProfileDir);
        }
        assert.ok(verifiedProfiles.has(browserConfig.browserProfileDir));
        return new Response(REGULAR_ADS_HTML);
      },
      close: async () => events.push("browser:close"),
    };
  };
  const dependencies = {
    acquireLock,
    browserFetcherFactory,
    validateConfig: async () => events.push("config:validate"),
    recordVerification: async () => events.push("verification:record"),
  };

  const verification = await runBrowserOperation(config(), {
    ...dependencies,
    interactive: true,
  });
  const smoke = await runBrowserOperation(config(), {
    ...dependencies,
    requireProduction: true,
  });

  assert.equal(verification.regularAdsCount, 1);
  assert.equal(verification.sequentialFetchCount, 1);
  assert.equal(smoke.regularAdsCount, 1);
  assert.equal(smoke.sequentialFetchCount, 2);
  assert.deepEqual(launches, [
    {
      headless: false,
      loadImages: true,
      profileDirectory: "/persistent/chrome-profile",
    },
    {
      headless: true,
      loadImages: false,
      profileDirectory: "/persistent/chrome-profile",
    },
  ]);
  assert.deepEqual(events, [
    "config:validate",
    "browser:fetch",
    "verification:record",
    "browser:close",
    "lock:release",
    "config:validate",
    "browser:fetch",
    "browser:fetch",
    "verification:record",
    "browser:close",
    "lock:release",
  ]);
});

test("production verification retains page-one count after validating later pages", async () => {
  let fetchCount = 0;
  const recorded = [];
  const result = await runBrowserOperation(config(), {
    requireProduction: true,
    validateConfig: async () => {},
    acquireLock: async () => ({ release: async () => {} }),
    browserFetcherFactory: () => ({
      fetch: async () => {
        fetchCount += 1;
        return new Response(
          fetchCount === 1 ? REGULAR_ADS_HTML : '<div id="contentr"></div>',
        );
      },
      close: async () => {},
    }),
    recordVerification: async (_config, count) => recorded.push(count),
  });

  assert.equal(result.regularAdsCount, 1);
  assert.deepEqual(recorded, [1]);
});

test("an active service lease prevents operator access to the browser profile", async () => {
  const contention = Object.assign(
    new Error("Another process owns the singleton lease"),
    { code: "ERR_SINGLETON_LOCKED" },
  );
  let browserCreated = false;

  await assert.rejects(
    runBrowserOperation(config(), {
      interactive: true,
      validateConfig: async () => {},
      acquireLock: async () => {
        throw contention;
      },
      browserFetcherFactory: () => {
        browserCreated = true;
      },
    }),
    contention,
  );

  assert.equal(browserCreated, false);
});

test("production smoke rejects an interactive or non-production configuration", async () => {
  let lockAcquired = false;

  await assert.rejects(
    runBrowserOperation(
      config({ browserHeadless: false, environmentName: "development" }),
      {
        requireProduction: true,
        validateConfig: async () => {},
        acquireLock: async () => {
          lockAcquired = true;
        },
      },
    ),
    /requires NODE_ENV=production and BROWSER_HEADLESS=true/u,
  );

  assert.equal(lockAcquired, false);
});

test("browser operation reports challenge events and releases resources on HTTP failure", async () => {
  const records = [];
  const events = [];

  await assert.rejects(
    runBrowserOperation(config(), {
      logger: {
        info: (message) => records.push(["info", message]),
        warn: (message, context) => records.push(["warn", message, context]),
      },
      validateConfig: async () => {},
      acquireLock: async () => ({
        release: async () => events.push("lock:release"),
      }),
      browserFetcherFactory: (_browserConfig, options) => ({
        fetch: async () => {
          options.onStatus("challenge status");
          options.onEvent({
            name: "browser.challenge",
            component: "browser",
            code: "ERR_BROWSER_VERIFICATION_REQUIRED",
            remediationCommand: "npm run browser:verify",
          });
          return new Response("", { status: 503 });
        },
        close: async () => events.push("browser:close"),
      }),
    }),
    /List\.am returned HTTP 503/u,
  );

  assert.deepEqual(records, [
    ["info", "challenge status"],
    [
      "warn",
      "Browser challenge detected",
      {
        eventName: "browser.challenge",
        component: "browser",
        code: "ERR_BROWSER_VERIFICATION_REQUIRED",
        remediationCommand: "npm run browser:verify",
      },
    ],
  ]);
  assert.deepEqual(events, ["browser:close", "lock:release"]);
});

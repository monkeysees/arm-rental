import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { runApplication } from "../src/application.js";
import { createMemoryStateAccess } from "./memory-state.js";

const dataDirectory = path.resolve(process.argv[2]);
const browserProfileDir = path.join(dataDirectory, "chrome-profile");
const chromeLockFile = path.join(browserProfileDir, "SingletonLock");
const deliveryStateFile = path.join(dataDirectory, "fixture-deliveries.json");
const baseConfig = {
  dataDirectory,
  browserProfileDir,
  apartmentsStateFile: path.join(dataDirectory, "apartments.json"),
  deliveryStateFile,
  channelDeliveryStateFile: path.join(dataDirectory, "channel.json"),
  exchangeRatesStateFile: path.join(dataDirectory, "exchange-rates.json"),
  telegramStateFile: path.join(dataDirectory, "telegram.json"),
};

async function readDeliveries() {
  try {
    return JSON.parse(await readFile(deliveryStateFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return { pending: {}, notified: { 101: "delivered" } };
    }
    throw error;
  }
}

try {
  await runApplication({
    config: baseConfig,
    logger: {
      info: (message, context) =>
        console.log(JSON.stringify({ message, ...context })),
      warn: (message, context) =>
        console.log(JSON.stringify({ message, ...context })),
      error: (message, error) =>
        console.error(JSON.stringify({ message, error: error.message })),
    },
    browserFetcherFactory: () => ({
      async fetch() {
        await mkdir(browserProfileDir, { recursive: true });
        for (;;) {
          try {
            await writeFile(chromeLockFile, String(process.pid), {
              flag: "wx",
            });
            break;
          } catch (error) {
            if (error.code !== "EEXIST") throw error;
            const profileOwner = Number(await readFile(chromeLockFile, "utf8"));
            try {
              process.kill(profileOwner, 0);
              throw new Error("Chrome profile is still locked", {
                cause: error,
              });
            } catch (ownerError) {
              if (ownerError.code !== "ESRCH") throw ownerError;
              await rm(chromeLockFile, { force: true });
            }
          }
        }
        return new Response('<div id="contentr"></div>');
      },
      // The real fetcher releases the profile at a session boundary exactly
      // as it does on close, so the lease these tests isolate behaves the same.
      async endSession() {
        await rm(chromeLockFile, { force: true });
      },
      async close() {
        await rm(chromeLockFile, { force: true });
      },
    }),
    exchangeRateServiceFactory: () => ({}),
    // Lease and shutdown behavior is what these tests isolate, so the state
    // backend is stubbed rather than migrated into a real database.
    stateBackendFactory: () => ({
      stateAccess: createMemoryStateAccess({}),
      close: () => {},
    }),
    // Singleton process tests isolate lease/shutdown behavior. The real
    // integration boundaries are covered in test/preflight.test.js.
    preflight: async () => ({
      status: "ready",
      ready: true,
      terminal: false,
      checks: {},
    }),
    runBot: async (_config, { pageFetch, signal }) => {
      console.log("POLLING_STARTED");
      await pageFetch("https://example.invalid/");
      const deliveries = await readDeliveries();
      if (Object.keys(deliveries.pending).length > 0) {
        console.log("DELIVERY_BACKLOG");
      }
      await writeFile(
        deliveryStateFile,
        `${JSON.stringify({ ...deliveries, runningPid: process.pid })}\n`,
      );

      const shutdown = new Promise((resolve) => {
        signal.addEventListener("abort", resolve, { once: true });
      });
      console.log("SERVICE_READY");
      await shutdown;

      await writeFile(
        deliveryStateFile,
        `${JSON.stringify({
          ...deliveries,
          runningPid: null,
          shutdownComplete: true,
        })}\n`,
      );
    },
  });
} catch (error) {
  console.error(`${error.code || error.name}: ${error.message}`);
  process.exitCode = 1;
}

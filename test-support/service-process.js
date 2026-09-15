import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { runApplication } from "../src/application.js";
import { createMemoryStateAccess } from "./memory-state.js";

const dataDirectory = path.resolve(process.argv[2]);
const listAmCookieFile = path.join(dataDirectory, "list-am-cookies.txt");
const deliveryStateFile = path.join(dataDirectory, "fixture-deliveries.json");
const baseConfig = {
  dataDirectory,
  listAmCookieFile,
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
    sourceFetcherFactory: () => ({
      async fetch() {
        await writeFile(listAmCookieFile, "session-cookie", { mode: 0o600 });
        return new Response('<div id="contentr"></div>');
      },
      async close() {
        console.log("SOURCE_CLOSED");
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

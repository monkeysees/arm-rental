import { getConfig, validateStartupConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { initializeState } from "./state-init.js";

const logger = createLogger();
const [command, ...extra] = process.argv.slice(2);

try {
  if (command !== undefined || extra.length > 0) {
    throw new Error("Usage: node src/state-init-cli.js");
  }
  const config = getConfig();
  await validateStartupConfig(config);
  const result = await initializeState(config);
  logger.info("State database initialized", {
    event: "state.initialized",
    ...result,
  });
} catch (error) {
  logger.error("State initialization failed", error, {
    command: command || "state:init",
  });
  process.exitCode = 1;
}

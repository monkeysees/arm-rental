import { getConfig, validateStartupConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { acquireSingletonLock } from "./singleton-lock.js";
import {
  migrateState,
  planStateMigration,
  validateMigratedState,
} from "./state-migration.js";

const logger = createLogger();
const [command, ...extra] = process.argv.slice(2);

function usage() {
  return "Usage: node src/state-migration-cli.js plan|migrate|validate";
}

try {
  if (!new Set(["plan", "migrate", "validate"]).has(command) || extra.length) {
    throw new Error(usage());
  }
  const config = getConfig();
  await validateStartupConfig(config, { allowNonJsonBackend: true });
  const lease = await acquireSingletonLock(config.dataDirectory);
  try {
    const result =
      command === "plan"
        ? await planStateMigration(config)
        : command === "migrate"
          ? await migrateState(config)
          : await validateMigratedState(config);
    logger.info("State migration command completed", {
      event: `state.migration.${command}.completed`,
      command,
      ...result,
    });
  } finally {
    await lease.release();
  }
} catch (error) {
  logger.error("State migration command failed", error, {
    event: "state.migration.failed",
    command: command || "missing",
    code: error.code || "ERR_STATE_MIGRATION",
  });
  process.exitCode = 1;
}

import path from "node:path";

import { getConfig, validateStartupConfig } from "./config.js";
import { createLogger } from "./logger.js";
import {
  checkDiskSpace,
  createSnapshot,
  restoreSnapshot,
  validateSnapshot,
} from "./recovery.js";

function usage() {
  return [
    "Usage:",
    "  node src/recovery-cli.js backup",
    "  node src/recovery-cli.js validate <snapshot-directory>",
    "  node src/recovery-cli.js restore <snapshot-directory>",
    "  node src/recovery-cli.js disk-check",
  ].join("\n");
}

const logger = createLogger();
const [command, argument, ...extra] = process.argv.slice(2);

try {
  if (!command || extra.length > 0) throw new Error(usage());
  const config = getConfig();

  if (command === "backup") {
    await validateStartupConfig(config);
    const disk = await checkDiskSpace(config.dataDirectory, {
      warningThreshold: config.diskFreeWarningFraction,
      onEvent: (event) =>
        event.status === "warning"
          ? logger.warn("Persistent storage is low", event)
          : logger.info("Persistent storage disk check passed", event),
    });
    if (disk.status === "warning") {
      logger.warn("Backup is continuing with low source disk space", {
        eventName: "backup.low_source_disk",
        freeFraction: disk.freeFraction,
      });
    }
    const result = await createSnapshot(config, {
      dailyRetention: config.backupDailyRetention,
      weeklyRetention: config.backupWeeklyRetention,
      onEvent: (event) =>
        logger.info("Recovery operation event", { recovery: event }),
    });
    logger.info("Backup completed", result);
  } else if (command === "validate") {
    if (!argument) throw new Error(usage());
    const result = await validateSnapshot(config, path.resolve(argument));
    logger.info("Backup validation completed", result);
  } else if (command === "restore") {
    if (!argument) throw new Error(usage());
    await validateStartupConfig(config);
    const result = await restoreSnapshot(config, path.resolve(argument), {
      onEvent: (event) =>
        logger.info("Recovery operation event", { recovery: event }),
    });
    logger.warn(
      "Restore completed; keep the bot stopped until browser:smoke passes",
      result,
    );
  } else if (command === "disk-check") {
    const result = await checkDiskSpace(config.dataDirectory, {
      warningThreshold: config.diskFreeWarningFraction,
      onEvent: (event) =>
        event.status === "warning"
          ? logger.warn("Persistent storage is low", event)
          : logger.info("Persistent storage disk check passed", event),
    });
    if (result.status === "warning") process.exitCode = 2;
  } else {
    throw new Error(usage());
  }
} catch (error) {
  logger.error("Recovery command failed", error, {
    command: command || "missing",
  });
  process.exitCode = 1;
}

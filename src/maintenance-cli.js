import { getConfig, validateStartupConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { runMaintenance } from "./maintenance.js";

const logger = createLogger();
const [command, ...extra] = process.argv.slice(2);

try {
  if (command !== "report" || extra.length > 0) {
    throw new Error("Usage: node src/maintenance-cli.js report");
  }
  const config = getConfig();
  await validateStartupConfig(config);
  const report = await runMaintenance(config);
  logger.info("Weekly state maintenance completed", {
    event: "maintenance.report",
    report,
  });
  for (const alert of report.alerts) {
    logger.warn("Persistent state size threshold reached", {
      event: "alert.firing",
      ...alert,
    });
  }
  const firing = new Set(report.alerts.map(({ alertName }) => alertName));
  for (const alertName of ["state_file_growth", "state_sqlite_migration"]) {
    if (!firing.has(alertName)) {
      logger.info("Persistent state size alert resolved", {
        event: "alert.resolved",
        alertName,
      });
    }
  }
  if (report.alerts.length > 0) process.exitCode = 2;
} catch (error) {
  logger.error("Maintenance command failed", error, {
    command: command || "missing",
  });
  process.exitCode = 1;
}

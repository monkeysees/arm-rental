import { getConfig } from "./config.js";
import {
  cleanupBrowserProfile,
  browserBackupUsage,
} from "./browser-cleanup.js";

try {
  const args = process.argv.slice(2);
  if (
    args.length > 1 ||
    (args.length &&
      !["--dry-run", "--apply", "--backup-report"].includes(args[0]))
  ) {
    throw new Error(
      "Usage: node src/browser-cleanup-cli.js [--dry-run|--apply]",
    );
  }
  const config = getConfig();
  const report =
    args[0] === "--backup-report"
      ? {
          event: "browser-cleanup.backup-usage",
          ...(await browserBackupUsage(config.backupDirectory)),
        }
      : {
          event: "browser-cleanup.report",
          ...(await cleanupBrowserProfile(config.dataDirectory, {
            apply: args[0] === "--apply",
          })),
        };
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

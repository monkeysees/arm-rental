import { openStateDatabase } from "./sqlite-database.js";
import { createSqliteRepositories } from "./sqlite-repositories.js";
import { createSqliteStateAccess } from "./sqlite-state-access.js";

/**
 * Opens the installed state database. SQLite is the only backend this release
 * has, so there is nothing to select: the database either exists and is bound
 * to this target, or startup fails. It is never created here — `state:init`
 * is the one command allowed to do that.
 */
export async function openApplicationState(
  config,
  { onMetric = () => {} } = {},
) {
  const database = openStateDatabase({
    dataDirectory: config.dataDirectory,
    listUrlTemplate: config.listUrlTemplate,
    channelId: config.telegramChannelId,
    onMetric,
  });
  try {
    const repositories = createSqliteRepositories(database, {
      listUrlTemplate: config.listUrlTemplate,
      channelId: config.telegramChannelId,
    });
    return {
      backend: "sqlite",
      schemaVersion: 1,
      database,
      repositories,
      stateAccess: createSqliteStateAccess(database, repositories),
      close: () => database.close(),
    };
  } catch (error) {
    database.close({ checkpoint: false });
    throw error;
  }
}

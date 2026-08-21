import { openStateDatabase } from "./sqlite-database.js";
import { createSqliteRepositories } from "./sqlite-repositories.js";
import { createSqliteStateAccess } from "./sqlite-state-access.js";
import {
  readStateBackendSelector,
  StateBackendError,
} from "./state-backend.js";

/** Opens the selector-authorized backend; database-file presence is ignored. */
export async function openApplicationState(
  config,
  { onMetric = () => {} } = {},
) {
  const selector = await readStateBackendSelector(config.dataDirectory);
  // An interrupted cutover is the one non-SQLite selector still recognised, and
  // no release can finish it any more; naming it keeps a host in that state from
  // being read as a plain configuration error.
  if (selector.backend !== "sqlite") {
    throw new StateBackendError(
      "State migration is incomplete and cannot be resumed; restore a snapshot taken after the SQLite cutover",
      { backend: selector.backend },
    );
  }

  const database = openStateDatabase({
    dataDirectory: config.dataDirectory,
    listUrlTemplate: config.listUrlTemplate,
    channelId: config.telegramChannelId,
    onMetric,
  });
  try {
    const metadata = database
      .prepare(
        "SELECT database_id FROM application_metadata WHERE singleton = 1",
      )
      .get();
    if (metadata?.database_id !== selector.databaseId) {
      throw new StateBackendError(
        "SQLite selector does not identify the installed state database",
        { backend: selector.backend },
      );
    }
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

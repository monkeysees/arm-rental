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
  if (selector.backend === "migrating") {
    throw new StateBackendError(
      "State migration is incomplete; resume it before application startup",
      { backend: selector.backend },
    );
  }
  // The selector still names JSON for the migration and bridge tooling, but the
  // application no longer carries a JSON backend. Refusing here keeps a host
  // that never migrated from starting on empty SQLite state.
  if (selector.backend !== "sqlite") {
    throw new StateBackendError(
      `This release stores application state in SQLite and cannot open the ${selector.backend} state backend; run the state migration first`,
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

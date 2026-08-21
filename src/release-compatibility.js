// SQLite is the only backend a release can declare: schema 0 named the JSON
// state files, which no release reads any more.
export function validateReleaseStateCompatibility(metadata) {
  const { stateBackend, minimumStateSchema, maximumStateSchema } = metadata;
  if (stateBackend !== "sqlite") {
    throw new Error("Release stateBackend must be sqlite");
  }
  if (
    !Number.isSafeInteger(minimumStateSchema) ||
    !Number.isSafeInteger(maximumStateSchema) ||
    minimumStateSchema < 1 ||
    maximumStateSchema < minimumStateSchema
  ) {
    throw new Error("Release state schema range is invalid");
  }
  return Object.freeze({
    stateBackend,
    minimumStateSchema,
    maximumStateSchema,
  });
}

export function isReleaseStateCompatible(metadata, liveState) {
  const release = validateReleaseStateCompatibility(metadata);
  return (
    liveState?.stateBackend === release.stateBackend &&
    Number.isSafeInteger(liveState.stateSchema) &&
    liveState.stateSchema >= release.minimumStateSchema &&
    liveState.stateSchema <= release.maximumStateSchema
  );
}

export function assertRollbackStateCompatibility({
  stateStrategy,
  targetMetadata,
  liveState,
}) {
  if (stateStrategy === "restore") return;
  if (stateStrategy !== "compatible") {
    throw new Error("State strategy must be compatible or restore");
  }
  if (!isReleaseStateCompatible(targetMetadata, liveState)) {
    const error = new Error(
      "Compatible rollback target does not support the live state backend and schema",
    );
    error.code = "ERR_RELEASE_STATE_INCOMPATIBLE";
    throw error;
  }
}

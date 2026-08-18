const BACKENDS = new Set(["json", "sqlite"]);

export function validateReleaseStateCompatibility(metadata) {
  const { stateBackend, minimumStateSchema, maximumStateSchema } = metadata;
  if (!BACKENDS.has(stateBackend)) {
    throw new Error("Release stateBackend must be json or sqlite");
  }
  if (
    !Number.isSafeInteger(minimumStateSchema) ||
    !Number.isSafeInteger(maximumStateSchema) ||
    minimumStateSchema < 0 ||
    maximumStateSchema < minimumStateSchema
  ) {
    throw new Error("Release state schema range is invalid");
  }
  if (
    (stateBackend === "json" &&
      (minimumStateSchema !== 0 || maximumStateSchema !== 0)) ||
    (stateBackend === "sqlite" && minimumStateSchema < 1)
  ) {
    throw new Error("Release state backend and schema range disagree");
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

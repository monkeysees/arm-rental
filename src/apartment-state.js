export const APARTMENT_STATE_VERSION = 3;
export const SOURCE_INTEGRITY_HISTORY_LIMIT = 5;

function exactIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
}

function compatibleSourceIntegrity(value) {
  const keys =
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.keys(value)
      : [];
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    keys.every((key) =>
      ["recentFirstPageCounts", "lastSuccessfulAt"].includes(key),
    ) &&
    Array.isArray(value.recentFirstPageCounts) &&
    value.recentFirstPageCounts.length <= SOURCE_INTEGRITY_HISTORY_LIMIT &&
    value.recentFirstPageCounts.every(
      (count) => Number.isSafeInteger(count) && count >= 0,
    ) &&
    (value.lastSuccessfulAt === undefined ||
      exactIsoTimestamp(value.lastSuccessfulAt)),
  );
}

export function compatibleApartmentState(state, template) {
  const compatibleBase = Boolean(
    state &&
    [1, 2, APARTMENT_STATE_VERSION].includes(state.version) &&
    state.type === "list-am-apartments" &&
    state.urlTemplate === template &&
    state.apartments &&
    typeof state.apartments === "object" &&
    !Array.isArray(state.apartments),
  );
  if (!compatibleBase) return false;
  return (
    state.version !== APARTMENT_STATE_VERSION ||
    compatibleSourceIntegrity(state.sourceIntegrity)
  );
}

/** Migrates legacy state in memory; persistence remains the crawler's commit. */
export function migrateApartmentState(state, template) {
  if (!compatibleApartmentState(state, template)) return null;
  if (state.version === APARTMENT_STATE_VERSION) return state;
  return {
    ...state,
    version: APARTMENT_STATE_VERSION,
    sourceIntegrity: { recentFirstPageCounts: [] },
  };
}

export function sourceIntegrityStateSummary(state) {
  const sourceIntegrity =
    state?.version === APARTMENT_STATE_VERSION ? state.sourceIntegrity : null;
  return {
    sourceIntegritySampleCount:
      sourceIntegrity?.recentFirstPageCounts?.length ?? 0,
    sourceIntegrityLastSuccessfulAt: sourceIntegrity?.lastSuccessfulAt ?? null,
  };
}

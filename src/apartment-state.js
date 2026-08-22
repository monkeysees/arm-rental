import { PROPERTY_KINDS } from "./property-kind.js";

export const APARTMENT_STATE_VERSION = 4;
export const SOURCE_INTEGRITY_HISTORY_LIMIT = 5;

function exactIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
}

function compatibleFirstPageCounts(counts) {
  return Boolean(
    Array.isArray(counts) &&
    counts.length <= SOURCE_INTEGRITY_HISTORY_LIMIT &&
    counts.every((count) => Number.isSafeInteger(count) && count >= 0),
  );
}

/**
 * Each List.am category paginates on its own, so a first page that suddenly
 * shrinks is only meaningful against that category's own history. Version 4
 * therefore keeps one series per kind; version 3 kept the single flat series
 * that was enough when apartments were the only category, and is still
 * readable so a stored crawl survives the upgrade.
 */
function compatibleSourceIntegrity(value, { perKindCounts }) {
  const plainObject =
    Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (!plainObject) return false;
  if (
    !Object.keys(value).every((key) =>
      ["recentFirstPageCounts", "lastSuccessfulAt"].includes(key),
    )
  ) {
    return false;
  }
  if (
    value.lastSuccessfulAt !== undefined &&
    !exactIsoTimestamp(value.lastSuccessfulAt)
  ) {
    return false;
  }

  const counts = value.recentFirstPageCounts;
  if (!perKindCounts) return compatibleFirstPageCounts(counts);
  return Boolean(
    counts &&
    typeof counts === "object" &&
    !Array.isArray(counts) &&
    Object.keys(counts).every(
      (kind) =>
        PROPERTY_KINDS.includes(kind) &&
        compatibleFirstPageCounts(counts[kind]),
    ),
  );
}

export function compatibleApartmentState(state, template) {
  const compatibleBase = Boolean(
    state &&
    [1, 2, 3, APARTMENT_STATE_VERSION].includes(state.version) &&
    state.type === "list-am-apartments" &&
    state.urlTemplate === template &&
    state.apartments &&
    typeof state.apartments === "object" &&
    !Array.isArray(state.apartments),
  );
  if (!compatibleBase) return false;
  if (state.version < 3) return true;
  return compatibleSourceIntegrity(state.sourceIntegrity, {
    perKindCounts: state.version === APARTMENT_STATE_VERSION,
  });
}

/** Migrates legacy state in memory; persistence remains the crawler's commit. */
export function migrateApartmentState(state, template) {
  if (!compatibleApartmentState(state, template)) return null;
  if (state.version === APARTMENT_STATE_VERSION) return state;
  return {
    ...state,
    version: APARTMENT_STATE_VERSION,
    sourceIntegrity:
      state.version === 3
        ? {
            ...state.sourceIntegrity,
            // The flat series was the apartment category's own history.
            recentFirstPageCounts: {
              apartment: [...state.sourceIntegrity.recentFirstPageCounts],
            },
          }
        : { recentFirstPageCounts: {} },
  };
}

export function sourceIntegrityStateSummary(state) {
  const sourceIntegrity =
    state?.version === APARTMENT_STATE_VERSION ? state.sourceIntegrity : null;
  const counts = Object.values(sourceIntegrity?.recentFirstPageCounts ?? {});
  return {
    sourceIntegritySampleCount: counts.reduce(
      (total, series) => total + series.length,
      0,
    ),
    sourceIntegrityLastSuccessfulAt: sourceIntegrity?.lastSuccessfulAt ?? null,
  };
}

import {
  parseRegularApartments,
  REGULAR_SECTION_MISSING_CODE,
} from "./list-am.js";

export const LIST_AM_SOURCE_INTEGRITY_ERROR = "ERR_LIST_AM_SOURCE_INTEGRITY";
export const LIST_AM_COMPLETENESS_PERCENT = 90;

export const ListAmIntegrityReason = Object.freeze({
  REGULAR_SECTION_MISSING: "REGULAR_SECTION_MISSING",
  FIRST_PAGE_EMPTY: "FIRST_PAGE_EMPTY",
  PARSE_SUCCESS_BELOW_THRESHOLD: "PARSE_SUCCESS_BELOW_THRESHOLD",
  IDENTITY_REJECTION: "IDENTITY_REJECTION",
  TITLE_COMPLETENESS_BELOW_THRESHOLD: "TITLE_COMPLETENESS_BELOW_THRESHOLD",
  DATE_COMPLETENESS_BELOW_THRESHOLD: "DATE_COMPLETENESS_BELOW_THRESHOLD",
  FIRST_PAGE_COUNT_DROP: "FIRST_PAGE_COUNT_DROP",
});

function aggregateCounts(diagnostics) {
  return {
    candidateCount: diagnostics.candidateCount,
    uniqueCandidateCount: diagnostics.uniqueCandidateCount,
    parsedCount: diagnostics.parsedCount,
    duplicateCount: diagnostics.duplicateCount,
    rejectedCount: diagnostics.rejectedCount,
    completeness: { ...diagnostics.completeness },
  };
}

/** Returns the only source-page fields permitted in logs, health, and metrics. */
export function sourceIntegrityPageSummary(diagnostics, page, kind) {
  return {
    page,
    ...(kind ? { kind } : {}),
    ...aggregateCounts(diagnostics),
  };
}

/** Whitelists a typed failure for operational telemetry. */
export function sourceIntegrityFailureSummary(error) {
  const details = error?.details || {};
  const kind = error?.kind ?? details.kind;
  const summary = {
    reason: error?.reason ?? details.reason,
    page: error?.page ?? details.page,
    ...(kind ? { kind } : {}),
  };
  for (const key of [
    "candidateCount",
    "uniqueCandidateCount",
    "parsedCount",
    "duplicateCount",
    "rejectedCount",
    "completeness",
    "priorCount",
    "priorMedianTwice",
    "thresholds",
  ]) {
    if (details[key] !== undefined)
      summary[key] = structuredClone(details[key]);
  }
  return summary;
}

function zeroDiagnostics() {
  return {
    apartments: [],
    candidateCount: 0,
    uniqueCandidateCount: 0,
    parsedCount: 0,
    duplicateCount: 0,
    rejectedCount: 0,
    completeness: {
      title: 0,
      date: 0,
      price: 0,
      location: 0,
      rooms: 0,
      areaSqM: 0,
      floor: 0,
    },
  };
}

function thresholdsFor(reason) {
  if (reason === ListAmIntegrityReason.PARSE_SUCCESS_BELOW_THRESHOLD) {
    return { minimumParseSuccessPercent: LIST_AM_COMPLETENESS_PERCENT };
  }
  if (reason === ListAmIntegrityReason.TITLE_COMPLETENESS_BELOW_THRESHOLD) {
    return { minimumTitleCompletenessPercent: LIST_AM_COMPLETENESS_PERCENT };
  }
  if (reason === ListAmIntegrityReason.DATE_COMPLETENESS_BELOW_THRESHOLD) {
    return { minimumDateCompletenessPercent: LIST_AM_COMPLETENESS_PERCENT };
  }
  if (reason === ListAmIntegrityReason.FIRST_PAGE_COUNT_DROP) {
    return {
      minimumPriorCount: 3,
      countDropPercent: 50,
      minimumAbsoluteDrop: 5,
    };
  }
  return undefined;
}

function safeIntegrityContext(value) {
  if (
    !Number.isSafeInteger(value?.priorCount) ||
    value.priorCount < 0 ||
    !/^\d+$/u.test(value?.priorMedianTwice || "")
  ) {
    return {};
  }
  return {
    priorCount: value.priorCount,
    priorMedianTwice: value.priorMedianTwice,
  };
}

export class ListAmSourceIntegrityError extends Error {
  constructor(reason, { page, kind, diagnostics, integrityContext } = {}) {
    super(`List.am source integrity check failed: ${reason}`);
    this.name = "ListAmSourceIntegrityError";
    this.code = LIST_AM_SOURCE_INTEGRITY_ERROR;
    this.reason = reason;
    this.page = page;
    this.kind = kind;
    this.details = {
      reason,
      page,
      ...(kind ? { kind } : {}),
      ...(diagnostics ? aggregateCounts(diagnostics) : {}),
      ...safeIntegrityContext(integrityContext),
      ...(thresholdsFor(reason) ? { thresholds: thresholdsFor(reason) } : {}),
    };
  }
}

function fail(reason, { page, kind }, diagnostics, integrityContext) {
  throw new ListAmSourceIntegrityError(reason, {
    page,
    kind,
    diagnostics,
    integrityContext,
  });
}

/** Applies the version-controlled hard integrity rules in precedence order. */
export function evaluateListAmSourceIntegrity(
  diagnostics,
  { page, kind, priorFirstPageCounts = [] },
) {
  const source = { page, kind };
  if (page === 1 && diagnostics.candidateCount === 0) {
    fail(ListAmIntegrityReason.FIRST_PAGE_EMPTY, source, diagnostics);
  }
  if (
    diagnostics.uniqueCandidateCount > 0 &&
    diagnostics.parsedCount * 100 <
      diagnostics.uniqueCandidateCount * LIST_AM_COMPLETENESS_PERCENT
  ) {
    fail(
      ListAmIntegrityReason.PARSE_SUCCESS_BELOW_THRESHOLD,
      source,
      diagnostics,
    );
  }
  if (diagnostics.rejectedCount > 0) {
    fail(ListAmIntegrityReason.IDENTITY_REJECTION, source, diagnostics);
  }
  if (
    page === 1 &&
    diagnostics.completeness.title * 100 <
      diagnostics.parsedCount * LIST_AM_COMPLETENESS_PERCENT
  ) {
    fail(
      ListAmIntegrityReason.TITLE_COMPLETENESS_BELOW_THRESHOLD,
      source,
      diagnostics,
    );
  }
  if (
    page === 1 &&
    diagnostics.completeness.date * 100 <
      diagnostics.parsedCount * LIST_AM_COMPLETENESS_PERCENT
  ) {
    fail(
      ListAmIntegrityReason.DATE_COMPLETENESS_BELOW_THRESHOLD,
      source,
      diagnostics,
    );
  }
  if (page === 1 && priorFirstPageCounts.length >= 3) {
    const sorted = [...priorFirstPageCounts].sort(
      (left, right) => left - right,
    );
    const middle = Math.floor(sorted.length / 2);
    const medianTwice =
      sorted.length % 2 === 1
        ? 2n * BigInt(sorted[middle])
        : BigInt(sorted[middle - 1]) + BigInt(sorted[middle]);
    const current = BigInt(diagnostics.parsedCount);
    if (4n * current < medianTwice && medianTwice - 2n * current >= 10n) {
      fail(ListAmIntegrityReason.FIRST_PAGE_COUNT_DROP, source, diagnostics, {
        priorCount: priorFirstPageCounts.length,
        priorMedianTwice: medianTwice.toString(),
      });
    }
  }
  return diagnostics;
}

/** Parses a page and maps a missing Regular Ads section to the same hard rule. */
export function parseAndEvaluateRegularApartments(
  html,
  { page, kind, priorFirstPageCounts = [] },
) {
  let diagnostics;
  try {
    diagnostics = parseRegularApartments(html);
  } catch (error) {
    if (error?.code === REGULAR_SECTION_MISSING_CODE) {
      fail(
        ListAmIntegrityReason.REGULAR_SECTION_MISSING,
        { page, kind },
        zeroDiagnostics(),
      );
    }
    throw error;
  }
  return evaluateListAmSourceIntegrity(diagnostics, {
    page,
    kind,
    priorFirstPageCounts,
  });
}

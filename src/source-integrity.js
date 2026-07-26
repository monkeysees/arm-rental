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
  return undefined;
}

export class ListAmSourceIntegrityError extends Error {
  constructor(reason, { page, diagnostics } = {}) {
    super(`List.am source integrity check failed: ${reason}`);
    this.name = "ListAmSourceIntegrityError";
    this.code = LIST_AM_SOURCE_INTEGRITY_ERROR;
    this.reason = reason;
    this.page = page;
    this.details = {
      reason,
      page,
      ...(diagnostics ? aggregateCounts(diagnostics) : {}),
      ...(thresholdsFor(reason) ? { thresholds: thresholdsFor(reason) } : {}),
    };
  }
}

function fail(reason, page, diagnostics) {
  throw new ListAmSourceIntegrityError(reason, { page, diagnostics });
}

/** Applies the version-controlled hard integrity rules in precedence order. */
export function evaluateListAmSourceIntegrity(diagnostics, { page }) {
  if (page === 1 && diagnostics.candidateCount === 0) {
    fail(ListAmIntegrityReason.FIRST_PAGE_EMPTY, page, diagnostics);
  }
  if (
    diagnostics.uniqueCandidateCount > 0 &&
    diagnostics.parsedCount * 100 <
      diagnostics.uniqueCandidateCount * LIST_AM_COMPLETENESS_PERCENT
  ) {
    fail(
      ListAmIntegrityReason.PARSE_SUCCESS_BELOW_THRESHOLD,
      page,
      diagnostics,
    );
  }
  if (diagnostics.rejectedCount > 0) {
    fail(ListAmIntegrityReason.IDENTITY_REJECTION, page, diagnostics);
  }
  if (
    page === 1 &&
    diagnostics.completeness.title * 100 <
      diagnostics.parsedCount * LIST_AM_COMPLETENESS_PERCENT
  ) {
    fail(
      ListAmIntegrityReason.TITLE_COMPLETENESS_BELOW_THRESHOLD,
      page,
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
      page,
      diagnostics,
    );
  }
  return diagnostics;
}

/** Parses a page and maps a missing Regular Ads section to the same hard rule. */
export function parseAndEvaluateRegularApartments(html, { page }) {
  let diagnostics;
  try {
    diagnostics = parseRegularApartments(html);
  } catch (error) {
    if (error?.code === REGULAR_SECTION_MISSING_CODE) {
      fail(
        ListAmIntegrityReason.REGULAR_SECTION_MISSING,
        page,
        zeroDiagnostics(),
      );
    }
    throw error;
  }
  return evaluateListAmSourceIntegrity(diagnostics, { page });
}

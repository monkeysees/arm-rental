import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateListAmSourceIntegrity,
  ListAmIntegrityReason,
  ListAmSourceIntegrityError,
  parseAndEvaluateRegularApartments,
} from "../src/source-integrity.js";

function diagnostics(overrides = {}) {
  const parsedCount = overrides.parsedCount ?? 10;
  return {
    apartments: [],
    candidateCount: overrides.candidateCount ?? 10,
    uniqueCandidateCount: overrides.uniqueCandidateCount ?? 10,
    parsedCount,
    duplicateCount: overrides.duplicateCount ?? 0,
    rejectedCount: overrides.rejectedCount ?? 0,
    completeness: {
      title: parsedCount,
      date: parsedCount,
      price: 0,
      location: 0,
      rooms: 0,
      areaSqM: 0,
      floor: 0,
      ...overrides.completeness,
    },
  };
}

function integrityError(operation) {
  let captured;
  assert.throws(operation, (error) => {
    assert.ok(error instanceof ListAmSourceIntegrityError);
    captured = error;
    return true;
  });
  return captured;
}

test("integrity percentage rules use exact integer 90 percent boundaries", () => {
  for (const [parsedCount, expectedReason] of [
    [91, null],
    [90, null],
    [89, ListAmIntegrityReason.PARSE_SUCCESS_BELOW_THRESHOLD],
  ]) {
    const observed = diagnostics({
      candidateCount: 100,
      uniqueCandidateCount: 100,
      parsedCount,
      completeness: { title: parsedCount, date: parsedCount },
    });
    if (expectedReason) {
      assert.equal(
        integrityError(() =>
          evaluateListAmSourceIntegrity(observed, { page: 2 }),
        ).reason,
        expectedReason,
      );
    } else {
      assert.equal(
        evaluateListAmSourceIntegrity(observed, { page: 2 }),
        observed,
      );
    }
  }

  for (const [field, reason] of [
    ["title", ListAmIntegrityReason.TITLE_COMPLETENESS_BELOW_THRESHOLD],
    ["date", ListAmIntegrityReason.DATE_COMPLETENESS_BELOW_THRESHOLD],
  ]) {
    for (const [completeCount, fails] of [
      [91, false],
      [90, false],
      [89, true],
    ]) {
      const completeness = { title: 100, date: 100, [field]: completeCount };
      const observed = diagnostics({
        candidateCount: 100,
        uniqueCandidateCount: 100,
        parsedCount: 100,
        completeness,
      });
      if (fails) {
        assert.equal(
          integrityError(() =>
            evaluateListAmSourceIntegrity(observed, { page: 1 }),
          ).reason,
          reason,
        );
      } else {
        assert.equal(
          evaluateListAmSourceIntegrity(observed, { page: 1 }),
          observed,
        );
      }
    }
  }
});

test("integrity reasons follow hard-rule precedence and later empty pages pass", () => {
  assert.equal(
    integrityError(() =>
      parseAndEvaluateRegularApartments("<html></html>", { page: 1 }),
    ).reason,
    ListAmIntegrityReason.REGULAR_SECTION_MISSING,
  );
  assert.equal(
    integrityError(() =>
      evaluateListAmSourceIntegrity(
        diagnostics({
          candidateCount: 0,
          uniqueCandidateCount: 0,
          parsedCount: 0,
        }),
        { page: 1 },
      ),
    ).reason,
    ListAmIntegrityReason.FIRST_PAGE_EMPTY,
  );
  assert.equal(
    integrityError(() =>
      evaluateListAmSourceIntegrity(
        diagnostics({ parsedCount: 8, rejectedCount: 1 }),
        { page: 1 },
      ),
    ).reason,
    ListAmIntegrityReason.PARSE_SUCCESS_BELOW_THRESHOLD,
  );
  assert.equal(
    integrityError(() =>
      evaluateListAmSourceIntegrity(diagnostics({ rejectedCount: 1 }), {
        page: 1,
      }),
    ).reason,
    ListAmIntegrityReason.IDENTITY_REJECTION,
  );

  const emptyLaterPage = diagnostics({
    candidateCount: 0,
    uniqueCandidateCount: 0,
    parsedCount: 0,
  });
  assert.equal(
    evaluateListAmSourceIntegrity(emptyLaterPage, { page: 2 }),
    emptyLaterPage,
  );
});

test("integrity errors expose only safe aggregate diagnostics", () => {
  const observed = diagnostics({ rejectedCount: 1 });
  observed.apartments = [{ url: "https://example.invalid/private-card" }];

  const error = integrityError(() =>
    evaluateListAmSourceIntegrity(observed, { page: 2 }),
  );
  const serialized = JSON.stringify(error.details);
  assert.match(serialized, /IDENTITY_REJECTION/u);
  assert.equal(serialized.includes("private-card"), false);
  assert.equal(Object.hasOwn(error.details, "apartments"), false);

  const constructed = new ListAmSourceIntegrityError(
    ListAmIntegrityReason.FIRST_PAGE_COUNT_DROP,
    {
      page: 1,
      diagnostics: observed,
      integrityContext: {
        priorCount: 3,
        priorMedianTwice: "40",
        rawHtml: "private-card",
      },
    },
  );
  assert.equal(
    JSON.stringify(constructed.details).includes("private-card"),
    false,
  );
});

test("missing-section errors serialize canonical zero aggregate diagnostics", () => {
  const error = integrityError(() =>
    parseAndEvaluateRegularApartments("<html></html>", { page: 3 }),
  );

  assert.deepEqual(JSON.parse(JSON.stringify(error.details)), {
    reason: ListAmIntegrityReason.REGULAR_SECTION_MISSING,
    page: 3,
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
  });
  assert.equal(Object.hasOwn(error.details, "apartments"), false);
});

test("material count drops use bounded odd and even median history", () => {
  const passes = [
    { prior: [], current: 1 },
    { prior: [20, 20], current: 1 },
    { prior: [20, 20, 20], current: 10 },
    { prior: [10, 20, 20, 30], current: 10 },
    { prior: [20, 21, 22, 23], current: 11 },
    { prior: [6, 6, 6], current: 2 },
    { prior: [20, 20, 20], current: 1, page: 2 },
  ];
  for (const { prior, current, page = 1 } of passes) {
    const observed = diagnostics({
      candidateCount: current,
      uniqueCandidateCount: current,
      parsedCount: current,
    });
    assert.equal(
      evaluateListAmSourceIntegrity(observed, {
        page,
        priorFirstPageCounts: prior,
      }),
      observed,
    );
  }

  for (const { prior, current } of [
    { prior: [20, 20, 20], current: 9 },
    { prior: [10, 20, 20, 30], current: 9 },
    { prior: [20, 21, 22, 23], current: 10 },
    { prior: [18, 20, 22, 24, 26], current: 10 },
    { prior: [8, 8, 8], current: 3 },
  ]) {
    const error = integrityError(() =>
      evaluateListAmSourceIntegrity(
        diagnostics({
          candidateCount: current,
          uniqueCandidateCount: current,
          parsedCount: current,
        }),
        { page: 1, priorFirstPageCounts: prior },
      ),
    );
    assert.equal(error.reason, ListAmIntegrityReason.FIRST_PAGE_COUNT_DROP);
    assert.equal(error.details.priorCount, prior.length);
    assert.match(error.details.priorMedianTwice, /^\d+$/u);
  }
});

test("count drop is the final page-one integrity reason", () => {
  const error = integrityError(() =>
    evaluateListAmSourceIntegrity(
      diagnostics({
        candidateCount: 9,
        uniqueCandidateCount: 9,
        parsedCount: 9,
        completeness: { title: 8, date: 9 },
      }),
      { page: 1, priorFirstPageCounts: [20, 20, 20] },
    ),
  );
  assert.equal(
    error.reason,
    ListAmIntegrityReason.TITLE_COMPLETENESS_BELOW_THRESHOLD,
  );
});

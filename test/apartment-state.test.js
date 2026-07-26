import assert from "node:assert/strict";
import test from "node:test";

import {
  compatibleApartmentState,
  migrateApartmentState,
} from "../src/apartment-state.js";

const template = "https://www.list.am/category/56?page={page}";

function state(version, overrides = {}) {
  return {
    version,
    type: "list-am-apartments",
    urlTemplate: template,
    apartments: { 10: { itemId: "10", title: "Apartment" } },
    apartmentOrder: ["10"],
    ...overrides,
  };
}

test("version one and two apartment states migrate in memory without data changes", () => {
  for (const version of [1, 2]) {
    const legacy = state(version);
    const migrated = migrateApartmentState(legacy, template);

    assert.equal(compatibleApartmentState(legacy, template), true);
    assert.equal(migrated.version, 3);
    assert.equal(migrated.apartments, legacy.apartments);
    assert.equal(migrated.apartmentOrder, legacy.apartmentOrder);
    assert.deepEqual(migrated.sourceIntegrity, {
      recentFirstPageCounts: [],
    });
  }
});

test("version three requires only a bounded aggregate and exact optional timestamp", () => {
  assert.equal(
    compatibleApartmentState(
      state(3, {
        sourceIntegrity: {
          recentFirstPageCounts: [0, 1, 2, 3, Number.MAX_SAFE_INTEGER],
          lastSuccessfulAt: "2026-07-26T12:00:00.000Z",
        },
      }),
      template,
    ),
    true,
  );
  assert.equal(
    compatibleApartmentState(
      state(3, { sourceIntegrity: { recentFirstPageCounts: [] } }),
      template,
    ),
    true,
  );

  for (const sourceIntegrity of [
    undefined,
    { recentFirstPageCounts: [1, 2, 3, 4, 5, 6] },
    { recentFirstPageCounts: [-1] },
    { recentFirstPageCounts: [1.5] },
    { recentFirstPageCounts: [Number.MAX_SAFE_INTEGER + 1] },
    { recentFirstPageCounts: [], lastSuccessfulAt: "2026-07-26T12:00:00Z" },
    { recentFirstPageCounts: [], apartments: ["raw-data"] },
  ]) {
    const observed = state(3, { sourceIntegrity });
    assert.equal(compatibleApartmentState(observed, template), false);
    assert.equal(migrateApartmentState(observed, template), null);
  }
});

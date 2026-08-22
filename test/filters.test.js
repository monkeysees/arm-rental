import assert from "node:assert/strict";
import test from "node:test";

import {
  apartmentMatchesFilters,
  emptyFilters,
  normalizeFilters,
  parseRangeInput,
  placeLocationId,
  regionLocationId,
} from "../src/filters.js";

function apartment({ amount = 220_000, rooms = 2, location = "Кентрон" } = {}) {
  return {
    price: {
      amountAmd: amount,
      originalAmount: amount,
      originalCurrency: "AMD",
    },
    rooms,
    location,
  };
}

test("optional ranges and multiple hierarchical locations compose", () => {
  const filters = {
    price: { min: 180_000, max: 250_000 },
    rooms: { min: 2, max: 3 },
    locations: [
      regionLocationId(0),
      placeLocationId(4, 0), // Гюмри
    ],
  };

  assert.equal(apartmentMatchesFilters(apartment(), filters), true);
  assert.equal(
    apartmentMatchesFilters(apartment({ location: "Гюмри" }), filters),
    true,
  );
  assert.equal(
    apartmentMatchesFilters(apartment({ location: "Ванадзор" }), filters),
    false,
  );
  assert.equal(
    apartmentMatchesFilters(apartment({ rooms: null }), filters),
    false,
  );
  assert.equal(
    apartmentMatchesFilters(apartment({ amount: 300_000 }), filters),
    false,
  );
  assert.equal(apartmentMatchesFilters(apartment(), emptyFilters()), true);
});

test("housing kinds default to apartments and admit only what is selected", () => {
  const house = { ...apartment(), kind: "house" };
  const flat = { ...apartment(), kind: "apartment" };
  // A record stored before houses existed carries no kind and is an apartment.
  const legacy = apartment();

  assert.deepEqual(emptyFilters().kinds, ["apartment"]);
  assert.equal(apartmentMatchesFilters(flat, emptyFilters()), true);
  assert.equal(apartmentMatchesFilters(legacy, emptyFilters()), true);
  assert.equal(apartmentMatchesFilters(house, emptyFilters()), false);

  const houses = { ...emptyFilters(), kinds: ["house"] };
  assert.equal(apartmentMatchesFilters(house, houses), true);
  assert.equal(apartmentMatchesFilters(legacy, houses), false);

  const both = { ...emptyFilters(), kinds: ["house", "apartment"] };
  assert.equal(apartmentMatchesFilters(house, both), true);
  assert.equal(apartmentMatchesFilters(flat, both), true);
  // The catalog order is what normalization stores, whatever order it is given.
  assert.deepEqual(normalizeFilters(both).kinds, ["apartment", "house"]);

  // An unusable selection narrows back to the default instead of widening.
  for (const kinds of [[], ["castle"], "house", undefined]) {
    assert.deepEqual(normalizeFilters({ kinds }).kinds, ["apartment"]);
  }
});

test("price filters compare converted AMD rather than the original amount", () => {
  const foreignApartment = {
    price: {
      amountAmd: 585_392,
      originalAmount: 1_600,
      originalCurrency: "USD",
    },
    rooms: 2,
    location: "Кентрон",
  };

  assert.equal(
    apartmentMatchesFilters(foreignApartment, {
      ...emptyFilters(),
      price: { min: 500_000, max: 600_000 },
    }),
    true,
  );
  assert.equal(
    apartmentMatchesFilters(foreignApartment, {
      ...emptyFilters(),
      price: { min: 1_500, max: 2_000 },
    }),
    false,
  );
});

test("range input supports exact and open ranges with clear validation", () => {
  assert.deepEqual(parseRangeInput("100 000 - 250 000", "price"), {
    min: 100_000,
    max: 250_000,
  });
  assert.deepEqual(parseRangeInput("-4", "rooms"), { min: null, max: 4 });
  assert.deepEqual(parseRangeInput("2", "rooms"), { min: 2, max: 2 });
  assert.deepEqual(parseRangeInput("нет", "price"), {
    min: null,
    max: null,
  });
  assert.throws(
    () => parseRangeInput("5-2", "rooms"),
    /минимальное значение не может быть больше/,
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  apartmentMatchesFilters,
  emptyFilters,
  parseRangeInput,
  placeLocationId,
  regionLocationId,
} from "../src/filters.js";

function apartment({ amount = 220_000, rooms = 2, location = "Кентрон" } = {}) {
  return {
    price: { amount, currency: "֏" },
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

import assert from "node:assert/strict";
import test from "node:test";

import {
  extractRegularApartments,
  parseDetails,
  parsePrice,
} from "../src/list-am.js";

test("extractRegularApartments reads normalized fields from Regular Ads only", () => {
  const html = `
    <div id="contentr">
      <div id="tp">
        <a class="fav-item-info-container" href="/ru/item/100">
          <div class="dltitle"><div class="pt">Top ad</div></div>
        </a>
      </div>
      <div class="glheader">Regular Ads</div>
      <a class="fav-item-info-container" href="/ru/item/200?ld_src=2">
        <div class="dltitle">
          <div class="pt">Apartment on Komitas Avenue</div>
        </div>
        <div class="p">220,000 ֏ monthly</div>
        <div class="at">Кентрон, 4 ком., 97 кв.м., 9/11 этаж</div>
        <div class="d">Пятница, Июль 24, 2026, 14:31</div>
      </a>
    </div>`;

  assert.deepEqual(extractRegularApartments(html), [
    {
      url: "https://www.list.am/ru/item/200",
      itemId: "200",
      title: "Apartment on Komitas Avenue",
      price: { amount: 220_000, currency: "֏" },
      location: "Кентрон",
      rooms: 4,
      areaSqM: 97,
      floor: "9/11",
      date: "Пятница, Июль 24, 2026, 14:31",
    },
  ]);
});

test("parsing helpers tolerate other currencies and missing card details", () => {
  assert.deepEqual(parsePrice("$1,800 monthly"), {
    amount: 1_800,
    currency: "$",
  });
  assert.deepEqual(parseDetails("Kentron"), {
    location: "Kentron",
    rooms: null,
    areaSqM: null,
    floor: null,
  });
});

test("extractRegularApartments fails clearly on a challenge page", () => {
  assert.throws(
    () => extractRegularApartments("<title>Just a moment...</title>"),
    /Could not find the List\.am Regular Ads section/,
  );
});

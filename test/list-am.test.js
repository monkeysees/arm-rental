import assert from "node:assert/strict";
import test from "node:test";

import {
  extractRegularApartments,
  parseDetails,
  parsePrice,
  parseRegularApartments,
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

test("diagnostics count candidates, identities, duplicates, and normalized completeness", () => {
  const html = `
    <div id="contentr">
      <div id="tp">
        <a class="fav-item-info-container" href="/ru/item/100">
          <div class="dltitle"><div class="pt">Promoted</div></div>
        </a>
      </div>
      <a class="fav-item-info-container" href="/ru/item/200?source=regular">
        <div class="dltitle"><div class="pt">Complete apartment</div></div>
        <div class="p">220,000 ֏</div>
        <div class="at">Кентрон, 4 ком., 97 кв.м., 9/11 этаж</div>
        <div class="d">Пятница, Июль 24, 2026, 14:31</div>
      </a>
      <div>
        <a class="fav-item-info-container" href="/item/200">
          <div class="l">Duplicate</div>
        </a>
        <a class="fav-item-info-container" href="/ru/item/300suffix">
          <div class="l">Bad boundary</div>
        </a>
        <a class="fav-item-info-container" href="https://example.com/ru/item/400">
          <div class="l">Foreign URL</div>
        </a>
        <a class="fav-item-info-container">
          <div class="l">Missing identity</div>
        </a>
        <a class="fav-item-info-container" href="/item/201">
          <div class="l">   </div>
          <div class="p">unknown</div>
          <div class="at">Arabkir</div>
          <div class="d">not a posting date</div>
        </a>
      </div>
    </div>`;

  const diagnostics = parseRegularApartments(html);

  assert.deepEqual(
    {
      ...diagnostics,
      apartments: diagnostics.apartments.map(({ itemId, url }) => ({
        itemId,
        url,
      })),
    },
    {
      apartments: [
        { itemId: "200", url: "https://www.list.am/ru/item/200" },
        { itemId: "201", url: "https://www.list.am/ru/item/201" },
      ],
      candidateCount: 6,
      uniqueCandidateCount: 2,
      parsedCount: 2,
      duplicateCount: 1,
      rejectedCount: 3,
      completeness: {
        title: 1,
        date: 1,
        price: 1,
        location: 2,
        rooms: 1,
        areaSqM: 1,
        floor: 1,
      },
    },
  );
  assert.equal(JSON.stringify(diagnostics).includes("300suffix"), false);
  assert.equal(JSON.stringify(diagnostics).includes("example.com"), false);
});

test("legacy .dl anchors are fallback candidates only without primary cards", () => {
  const withPrimary = parseRegularApartments(`
    <div id="contentr">
      <a class="fav-item-info-container" href="/item/10">Primary</a>
      <div class="dl"><a href="/item/11">Fallback</a></div>
    </div>`);
  assert.equal(withPrimary.candidateCount, 1);
  assert.deepEqual(
    withPrimary.apartments.map(({ itemId }) => itemId),
    ["10"],
  );

  const fallbackOnly = parseRegularApartments(`
    <div id="contentr">
      <div id="tp"><div class="dl"><a href="/item/9">Top</a></div></div>
      <div class="dl"><a href="/item/11">Fallback</a></div>
      <div class="dl"><a>Malformed fallback</a></div>
    </div>`);
  assert.equal(fallbackOnly.candidateCount, 2);
  assert.equal(fallbackOnly.rejectedCount, 1);
  assert.deepEqual(
    fallbackOnly.apartments.map(({ itemId }) => itemId),
    ["11"],
  );
});

test("an empty Regular Ads container has complete zero diagnostics", () => {
  assert.deepEqual(parseRegularApartments('<div id="contentr"></div>'), {
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
  });
});

test("extractRegularApartments fails clearly on a challenge page", () => {
  assert.throws(
    () => extractRegularApartments("<title>Just a moment...</title>"),
    /Could not find the List\.am Regular Ads section/,
  );
});

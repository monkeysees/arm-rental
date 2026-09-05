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

test("redesigned cards carry the location apart from the attribute line", () => {
  const html = `
    <div id="contentr">
      <div class="dl">
        <a class="category-data-list-card__destination" href="/ru/item/300?ld_src=2">
          <div class="dltitle"><div class="pt">1-комн. квартира в Аване</div></div>
          <div class="at category-data-list-card__metadata">1 ком. · 47 кв.м. · 3/9 этаж</div>
          <div class="p"><span>180,000<span>֏</span></span><span>в месяц</span></div>
          <div class="l category-data-list-card__metadata">Аван</div>
          <div class="d category-data-list-card__date">Сентябрь 04</div>
        </a>
      </div>
    </div>`;

  assert.deepEqual(extractRegularApartments(html), [
    {
      url: "https://www.list.am/ru/item/300",
      itemId: "300",
      title: "1-комн. квартира в Аване",
      price: { amount: 180_000, currency: "֏" },
      location: "Аван",
      rooms: 1,
      areaSqM: 47,
      floor: "3/9",
      date: "Сентябрь 04",
    },
  ]);
});

test("attribute lines are read by what they name, not by position", () => {
  // The redesigned line states no location and omits what an ad leaves out;
  // houses routinely publish rooms without an area or a floor.
  assert.deepEqual(parseDetails("1 ком. · 47 кв.м. · 3/9 этаж"), {
    location: "",
    rooms: 1,
    areaSqM: 47,
    floor: "3/9",
  });
  assert.deepEqual(parseDetails("3 ком."), {
    location: "",
    rooms: 3,
    areaSqM: null,
    floor: null,
  });
  // The comma-separated shape still leads with a location.
  assert.deepEqual(parseDetails("Кентрон, 4 ком., 97 кв.м., 9/11 этаж"), {
    location: "Кентрон",
    rooms: 4,
    areaSqM: 97,
    floor: "9/11",
  });
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

test("only ad cards are candidates, whichever card shape the list publishes", () => {
  // Pagination and the advertising banners List.am places between the cards
  // live in the same list container as the cards themselves. Counting them as
  // candidates makes each one an unresolvable identity, and a single such
  // rejection fails the whole crawl.
  const diagnostics = parseRegularApartments(`
    <div id="contentr">
      <div id="tp">
        <a class="category-data-list-card__destination" href="/item/9">Top</a>
      </div>
      <div class="dl">
        <a class="category-data-list-card__destination" href="/ru/item/11">
          <div class="l">Кентрон</div>
        </a>
        <a class="fav-item-info-container" href="/ru/item/12">Older shape</a>
        <a class="list-ads-banner-link" href="https://sponsor.example/x">Ad</a>
        <div class="dlf">
          <span class="pp"><a href="/category/56/2">2</a></span>
        </div>
      </div>
    </div>`);

  assert.equal(diagnostics.candidateCount, 2);
  assert.equal(diagnostics.rejectedCount, 0);
  assert.deepEqual(
    diagnostics.apartments.map(({ itemId }) => itemId),
    ["11", "12"],
  );
});

test("a card whose identity cannot be resolved is still counted as rejected", () => {
  const diagnostics = parseRegularApartments(`
    <div id="contentr">
      <a class="category-data-list-card__destination" href="/ru/item/11">Ok</a>
      <a class="category-data-list-card__destination">Identityless</a>
      <a class="category-data-list-card__destination" href="/profile/7">Other</a>
    </div>`);

  assert.equal(diagnostics.candidateCount, 3);
  assert.equal(diagnostics.rejectedCount, 2);
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

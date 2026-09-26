import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseRegularApartments } from "../src/list-am.js";

const binary = process.env.RENTAL_APP_BINARY;
function contract(input) {
  const result = spawnSync(binary, ["contract"], {
    input: `${JSON.stringify(input)}\n`,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

test(
  "Rust source parsing agrees with the independent production Node parser",
  { skip: !binary },
  () => {
    for (const file of ["regular-page.html", "regular-page-redesign.html"]) {
      const html = readFileSync(
        new URL(`fixtures/list-am-real-shape/${file}`, import.meta.url),
        "utf8",
      );
      assert.deepEqual(
        contract({
          op: "parse",
          html,
          kind: "apartment",
          referenceMs: Date.now(),
        }),
        parseRegularApartments(html),
      );
    }
  },
);

import {
  postingDateSortValue,
  postingDateIndex,
  formatPostingDate,
} from "../src/posting-date.js";
import { parsePrice } from "../src/list-am.js";
import { normalizeApartmentPrice } from "../src/prices.js";
import {
  normalizeFilters,
  apartmentMatchesFilters,
  parseRangeInput,
} from "../src/filters.js";
import { formatApartmentMessage } from "../src/telegram.js";
import {
  formatChannelApartmentMessage,
  parseChannelFilters,
} from "../src/channel.js";
import { parseCbaExchangeRates } from "../src/exchange-rates.js";

const referenceMs = Date.parse("2026-01-01T12:00:00Z");
test(
  "Rust preserves calendar ordering, year inference and stable undated stamps",
  { skip: !binary },
  () => {
    for (const value of [
      null,
      "",
      "Сегодня, 00:00",
      "Вчера, 23:59",
      "today, 25:00",
      "Декабрь 31",
      "Январь 03",
      "Февраль 29",
      "February 29",
      "Пятница, Июль 24, 2026, 14:31",
      "Monday, January 01, 2026, 00:00",
      "Пятница, Февраль 30, 2026, 14:31",
    ]) {
      assert.deepEqual(
        contract({ op: "date", value, referenceMs }),
        postingDateSortValue(value, referenceMs),
      );
      assert.deepEqual(
        contract({ op: "date", action: "index", value, referenceMs }),
        JSON.parse(JSON.stringify(postingDateIndex(value))),
      );
    }
    assert.equal(
      contract({ op: "date", action: "format", referenceMs }),
      formatPostingDate(referenceMs),
    );
  },
);

test(
  "Rust preserves source prices, filters and Russian private/channel rendering",
  { skip: !binary },
  () => {
    const rates = {
      fetchedAt: "2026-01-01T12:00:00.000Z",
      effectiveDate: "2025-12-31",
      rates: {
        USD: { amount: 1, rate: 390.25 },
        EUR: { amount: 1, rate: 422.5 },
        RUB: { amount: 100, rate: 425 },
      },
    };
    for (const value of [
      "200 000 ֏",
      "$1,200",
      "1.234,50 EUR",
      "цена договорная",
      "25,3 ₽",
      "0 AMD",
    ]) {
      const price = parsePrice(value);
      assert.deepEqual(contract({ op: "price", value }), price);
      assert.deepEqual(
        contract({ op: "price", price, rates }),
        normalizeApartmentPrice(price, rates),
      );
    }
    for (const filters of [
      null,
      {},
      {
        kinds: ["house", "apartment", "house"],
        price: { min: 0, max: 250000 },
        rooms: { min: 2 },
        locations: ["p:0:6", "r:0", "garbage"],
      },
      { kinds: ["bad"], locations: ["p:0:6"] },
    ]) {
      assert.deepEqual(
        contract({ op: "filters", filters }),
        normalizeFilters(filters),
      );
      for (const apartment of [
        {
          kind: "house",
          price: { amount: 100000, currency: "AMD" },
          rooms: 3,
          location: "Ереван / Кентрон",
        },
        {
          kind: "bad",
          price: { amountAmd: 150000 },
          rooms: 2,
          location: "Кентрон",
        },
      ])
        assert.equal(
          contract({ op: "filters", action: "match", filters, apartment }),
          apartmentMatchesFilters(apartment, filters),
        );
    }
    for (const value of [
      "100000-250000",
      "100000-",
      "-250000",
      " 2 — 4 ",
      "нет",
      "0",
    ])
      assert.deepEqual(
        contract({ op: "filters", action: "range", value, kind: "price" }),
        parseRangeInput(value, "price"),
      );
    const apartments = [
      {
        itemId: "12",
        url: "https://www.list.am/ru/item/12",
        kind: "house",
        price: normalizeApartmentPrice(
          { amount: 1200.5, currency: "USD" },
          rates,
        ),
        rooms: 3,
        areaSqM: 65.5,
        location: "Ереван, Кентрон",
        floor: "2/4",
      },
      {
        itemId: "13",
        url: "https://www.list.am/ru/item/13",
        price: { amount: 0, currency: "AMD" },
        location: "неизвестное место",
      },
    ];
    for (const apartment of apartments) {
      assert.equal(
        contract({ op: "format", apartment }),
        formatApartmentMessage(apartment),
      );
      assert.equal(
        contract({ op: "format", apartment, channel: true }),
        formatChannelApartmentMessage(apartment),
      );
    }
    for (const filters of [
      {},
      {
        price: "100000-",
        rooms: "2-4",
        locations: "region:Котайк,place:Кентрон",
      },
      { locations: "all" },
    ])
      assert.deepEqual(
        contract({ op: "filters", action: "channel", ...filters }),
        parseChannelFilters(filters),
      );
  },
);

test(
  "Rust validates CBA rates and complete source pages against the Node oracle",
  { skip: !binary },
  () => {
    const xml =
      "<soap:Envelope xmlns:soap='http://schemas.xmlsoap.org/soap/envelope/'><soap:Body><ExchangeRatesLatestResponse><ExchangeRatesLatestResult><CurrentDate>2026-01-01T00:00:00</CurrentDate><Rates><ExchangeRate><ISO>USD</ISO><Amount>1</Amount><Rate>390,25</Rate></ExchangeRate><ExchangeRate><ISO>EUR</ISO><Amount>1</Amount><Rate>420.5</Rate></ExchangeRate><ExchangeRate><ISO>RUB</ISO><Amount>100</Amount><Rate>425</Rate></ExchangeRate></Rates></ExchangeRatesLatestResult></ExchangeRatesLatestResponse></soap:Body></soap:Envelope>";
    const fetchedAt = "2026-01-01T12:00:00.000Z";
    assert.deepEqual(
      contract({ op: "rates", xml, fetchedAt }),
      parseCbaExchangeRates(xml, fetchedAt),
    );
    for (const html of [
      '<div id="contentr"></div>',
      '<div id="contentr"><a class="category-data-list-card__destination" href="https://evil.test/ru/item/1"><div class="dltitle">Title</div></a></div>',
      '<div id="contentr"><a class="fav-item-info-container" href="/ru/item/01?foo=bar"><div class="dltitle">Дом</div><div class="at">Кентрон, 3 ком., 100 кв.м., 2/4 этаж</div><div class="p">150 000 ֏</div></a><div id="tp"><a class="fav-item-info-container" href="/ru/item/2">Top</a></div><a class="fav-item-info-container" href="/ru/item/01">Duplicate</a></div>',
    ])
      assert.deepEqual(
        contract({ op: "parse", html, referenceMs }),
        parseRegularApartments(html),
      );
  },
);

import { evaluateListAmSourceIntegrity } from "../src/source-integrity.js";
test(
  "Rust source integrity failures follow production precedence and count-drop rules",
  { skip: !binary },
  () => {
    const base = {
      apartments: [],
      candidateCount: 4,
      uniqueCandidateCount: 4,
      parsedCount: 4,
      duplicateCount: 0,
      rejectedCount: 0,
      completeness: {
        title: 4,
        date: 0,
        price: 0,
        location: 0,
        rooms: 0,
        areaSqM: 0,
        floor: 0,
      },
    };
    for (const [diagnostics, page, priorFirstPageCounts] of [
      [{ ...base, candidateCount: 0 }, 1, []],
      [{ ...base, parsedCount: 3, rejectedCount: 1 }, 1, []],
      [{ ...base, rejectedCount: 1 }, 2, []],
      [{ ...base, completeness: { ...base.completeness, title: 3 } }, 1, []],
      [base, 1, [12, 14, 16]],
      [base, 1, [7, 8, 9]],
      [base, 2, [12, 14, 16]],
    ]) {
      let expected;
      try {
        expected = evaluateListAmSourceIntegrity(diagnostics, {
          page,
          priorFirstPageCounts,
        });
      } catch (error) {
        expected = { error: error.message };
      }
      assert.deepEqual(
        contract({ op: "integrity", diagnostics, page, priorFirstPageCounts }),
        expected,
      );
    }
  },
);

test(
  "Rust rejects malformed range inputs and noncanonical location IDs like Node",
  { skip: !binary },
  () => {
    const filters = {
      locations: ["r:00", "p:0:06", "r:+1", "p:0:6", "r:1:extra"],
    };
    assert.deepEqual(
      contract({ op: "filters", filters }),
      normalizeFilters(filters),
    );
    for (const kind of ["price", "rooms"])
      for (const value of [
        "-",
        "nope",
        "1.5",
        "1-2-3",
        "9007199254740992",
        "0",
        "3-2",
      ]) {
        let expected;
        try {
          expected = parseRangeInput(value, kind);
        } catch (error) {
          expected = { error: error.message };
        }
        assert.deepEqual(
          contract({ op: "filters", action: "range", kind, value }),
          expected,
        );
      }
  },
);

test(
  "Rust renders parsed numeric listing fields without floating-point suffixes",
  { skip: !binary },
  () => {
    const html =
      '<div id="contentr"><a class="fav-item-info-container" href="/item/42"><div class="dltitle">Квартира</div><div class="p">150000 AMD</div><div class="at">Кентрон, 2 ком., 50 кв.м., 2/4 этаж</div></a></div>';
    const apartment = parseRegularApartments(html).apartments[0];
    const nativeApartment = contract({ op: "parse", html, referenceMs })
      .apartments[0];
    assert.equal(
      contract({ op: "format", apartment: nativeApartment }),
      formatApartmentMessage(apartment),
    );
  },
);

test(
  "Rust location matching normalizes Unicode separators before selection",
  { skip: !binary },
  () => {
    const apartment = {
      itemId: "42",
      kind: "apartment",
      location: "Ереван／Кентрон",
      price: { amountAmd: 150000 },
      rooms: 2,
    };
    const filters = { locations: ["p:0:6"] };
    assert.equal(
      contract({ op: "filters", action: "match", apartment, filters }),
      apartmentMatchesFilters(apartment, filters),
    );
    assert.equal(
      contract({
        op: "format",
        apartment: { ...apartment, url: "x" },
        channel: true,
      }),
      formatChannelApartmentMessage({ ...apartment, url: "x" }),
    );
  },
);

test(
  "Rust CBA XML preserves case-sensitive result names",
  { skip: !binary },
  () => {
    const xml =
      "<exchangerateslatestresult><CurrentDate>2026-01-01</CurrentDate></exchangerateslatestresult>";
    let expected;
    try {
      expected = parseCbaExchangeRates(xml, "2026-01-01T00:00:00.000Z");
    } catch (error) {
      expected = { error: error.message };
    }
    assert.deepEqual(
      contract({ op: "rates", xml, fetchedAt: "2026-01-01T00:00:00.000Z" }),
      expected,
    );
  },
);

import assert from "node:assert/strict";
import test from "node:test";

import {
  ExchangeRateService,
  parseCbaExchangeRates,
} from "../src/exchange-rates.js";

function cbaResponse({
  date = "2026-07-24T00:00:00",
  usd = 365.87,
  eur = 416.43,
  rub = 4.6763,
} = {}) {
  return `<?xml version="1.0" encoding="utf-8"?>
    <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
      <soap:Body>
        <ExchangeRatesLatestResponse xmlns="http://www.cba.am/">
          <ExchangeRatesLatestResult>
            <CurrentDate>${date}</CurrentDate>
            <Rates>
              <ExchangeRate><ISO>USD</ISO><Amount>1</Amount><Rate>${usd}</Rate></ExchangeRate>
              <ExchangeRate><ISO>EUR</ISO><Amount>1</Amount><Rate>${eur}</Rate></ExchangeRate>
              <ExchangeRate><ISO>RUB</ISO><Amount>1</Amount><Rate>${rub}</Rate></ExchangeRate>
              <ExchangeRate><ISO>GBP</ISO><Amount>1</Amount><Rate>480</Rate></ExchangeRate>
            </Rates>
          </ExchangeRatesLatestResult>
        </ExchangeRatesLatestResponse>
      </soap:Body>
    </soap:Envelope>`;
}

test("CBA response parser extracts one validated AMD snapshot", () => {
  const snapshot = parseCbaExchangeRates(
    cbaResponse(),
    "2026-07-24T09:15:00.000Z",
  );

  assert.deepEqual(snapshot, {
    version: 1,
    type: "cba-exchange-rates",
    baseCurrency: "AMD",
    fetchedAt: "2026-07-24T09:15:00.000Z",
    effectiveDate: "2026-07-24",
    rates: {
      USD: { amount: 1, rate: 365.87 },
      EUR: { amount: 1, rate: 416.43 },
      RUB: { amount: 1, rate: 4.6763 },
    },
  });
  assert.throws(
    () =>
      parseCbaExchangeRates(
        cbaResponse().replace(
          "<ExchangeRate><ISO>EUR</ISO><Amount>1</Amount><Rate>416.43</Rate></ExchangeRate>",
          "",
        ),
        "2026-07-24T09:15:00.000Z",
      ),
    /missing valid USD, EUR, or RUB rates/,
  );
});

test("rate service persists daily refreshes and retries failures hourly", async () => {
  let currentTime = new Date("2026-07-24T09:00:00.000Z");
  let stored;
  let fetchCalls = 0;
  const errors = [];
  const responses = [
    new Response(cbaResponse()),
    new Error("CBA unavailable"),
    new Response(
      cbaResponse({
        date: "2026-07-25T00:00:00",
        usd: 366,
        eur: 417,
        rub: 4.7,
      }),
    ),
  ];
  const service = new ExchangeRateService(
    {
      exchangeRatesStateFile: "/state/exchange-rates.json",
      timeoutMs: 1_000,
    },
    {
      fetchImpl: async () => {
        fetchCalls += 1;
        const response = responses.shift();
        if (response instanceof Error) throw response;
        return response;
      },
      loadState: async () => structuredClone(stored),
      saveState: async (_filename, value) => {
        stored = structuredClone(value);
      },
      now: () => currentTime,
      onFetchError: (error) => errors.push(error.message),
    },
  );

  const initial = await service.getSnapshot();
  assert.equal(initial.rates.USD.rate, 365.87);
  assert.equal(stored.fetchedAt, "2026-07-24T09:00:00.000Z");
  assert.equal(fetchCalls, 1);

  currentTime = new Date("2026-07-25T08:59:00.000Z");
  assert.equal((await service.getSnapshot()).rates.USD.rate, 365.87);
  assert.equal(fetchCalls, 1);

  currentTime = new Date("2026-07-25T09:00:00.000Z");
  assert.equal((await service.getSnapshot()).rates.USD.rate, 365.87);
  assert.deepEqual(errors, ["CBA unavailable"]);
  assert.equal(fetchCalls, 2);

  currentTime = new Date("2026-07-25T09:59:00.000Z");
  await service.getSnapshot();
  assert.equal(fetchCalls, 2);

  currentTime = new Date("2026-07-25T10:00:00.000Z");
  const refreshed = await service.getSnapshot();
  assert.equal(refreshed.rates.USD.rate, 366);
  assert.equal(refreshed.fetchedAt, "2026-07-25T10:00:00.000Z");
  assert.equal(fetchCalls, 3);
});

test("rate service reuses a fresh persisted snapshot after restart", async () => {
  const persisted = parseCbaExchangeRates(
    cbaResponse(),
    "2026-07-24T09:15:00.000Z",
  );
  const service = new ExchangeRateService(
    {
      exchangeRatesStateFile: "/state/exchange-rates.json",
      timeoutMs: 1_000,
    },
    {
      fetchImpl: async () => {
        throw new Error("A fresh snapshot should not trigger a request");
      },
      loadState: async () => persisted,
      now: () => new Date("2026-07-24T10:00:00.000Z"),
    },
  );

  assert.deepEqual(await service.getSnapshot(), persisted);
});

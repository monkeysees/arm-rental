import assert from "node:assert/strict";
import test from "node:test";

import {
  amdPriceAmount,
  normalizeApartmentPrice,
  originalPrice,
} from "../src/prices.js";

const exchangeRates = {
  fetchedAt: "2026-07-24T09:15:00.000Z",
  effectiveDate: "2026-07-24",
  rates: {
    USD: { amount: 1, rate: 365.87 },
    EUR: { amount: 1, rate: 416.43 },
    RUB: { amount: 1, rate: 4.6763 },
  },
};

test("foreign prices are converted to whole AMD with auditable source data", () => {
  assert.deepEqual(
    normalizeApartmentPrice({ amount: 1_600, currency: "$" }, exchangeRates),
    {
      amountAmd: 585_392,
      originalAmount: 1_600,
      originalCurrency: "USD",
      exchangeRate: 365.87,
      exchangeRateFetchedAt: "2026-07-24T09:15:00.000Z",
      exchangeRateEffectiveDate: "2026-07-24",
    },
  );
  assert.equal(
    normalizeApartmentPrice({ amount: 25_000, currency: "₽" }, exchangeRates)
      .amountAmd,
    116_908,
  );
});

test("AMD and missing prices do not receive exchange-rate metadata", () => {
  const amd = normalizeApartmentPrice(
    { amount: 290_000, currency: "֏" },
    exchangeRates,
  );
  assert.deepEqual(amd, {
    amountAmd: 290_000,
    originalAmount: 290_000,
    originalCurrency: "AMD",
    exchangeRate: null,
    exchangeRateFetchedAt: null,
    exchangeRateEffectiveDate: null,
  });
  assert.deepEqual(originalPrice(amd), { amount: 290_000, currency: "֏" });
  assert.equal(amdPriceAmount(amd), 290_000);

  assert.equal(
    normalizeApartmentPrice({ amount: null, currency: null }, exchangeRates)
      .amountAmd,
    null,
  );
});

test("normalization requires a supported persisted rate", () => {
  assert.throws(
    () =>
      normalizeApartmentPrice({ amount: 1_000, currency: "£" }, exchangeRates),
    /No persisted CBA exchange rate is available for GBP/,
  );
});

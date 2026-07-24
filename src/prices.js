const CURRENCY_CODES = new Map([
  ["֏", "AMD"],
  ["AMD", "AMD"],
  ["$", "USD"],
  ["USD", "USD"],
  ["€", "EUR"],
  ["EUR", "EUR"],
  ["₽", "RUB"],
  ["RUB", "RUB"],
  ["£", "GBP"],
  ["GBP", "GBP"],
]);

const CURRENCY_SYMBOLS = new Map([
  ["AMD", "֏"],
  ["USD", "$"],
  ["EUR", "€"],
  ["RUB", "₽"],
  ["GBP", "£"],
]);

function optionalAmount(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function currencyCode(value) {
  return (
    CURRENCY_CODES.get(
      String(value || "")
        .trim()
        .toUpperCase(),
    ) || null
  );
}

export function currencySymbol(value) {
  const code = currencyCode(value);
  return CURRENCY_SYMBOLS.get(code) || value || null;
}

export function normalizeApartmentPrice(price, exchangeRates) {
  if (Object.hasOwn(price || {}, "amountAmd")) return price;

  const originalAmount = optionalAmount(price?.amount);
  const originalCurrency = currencyCode(price?.currency);
  const normalized = {
    amountAmd: null,
    originalAmount,
    originalCurrency,
    exchangeRate: null,
    exchangeRateFetchedAt: null,
    exchangeRateEffectiveDate: null,
  };

  if (originalAmount === null || originalCurrency === null) return normalized;
  if (originalCurrency === "AMD") {
    return { ...normalized, amountAmd: Math.round(originalAmount) };
  }

  const quote = exchangeRates?.rates?.[originalCurrency];
  if (!quote) {
    throw new Error(
      `No persisted CBA exchange rate is available for ${originalCurrency}`,
    );
  }
  if (
    !Number.isFinite(quote.amount) ||
    quote.amount <= 0 ||
    !Number.isFinite(quote.rate) ||
    quote.rate <= 0
  ) {
    throw new Error(`The persisted CBA ${originalCurrency} rate is invalid`);
  }

  const unitRate = quote.rate / quote.amount;
  return {
    ...normalized,
    amountAmd: Math.round(originalAmount * unitRate),
    exchangeRate: unitRate,
    exchangeRateFetchedAt: exchangeRates.fetchedAt,
    exchangeRateEffectiveDate: exchangeRates.effectiveDate,
  };
}

export function originalPrice(price) {
  if (Object.hasOwn(price || {}, "originalAmount")) {
    return {
      amount: price.originalAmount,
      currency: currencySymbol(price.originalCurrency),
    };
  }

  return {
    amount: price?.amount ?? null,
    currency: price?.currency ?? null,
  };
}

export function amdPriceAmount(price) {
  if (Number.isFinite(price?.amountAmd)) return price.amountAmd;
  return currencyCode(price?.currency) === "AMD" &&
    Number.isFinite(price?.amount)
    ? price.amount
    : null;
}

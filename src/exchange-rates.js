import * as cheerio from "cheerio";

import { readState, writeState } from "./state.js";

const CBA_API_URL = "https://api.cba.am/exchangerates.asmx";
const CBA_SOAP_ACTION = "http://www.cba.am/ExchangeRatesLatest";
const REQUIRED_CURRENCIES = ["USD", "EUR", "RUB"];
const DAY_MS = 24 * 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;

const SOAP_REQUEST = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <ExchangeRatesLatest xmlns="http://www.cba.am/" />
  </soap:Body>
</soap:Envelope>`;

function numericValue(value) {
  const parsed = Number(
    String(value || "")
      .trim()
      .replace(",", "."),
  );
  return Number.isFinite(parsed) ? parsed : null;
}

export function compatibleExchangeRateSnapshot(value) {
  return Boolean(
    value &&
      value.version === 1 &&
      value.type === "cba-exchange-rates" &&
      value.baseCurrency === "AMD" &&
      !Number.isNaN(Date.parse(value.fetchedAt)) &&
      /^\d{4}-\d{2}-\d{2}$/u.test(value.effectiveDate) &&
      REQUIRED_CURRENCIES.every((currency) => {
        const quote = value.rates?.[currency];
        return (
          Number.isFinite(quote?.amount) &&
          quote.amount > 0 &&
          Number.isFinite(quote?.rate) &&
          quote.rate > 0
        );
      }),
  );
}

function requestSignal(signal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

export function parseCbaExchangeRates(xml, fetchedAt) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const result = $("ExchangeRatesLatestResult").first();
  if (result.length === 0) {
    throw new Error("CBA exchange-rate response did not contain a result");
  }

  const currentDate = result.find("CurrentDate").first().text().trim();
  const effectiveDate = /^\d{4}-\d{2}-\d{2}/u.test(currentDate)
    ? currentDate.slice(0, 10)
    : null;
  if (!effectiveDate) {
    throw new Error("CBA exchange-rate response had an invalid effective date");
  }

  const rates = {};
  result.find("ExchangeRate").each((_index, element) => {
    const entry = $(element);
    const iso = entry.find("ISO").first().text().trim().toUpperCase();
    if (!REQUIRED_CURRENCIES.includes(iso)) return;
    rates[iso] = {
      amount: numericValue(entry.find("Amount").first().text()),
      rate: numericValue(entry.find("Rate").first().text()),
    };
  });

  const snapshot = {
    version: 1,
    type: "cba-exchange-rates",
    baseCurrency: "AMD",
    fetchedAt,
    effectiveDate,
    rates,
  };
  if (!compatibleExchangeRateSnapshot(snapshot)) {
    throw new Error(
      "CBA exchange-rate response was missing valid USD, EUR, or RUB rates",
    );
  }
  return snapshot;
}

export class ExchangeRateService {
  constructor(
    config,
    {
      fetchImpl = globalThis.fetch,
      loadState = readState,
      saveState = writeState,
      now = () => new Date(),
      refreshMs = DAY_MS,
      retryMs = HOUR_MS,
      onRefresh = () => {},
      onFetchError = () => {},
    } = {},
  ) {
    this.stateFile = config.exchangeRatesStateFile;
    this.timeoutMs = config.timeoutMs || 30_000;
    this.fetchImpl = fetchImpl;
    this.loadState = loadState;
    this.saveState = saveState;
    this.now = now;
    this.refreshMs = refreshMs;
    this.retryMs = retryMs;
    this.onRefresh = onRefresh;
    this.onFetchError = onFetchError;
    this.loaded = false;
    this.snapshot = undefined;
    this.nextAttemptAt = 0;
    this.pending = undefined;
  }

  async load() {
    if (this.loaded) return;
    const stored = await this.loadState(this.stateFile);
    this.snapshot = compatibleExchangeRateSnapshot(stored) ? stored : undefined;
    this.nextAttemptAt = this.snapshot
      ? Date.parse(this.snapshot.fetchedAt) + this.refreshMs
      : 0;
    this.loaded = true;
  }

  async fetchSnapshot(signal) {
    const response = await this.fetchImpl(CBA_API_URL, {
      method: "POST",
      headers: {
        "content-type": "text/xml; charset=utf-8",
        soapaction: `"${CBA_SOAP_ACTION}"`,
      },
      body: SOAP_REQUEST,
      signal: requestSignal(signal, this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(
        `CBA exchange-rate request failed: ${response.status} ${response.statusText}`,
      );
    }

    const fetchedAt = this.now().toISOString();
    return parseCbaExchangeRates(await response.text(), fetchedAt);
  }

  async resolveSnapshot(signal) {
    await this.load();
    const attemptedAt = this.now().getTime();
    if (attemptedAt < this.nextAttemptAt) return this.snapshot;

    try {
      const snapshot = await this.fetchSnapshot(signal);
      await this.saveState(this.stateFile, snapshot);
      this.snapshot = snapshot;
      this.nextAttemptAt = Date.parse(snapshot.fetchedAt) + this.refreshMs;
      await this.onRefresh(snapshot);
    } catch (error) {
      if (signal?.aborted) throw error;
      this.nextAttemptAt = attemptedAt + this.retryMs;
      await this.onFetchError(error, this.snapshot);
      if (!this.snapshot) throw error;
    }

    return this.snapshot;
  }

  getSnapshot(signal) {
    if (!this.pending) {
      this.pending = this.resolveSnapshot(signal).finally(() => {
        this.pending = undefined;
      });
    }
    return this.pending;
  }
}

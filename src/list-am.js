import * as cheerio from "cheerio";
import { postingDateSortValue } from "./posting-date.js";

const LIST_AM_ORIGIN = "https://www.list.am";
const ITEM_PATH = /^\/(?:[a-z]{2}\/)?item\/(\d+)\/?$/u;
const PRICE_NUMBER = /\d[\d\s.,]*/u;
const CURRENCIES = ["֏", "$", "€", "₽", "£", "AMD", "USD", "EUR", "RUB", "GBP"];

function normalizeText(value = "") {
  return value.replace(/\s+/gu, " ").trim();
}

function numericValue(value) {
  if (!value) return null;
  const normalized = value.replace(/[^\d.,]/gu, "");
  const decimal = normalized.match(/[.,](\d{1,2})$/u);
  const digits = normalized.replace(/[^\d]/gu, "");
  if (!digits) return null;

  if (!decimal) return Number(digits);
  const wholeDigits = digits.slice(0, -decimal[1].length) || "0";
  return Number(`${wholeDigits}.${decimal[1]}`);
}

export function parsePrice(value) {
  const text = normalizeText(value);
  const numberText = text.match(PRICE_NUMBER)?.[0];
  const currency = CURRENCIES.find((candidate) => text.includes(candidate));

  return {
    amount: numericValue(numberText),
    currency: currency || null,
  };
}

export function parseDetails(value) {
  const text = normalizeText(value);
  const [location = "", roomsText = "", areaText = "", floorText = ""] = text
    .split(",")
    .map((part) => part.trim());
  const rooms = roomsText.match(/\d+/u)?.[0];
  const area = areaText.match(/[\d.,]+/u)?.[0];
  const floor = floorText.match(/(\d+)\s*\/\s*(\d+)/u);

  return {
    location: location.trim(),
    rooms: rooms ? Number(rooms) : null,
    areaSqM: numericValue(area),
    floor: floor ? `${floor[1]}/${floor[2]}` : null,
  };
}

function regularCards($) {
  const $section = $("#contentr").first();
  if ($section.length === 0) {
    throw new Error("Could not find the List.am Regular Ads section");
  }

  const outsideTopAds = (_index, element) =>
    $(element).closest("#tp").length === 0;
  const $primary = $section
    .find("a.fav-item-info-container")
    .filter(outsideTopAds);
  if ($primary.length > 0) return $primary;
  return $section.find(".dl a").filter(outsideTopAds);
}

function canonicalItemId(href) {
  if (typeof href !== "string" || href.trim() === "") return null;
  try {
    const url = new URL(href.trim(), LIST_AM_ORIGIN);
    if (url.origin !== LIST_AM_ORIGIN) return null;
    return url.pathname.match(ITEM_PATH)?.[1] || null;
  } catch {
    return null;
  }
}

function usableNumber(value) {
  return Number.isFinite(value);
}

function completenessFor(apartments) {
  const completeness = {
    title: 0,
    date: 0,
    price: 0,
    location: 0,
    rooms: 0,
    areaSqM: 0,
    floor: 0,
  };

  for (const apartment of apartments) {
    if (apartment.title) completeness.title += 1;
    if (postingDateSortValue(apartment.date) !== null) completeness.date += 1;
    if (
      usableNumber(apartment.price.amount) &&
      apartment.price.currency !== null
    ) {
      completeness.price += 1;
    }
    if (apartment.location) completeness.location += 1;
    if (usableNumber(apartment.rooms)) completeness.rooms += 1;
    if (usableNumber(apartment.areaSqM)) completeness.areaSqM += 1;
    if (apartment.floor) completeness.floor += 1;
  }

  return completeness;
}

export function parseRegularApartments(html) {
  const $ = cheerio.load(html);
  const apartments = [];
  const ids = new Set();
  let candidateCount = 0;
  let duplicateCount = 0;
  let rejectedCount = 0;

  regularCards($).each((_index, element) => {
    candidateCount += 1;
    const $card = $(element);
    const id = canonicalItemId($card.attr("href"));
    if (!id) {
      rejectedCount += 1;
      return;
    }
    if (ids.has(id)) {
      duplicateCount += 1;
      return;
    }

    const details = parseDetails($card.find(".at").first().text());
    ids.add(id);
    apartments.push({
      url: `https://www.list.am/ru/item/${id}`,
      itemId: id,
      title: normalizeText(
        $card.find(".dltitle .pt, .l, .dltitle, .pt").first().text(),
      ),
      price: parsePrice($card.find(".p").first().text()),
      ...details,
      date: normalizeText($card.find(".d").first().text()) || null,
    });
  });

  return {
    apartments,
    candidateCount,
    uniqueCandidateCount: ids.size,
    parsedCount: apartments.length,
    duplicateCount,
    rejectedCount,
    completeness: completenessFor(apartments),
  };
}

/** Compatibility wrapper for callers that need only normalized apartments. */
export function extractRegularApartments(html) {
  return parseRegularApartments(html).apartments;
}

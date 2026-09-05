import * as cheerio from "cheerio";
import { postingDateSortValue } from "./posting-date.js";

const LIST_AM_ORIGIN = "https://www.list.am";
export const REGULAR_SECTION_MISSING_CODE =
  "ERR_LIST_AM_REGULAR_SECTION_MISSING";
const ITEM_PATH = /^\/(?:[a-z]{2}\/)?item\/(\d+)\/?$/u;
const PRICE_NUMBER = /\d[\d\s.,]*/u;
const CURRENCIES = ["֏", "$", "€", "₽", "£", "AMD", "USD", "EUR", "RUB", "GBP"];

/**
 * The anchors List.am wraps a whole ad card in. The redesigned list publishes
 * the first class; the second is the shape the categories carried before it.
 */
export const CARD_SELECTOR =
  "a.category-data-list-card__destination, a.fav-item-info-container";

const ROOMS_ATTRIBUTE = /(\d+)\s*(?:ком|room)/iu;
const AREA_ATTRIBUTE = /([\d.,]+)\s*(?:кв|sq)/iu;
const FLOOR_ATTRIBUTE = /(\d+)\s*\/\s*(\d+)/u;

function attributeLike(value) {
  return (
    ROOMS_ATTRIBUTE.test(value) ||
    AREA_ATTRIBUTE.test(value) ||
    FLOOR_ATTRIBUTE.test(value)
  );
}

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

/**
 * Reads a card's attribute line, which names some of rooms, area, and floor.
 *
 * The redesigned card separates attributes with "·" and states no location;
 * the older shape is comma separated and leads with one. Each attribute is
 * therefore matched by what it says rather than by its position, so a card
 * that omits one — houses routinely publish no area or floor — still yields
 * the rest.
 */
export function parseDetails(value) {
  const text = normalizeText(value);
  const rooms = text.match(ROOMS_ATTRIBUTE)?.[1];
  const area = text.match(AREA_ATTRIBUTE)?.[1];
  const floor = text.match(FLOOR_ATTRIBUTE);
  const [leading = ""] = text.split(/[,·]/u);

  return {
    // A leading segment that is itself an attribute is never a location.
    location: attributeLike(leading) ? "" : leading.trim(),
    rooms: rooms ? Number(rooms) : null,
    areaSqM: numericValue(area),
    floor: floor ? `${floor[1]}/${floor[2]}` : null,
  };
}

function regularCards($) {
  const $section = $("#contentr").first();
  if ($section.length === 0) {
    const error = new Error("Could not find the List.am Regular Ads section");
    error.code = REGULAR_SECTION_MISSING_CODE;
    throw error;
  }

  const outsideTopAds = (_index, element) =>
    $(element).closest("#tp").length === 0;
  // Only an ad card counts as a candidate. Selecting every anchor in the list
  // container instead would sweep in pagination and the advertising banners
  // List.am places between the cards, and each of those reads as a card whose
  // identity cannot be resolved — the shape that stops a crawl outright.
  return $section.find(CARD_SELECTOR).filter(outsideTopAds);
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
    // The redesigned card publishes the location in its own element and keeps
    // the attribute line for rooms, area, and floor alone.
    const location = normalizeText($card.find(".l").first().text());
    ids.add(id);
    apartments.push({
      url: `https://www.list.am/ru/item/${id}`,
      itemId: id,
      title: normalizeText(
        $card.find(".dltitle .pt, .dltitle, .pt").first().text(),
      ),
      price: parsePrice($card.find(".p").first().text()),
      ...details,
      ...(location ? { location } : {}),
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

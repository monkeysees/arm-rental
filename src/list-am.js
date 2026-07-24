import * as cheerio from "cheerio";

const ITEM_PATH = /\/(?:[a-z]{2}\/)?item\/(\d+)/u;
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

  let $cards = $section.find('a.fav-item-info-container[href*="/item/"]');
  $cards = $cards.filter(
    (_index, element) => $(element).closest("#tp").length === 0,
  );
  if ($cards.length === 0) {
    $cards = $section.find('.dl a[href*="/item/"]');
    $cards = $cards.filter(
      (_index, element) => $(element).closest("#tp").length === 0,
    );
  }

  return $cards;
}

export function extractRegularApartments(html) {
  const $ = cheerio.load(html);
  const apartments = [];
  const ids = new Set();

  regularCards($).each((_index, element) => {
    const $card = $(element);
    const id = ($card.attr("href") || "").match(ITEM_PATH)?.[1];
    if (!id || ids.has(id)) return;

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

  return apartments;
}

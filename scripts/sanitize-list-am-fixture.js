import { readFile, writeFile } from "node:fs/promises";

import * as cheerio from "cheerio";

import { CARD_SELECTOR } from "../src/list-am.js";

const REMOVED_ELEMENTS = [
  "script",
  "style",
  "form",
  "input",
  "textarea",
  "button",
  "svg",
  "img",
  "video",
  "audio",
  "link",
  "meta",
  "iframe",
  "object",
  "embed",
].join(",");

const STRUCTURAL_CLASSES = new Set([
  "at",
  "category-data-list-card__destination",
  "d",
  "dl",
  "dldetail",
  "dlf",
  "dltitle",
  "fav-item-info-container",
  "gl",
  "glheader",
  "gltitle",
  "l",
  // Retained so a fixture keeps the banner and pagination anchors List.am
  // places among the cards. They are what a card selector must not match.
  "list-ads-banner-link",
  "p",
  "pp",
  "pt",
]);
const SYNTHETIC_ITEM_ID_BASE = 999_999_990_000_000;

function safeClasses(value = "") {
  return value
    .split(/\s+/u)
    .filter((name) => STRUCTURAL_CLASSES.has(name))
    .join(" ");
}

/**
 * Retains the List.am container/card DOM shape while replacing all source
 * content and identity-bearing attributes with deterministic synthetic data.
 */
export function sanitizeListAmFixture(html) {
  const $ = cheerio.load(html);
  const $section = $("#contentr").first();
  if ($section.length === 0) {
    throw new Error(
      "Fixture source is missing the List.am Regular Ads section",
    );
  }

  // The shape of a card decides what synthetic content stands in for it, and
  // the source text that reveals it is discarded a few lines below.
  const cardShapes = new Map();
  $section.find(CARD_SELECTOR).each((_index, element) => {
    const $card = $(element);
    cardShapes.set(element, {
      attributesUseInterpunct: $card.find(".at").first().text().includes("·"),
      dateNamesADayOnly: !/\d{4}/u.test($card.find(".d").first().text()),
    });
  });

  $section.find(REMOVED_ELEMENTS).remove();
  $section
    .find("*")
    .addBack()
    .contents()
    .filter((_index, node) => node.type === "comment" || node.type === "text")
    .remove();

  $section
    .find("*")
    .addBack()
    .each((_index, element) => {
      const $element = $(element);
      const classes = safeClasses($element.attr("class"));
      const topAdsContainer = $element.attr("id") === "tp";
      for (const attribute of Object.keys(element.attribs || {})) {
        $element.removeAttr(attribute);
      }
      if (element === $section[0]) $element.attr("id", "contentr");
      if (element !== $section[0] && topAdsContainer) {
        $element.attr("id", "tp");
      }
      if (classes) $element.attr("class", classes);
    });

  const $cards = $section.find(CARD_SELECTOR);
  if ($cards.length > 999_999) {
    throw new Error("Fixture source exceeds the reserved synthetic ID range");
  }
  $cards.each((index, element) => {
    const $card = $(element);
    const promoted = $card.closest("#tp").length > 0;
    const fixtureIndex = index + 1;
    $card.attr("href", `/ru/item/${SYNTHETIC_ITEM_ID_BASE + fixtureIndex}`);
    const shape = cardShapes.get(element) || {};
    $card
      .find(".dltitle .pt, .dltitle, .pt")
      .first()
      .text(
        promoted
          ? `Sanitized promoted listing ${fixtureIndex}`
          : `Sanitized regular listing ${fixtureIndex}`,
      );
    $card
      .find(".p")
      .first()
      .text(`${200_000 + fixtureIndex * 10_000} ֏`);
    $card
      .find(".at")
      .first()
      .text(
        shape.attributesUseInterpunct
          ? "2 ком. · 60 кв.м. · 3/9 этаж"
          : "Sanitized district, 2 rooms, 60 sq.m., 3/9 floor",
      );
    $card.find(".l").first().text(`Sanitized district ${fixtureIndex}`);
    $card
      .find(".d")
      .first()
      .text(
        shape.dateNamesADayOnly
          ? "Июль 24"
          : `Friday, July 24, 2026, 14:${30 + fixtureIndex}`,
      );
  });

  return `<!doctype html>\n<html><body>${$.html($section)}</body></html>\n`;
}

async function main() {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    throw new Error(
      "Usage: node scripts/sanitize-list-am-fixture.js INPUT.html OUTPUT.html",
    );
  }
  const sanitized = sanitizeListAmFixture(await readFile(input, "utf8"));
  await writeFile(output, sanitized, { encoding: "utf8", mode: 0o600 });
}

if (import.meta.url === `file://${process.argv[1]}`) await main();

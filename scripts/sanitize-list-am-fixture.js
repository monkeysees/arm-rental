import { readFile, writeFile } from "node:fs/promises";

import * as cheerio from "cheerio";

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
  "d",
  "dl",
  "dldetail",
  "dltitle",
  "fav-item-info-container",
  "gl",
  "glheader",
  "gltitle",
  "l",
  "p",
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

  const $cards = $section.find("a.fav-item-info-container, .dl a");
  if ($cards.length > 999_999) {
    throw new Error("Fixture source exceeds the reserved synthetic ID range");
  }
  $cards.each((index, element) => {
    const $card = $(element);
    const promoted = $card.closest("#tp").length > 0;
    const fixtureIndex = index + 1;
    $card.attr("href", `/ru/item/${SYNTHETIC_ITEM_ID_BASE + fixtureIndex}`);
    $card
      .find(".dltitle .pt, .l, .dltitle, .pt")
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
      .text("Sanitized district, 2 rooms, 60 sq.m., 3/9 floor");
    $card
      .find(".d")
      .first()
      .text(`Friday, July 24, 2026, 14:${30 + fixtureIndex}`);
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

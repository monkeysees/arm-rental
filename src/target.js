import { APARTMENT, HOUSE } from "./property-kind.js";

export const LIST_AM_URL_TEMPLATE =
  "https://www.list.am/ru/category/56/{page}?n=0&cmtype=0&crc=0&gl=2&srt=3";

export const LIST_AM_HOUSE_URL_TEMPLATE =
  "https://www.list.am/ru/category/1377/{page}?n=0&cmtype=0&crc=0&gl=2&srt=3";

/**
 * The List.am categories a crawl reads, in the order it reads them.
 *
 * Each category is its own newest-first stream with its own pagination, so a
 * crawl walks them one after another and tags what it parses with the kind the
 * category publishes. The apartment template stays the installation's identity
 * — it is what the state database, the HTTP session, and the delivery
 * stores are bound to — so adding a category never rebinds stored state.
 */
export const LIST_AM_SOURCES = Object.freeze([
  Object.freeze({ kind: APARTMENT, urlTemplate: LIST_AM_URL_TEMPLATE }),
  Object.freeze({ kind: HOUSE, urlTemplate: LIST_AM_HOUSE_URL_TEMPLATE }),
]);

export function pageUrl(page, template = LIST_AM_URL_TEMPLATE) {
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new Error("List.am page must be a positive integer");
  }

  return template.replace("{page}", String(page));
}

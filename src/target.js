export const LIST_AM_URL_TEMPLATE =
  "https://www.list.am/ru/category/56/{page}?n=0&cmtype=0&crc=0&gl=2&srt=3";

export function pageUrl(page, template = LIST_AM_URL_TEMPLATE) {
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new Error("List.am page must be a positive integer");
  }

  return template.replace("{page}", String(page));
}

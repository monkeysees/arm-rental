/**
 * The kinds of housing this installation follows.
 *
 * List.am publishes long-term apartment and house rentals in two separate
 * categories, and a listing belongs to exactly the category it was crawled
 * from. The kind travels with the listing from the crawl that discovered it,
 * so filtering never has to re-derive it from the card's text.
 */
export const APARTMENT = "apartment";
export const HOUSE = "house";

export const PROPERTY_KINDS = Object.freeze([APARTMENT, HOUSE]);

/**
 * What a subscription follows unless the user says otherwise. Apartments were
 * the only kind this bot ever delivered, so they remain the default and every
 * subscription that predates houses keeps exactly the scope it had.
 */
export const DEFAULT_PROPERTY_KINDS = Object.freeze([APARTMENT]);

const KIND_SET = new Set(PROPERTY_KINDS);

/** Plural labels, for filter menus that name a whole group of listings. */
const PROPERTY_KIND_LABELS = Object.freeze({
  [APARTMENT]: "Квартиры",
  [HOUSE]: "Дома",
});

/** Singular labels, for messages that name one listing. */
const PROPERTY_KIND_TITLES = Object.freeze({
  [APARTMENT]: "Квартира",
  [HOUSE]: "Дом",
});

export function isPropertyKind(value) {
  return KIND_SET.has(value);
}

/**
 * The kind of a stored listing.
 *
 * Records written before houses existed carry no kind at all; they were all
 * apartments, so that is what an absent value means.
 */
export function propertyKindOf(listing) {
  return isPropertyKind(listing?.kind) ? listing.kind : APARTMENT;
}

/**
 * Normalizes a selection to a non-empty, deduplicated list in catalog order.
 *
 * An unusable selection — absent, malformed, or naming nothing this release
 * knows — falls back to the default rather than matching everything, because a
 * filter that silently widens would deliver listings the user never asked for.
 */
export function normalizePropertyKinds(value) {
  if (!Array.isArray(value)) return [...DEFAULT_PROPERTY_KINDS];
  const selected = new Set(value.filter(isPropertyKind));
  if (selected.size === 0) return [...DEFAULT_PROPERTY_KINDS];
  return PROPERTY_KINDS.filter((kind) => selected.has(kind));
}

export function propertyKindLabel(kind) {
  return PROPERTY_KIND_LABELS[kind] ?? PROPERTY_KIND_LABELS[APARTMENT];
}

export function propertyKindTitle(kind) {
  return PROPERTY_KIND_TITLES[kind] ?? PROPERTY_KIND_TITLES[APARTMENT];
}

/** Renders a selection the way the filter menus announce it. */
export function formatPropertyKinds(kinds) {
  const labels = normalizePropertyKinds(kinds).map(propertyKindLabel);
  return labels.length === 1
    ? labels[0]
    : `${labels.slice(0, -1).join(", ")} и ${labels.at(-1).toLocaleLowerCase("ru-RU")}`;
}

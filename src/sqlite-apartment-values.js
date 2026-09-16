import { parseStoredJson } from "./sqlite-repository-values.js";

export function storedApartment(row) {
  const apartment = parseStoredJson(row.payload_json, "apartment payload");
  if (row.last_seen_at !== null) apartment.lastSeenAt = row.last_seen_at;
  return apartment;
}

export function apartmentCandidates(rows) {
  return {
    apartments: Object.fromEntries(
      rows.map((row) => [row.item_id, storedApartment(row)]),
    ),
    apartmentOrder: rows.map((row) => row.item_id),
  };
}

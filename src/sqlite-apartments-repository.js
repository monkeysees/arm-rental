import {
  APARTMENT_STATE_VERSION,
  compatibleApartmentState,
} from "./apartment-state.js";
import {
  canonicalIsoTimestamp,
  nonEmptyIdentifier,
  parseStoredJson,
  runRepositoryTransaction,
  serializeJson,
} from "./sqlite-repository-values.js";

function validatedApartmentState(state, listUrlTemplate) {
  if (
    !compatibleApartmentState(state, listUrlTemplate) ||
    state.version !== APARTMENT_STATE_VERSION
  ) {
    throw new TypeError("Apartment state has an incompatible schema");
  }
  const apartmentIds = Object.keys(state.apartments);
  if (
    !Array.isArray(state.apartmentOrder) ||
    state.apartmentOrder.length !== apartmentIds.length
  ) {
    throw new TypeError(
      "Apartment order must contain every apartment exactly once",
    );
  }
  const order = state.apartmentOrder.map((itemId) =>
    nonEmptyIdentifier(itemId, "Apartment order item ID"),
  );
  if (
    new Set(order).size !== order.length ||
    order.some((itemId) => !Object.hasOwn(state.apartments, itemId))
  ) {
    throw new TypeError(
      "Apartment order must contain every apartment exactly once",
    );
  }
  for (const [itemId, apartment] of Object.entries(state.apartments)) {
    nonEmptyIdentifier(itemId, "Apartment item ID");
    if (
      !apartment ||
      typeof apartment !== "object" ||
      Array.isArray(apartment) ||
      String(apartment.itemId) !== itemId
    ) {
      throw new TypeError("Apartment payload item ID must match its state key");
    }
  }
  canonicalIsoTimestamp(state.checkedAt, "Apartment checkedAt");
  return state;
}

export class SqliteApartmentsRepository {
  constructor(database, { listUrlTemplate }) {
    this.database = database;
    this.listUrlTemplate = listUrlTemplate;
    this.selectMetadata = database.prepare(
      "SELECT * FROM crawl_state WHERE singleton = 1",
    );
    this.selectApartments = database.prepare(
      "SELECT item_id, payload_json FROM apartments",
    );
    this.upsertApartment =
      database.prepare(`INSERT INTO apartments(item_id, payload_json) VALUES (?, ?)
      ON CONFLICT(item_id) DO UPDATE SET payload_json = excluded.payload_json
      WHERE apartments.payload_json <> excluded.payload_json`);
    this.upsertCrawl = database.prepare(`INSERT INTO crawl_state(
      singleton, checked_at, last_crawl_json, apartment_order_json, source_integrity_json
    ) VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET
      checked_at = excluded.checked_at,
      last_crawl_json = excluded.last_crawl_json,
      apartment_order_json = excluded.apartment_order_json,
      source_integrity_json = excluded.source_integrity_json`);
    database.connection.exec(
      "CREATE TEMP TABLE IF NOT EXISTS crawl_present_items(item_id TEXT PRIMARY KEY) STRICT",
    );
    this.clearPresent = database.prepare("DELETE FROM crawl_present_items");
    this.insertPresent = database.prepare(
      "INSERT INTO crawl_present_items(item_id) VALUES (?)",
    );
    this.deleteAbsent = database.prepare(`DELETE FROM apartments
      WHERE NOT EXISTS (SELECT 1 FROM crawl_present_items present WHERE present.item_id = apartments.item_id)`);
  }

  load() {
    const metadata = this.selectMetadata.get();
    if (!metadata) return undefined;
    const apartments = Object.fromEntries(
      this.selectApartments
        .all()
        .map((row) => [
          row.item_id,
          parseStoredJson(row.payload_json, "apartment payload"),
        ]),
    );
    const state = {
      version: APARTMENT_STATE_VERSION,
      type: "list-am-apartments",
      urlTemplate: this.listUrlTemplate,
      checkedAt: metadata.checked_at,
      lastCrawl: parseStoredJson(
        metadata.last_crawl_json,
        "last crawl metadata",
      ),
      apartments,
      apartmentOrder: parseStoredJson(
        metadata.apartment_order_json,
        "apartment order",
      ),
      sourceIntegrity: parseStoredJson(
        metadata.source_integrity_json,
        "source-integrity metadata",
      ),
    };
    return validatedApartmentState(state, this.listUrlTemplate);
  }

  commitCrawl(state, { transaction = true } = {}) {
    validatedApartmentState(state, this.listUrlTemplate);
    return runRepositoryTransaction(
      this.database,
      "crawl_commit",
      transaction,
      () => {
        this.clearPresent.run();
        for (const [itemId, apartment] of Object.entries(state.apartments)) {
          this.insertPresent.run(itemId);
          this.upsertApartment.run(
            itemId,
            serializeJson(apartment, "Apartment payload"),
          );
        }
        this.deleteAbsent.run();
        this.upsertCrawl.run(
          state.checkedAt,
          serializeJson(state.lastCrawl, "Last crawl metadata"),
          serializeJson(state.apartmentOrder, "Apartment order"),
          serializeJson(state.sourceIntegrity, "Source-integrity metadata"),
        );
        return state;
      },
    );
  }

  importState(state, options) {
    return this.commitCrawl(state, options);
  }
}

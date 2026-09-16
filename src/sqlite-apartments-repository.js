import {
  APARTMENT_STATE_VERSION,
  compatibleApartmentState,
} from "./apartment-state.js";
import {
  annualPostingDateCutoff,
  postingDateIndex,
  postingDateSortValue,
} from "./posting-date.js";
import { propertyKindOf } from "./property-kind.js";
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
      "SELECT item_id, payload_json, last_seen_at FROM apartments ORDER BY encounter_sequence DESC, encounter_position ASC",
    );
    this.selectApartment = database.prepare(
      "SELECT item_id, payload_json, last_seen_at FROM apartments WHERE item_id = ?",
    );
    this.selectLegacyPrices =
      database.prepare(`SELECT item_id, payload_json, last_seen_at FROM apartments
      WHERE json_type(payload_json, '$.price.amountAmd') IS NULL`);
    this.selectKind = database.prepare(
      "SELECT 1 FROM apartments WHERE kind = ? LIMIT 1",
    );
    this.selectWatermark =
      database.prepare(`SELECT posting_date, posting_date_key FROM apartments
      WHERE kind = ? AND date_bucket = ? AND posting_date_key IS NOT NULL
      ORDER BY posting_date_key DESC LIMIT 1`);
    this.selectAnnual =
      database.prepare(`SELECT posting_date, posting_date_key FROM apartments
      WHERE kind = ? AND date_bucket = 'annual' AND posting_date_key <= ? AND posting_date_key > ?
      ORDER BY posting_date_key DESC LIMIT 1`);
    this.upsertApartment = database.prepare(`INSERT INTO apartments(
      item_id, payload_json, kind, date_bucket, posting_date_key, posting_date
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(item_id) DO UPDATE SET payload_json = excluded.payload_json,
      kind = excluded.kind, date_bucket = excluded.date_bucket,
      posting_date_key = excluded.posting_date_key, posting_date = excluded.posting_date`);
    this.touchApartment = database.prepare(`UPDATE apartments SET
      encounter_sequence = ?, encounter_position = ?, last_seen_at = ? WHERE item_id = ?`);
    this.upsertCrawl = database.prepare(`INSERT INTO crawl_state(
      singleton, checked_at, last_crawl_json, source_integrity_json, sequence, total_count
    ) VALUES (1, ?, ?, ?, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET checked_at = excluded.checked_at,
      last_crawl_json = excluded.last_crawl_json, source_integrity_json = excluded.source_integrity_json,
      sequence = excluded.sequence, total_count = excluded.total_count`);
  }

  metadata(row) {
    if (!row) return undefined;
    return {
      version: APARTMENT_STATE_VERSION,
      type: "list-am-apartments",
      urlTemplate: this.listUrlTemplate,
      checkedAt: row.checked_at,
      lastCrawl: parseStoredJson(row.last_crawl_json, "last crawl metadata"),
      sourceIntegrity: parseStoredJson(
        row.source_integrity_json,
        "source-integrity metadata",
      ),
      totalCount: row.total_count,
    };
  }

  apartment(row) {
    const apartment = parseStoredJson(row.payload_json, "apartment payload");
    if (row.last_seen_at !== null) apartment.lastSeenAt = row.last_seen_at;
    return apartment;
  }

  load() {
    const metadata = this.metadata(this.selectMetadata.get());
    if (!metadata) return undefined;
    const rows = this.selectApartments.all();
    if (rows.length !== metadata.totalCount)
      throw new TypeError("Apartment count does not match crawl metadata");
    const state = { ...metadata };
    delete state.totalCount;
    return validatedApartmentState(
      {
        ...state,
        apartments: Object.fromEntries(
          rows.map((row) => [row.item_id, this.apartment(row)]),
        ),
        apartmentOrder: rows.map((row) => row.item_id),
      },
      this.listUrlTemplate,
    );
  }

  loadCrawl(kinds) {
    const metadata = this.metadata(this.selectMetadata.get());
    const reference = Date.now();
    const cutoff = annualPostingDateCutoff(reference);
    const watermarks = Object.fromEntries(
      kinds.map((kind) => {
        const candidates = ["fixed", "relative"].map((bucket) =>
          this.selectWatermark.get(kind, bucket),
        );
        for (const [upper, lower] of [
          [cutoff, -1],
          [400, cutoff],
        ]) {
          let candidate = this.selectAnnual.get(kind, upper, lower);
          // February 29 may be invalid in the inferred year. Seek the next
          // distinct key, rather than walking every listing with that date.
          if (
            candidate &&
            postingDateSortValue(candidate.posting_date, reference) === null
          ) {
            candidate = this.selectAnnual.get(
              kind,
              candidate.posting_date_key - 1,
              lower,
            );
          }
          candidates.push(candidate);
        }
        let latest = { date: null, value: null };
        for (const row of candidates) {
          const value = postingDateSortValue(row?.posting_date, reference);
          if (value !== null && (latest.value === null || value > latest.value))
            latest = { date: row.posting_date, value };
        }
        return [kind, { ...latest, initialRun: !this.selectKind.get(kind) }];
      }),
    );
    return { ...metadata, totalCount: metadata?.totalCount ?? 0, watermarks };
  }

  findEncountered(itemIds) {
    return Object.fromEntries(
      [...new Set(itemIds)].flatMap((itemId) => {
        const row = this.selectApartment.get(
          nonEmptyIdentifier(itemId, "Apartment item ID"),
        );
        return row ? [[row.item_id, this.apartment(row)]] : [];
      }),
    );
  }

  findLegacyPrices() {
    return this.selectLegacyPrices.all().map((row) => this.apartment(row));
  }

  writePayload(apartment) {
    const itemId = nonEmptyIdentifier(apartment.itemId, "Apartment item ID");
    const { bucket, key } = postingDateIndex(apartment.date);
    this.upsertApartment.run(
      itemId,
      serializeJson(apartment, "Apartment payload"),
      propertyKindOf(apartment),
      bucket,
      key,
      apartment.date ?? null,
    );
  }

  commitCrawl(
    { checkedAt, lastCrawl, sourceIntegrity, changes, encounteredOrder },
    { transaction = true } = {},
  ) {
    canonicalIsoTimestamp(checkedAt, "Apartment checkedAt");
    if (new Set(encounteredOrder).size !== encounteredOrder.length)
      throw new TypeError("Encounter order must contain unique IDs");
    return runRepositoryTransaction(
      this.database,
      "crawl_commit",
      transaction,
      () => {
        const previous = this.selectMetadata.get();
        const sequence = (previous?.sequence ?? 0) + 1;
        let totalCount = previous?.total_count ?? 0;
        for (const apartment of changes) {
          if (!this.selectApartment.get(String(apartment.itemId))) totalCount++;
          this.writePayload(apartment);
        }
        encounteredOrder.forEach((itemId, position) => {
          if (
            this.touchApartment.run(sequence, position, checkedAt, itemId)
              .changes !== 1
          )
            throw new TypeError("Encounter must name a retained listing");
        });
        this.upsertCrawl.run(
          checkedAt,
          serializeJson(lastCrawl, "Last crawl metadata"),
          serializeJson(sourceIntegrity, "Source-integrity metadata"),
          sequence,
          totalCount,
        );
        return totalCount;
      },
    );
  }

  importState(state, { transaction = true } = {}) {
    validatedApartmentState(state, this.listUrlTemplate);
    return runRepositoryTransaction(
      this.database,
      "apartments_import",
      transaction,
      () => {
        if (this.selectMetadata.get() || this.selectApartments.get())
          throw new TypeError("Apartment import requires an empty repository");
        for (const apartment of Object.values(state.apartments))
          this.writePayload(apartment);
        state.apartmentOrder.forEach((itemId, position) => {
          this.touchApartment.run(
            0,
            position,
            state.apartments[itemId].lastSeenAt ?? null,
            itemId,
          );
        });
        this.upsertCrawl.run(
          state.checkedAt,
          serializeJson(state.lastCrawl, "Last crawl metadata"),
          serializeJson(state.sourceIntegrity, "Source-integrity metadata"),
          0,
          state.apartmentOrder.length,
        );
        return state;
      },
    );
  }
}

import {
  compatibleChannelState,
  channelFilterFingerprint,
  channelReadmissionReason,
} from "./channel.js";
import { apartmentMatchesFilters } from "./filters.js";
import { storedApartment } from "./sqlite-apartment-values.js";
import {
  canonicalIsoTimestamp,
  nonEmptyIdentifier,
  runRepositoryTransaction,
} from "./sqlite-repository-values.js";

const CHANNEL_STATUSES = new Set([
  "pending",
  "published",
  "filtered",
  "skipped_initial",
]);
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

function validateEntry(itemId, entry) {
  nonEmptyIdentifier(itemId, "Channel item ID");
  if (
    !entry ||
    typeof entry !== "object" ||
    !CHANNEL_STATUSES.has(entry.status)
  ) {
    throw new TypeError("Channel delivery entry has an invalid status");
  }
  canonicalIsoTimestamp(entry.classifiedAt, "Channel classifiedAt");
  if (entry.reencounteredAt !== undefined)
    canonicalIsoTimestamp(entry.reencounteredAt, "Channel reencounteredAt");
  if (entry.status !== "published") {
    if (
      [
        entry.messageId,
        entry.contentHash,
        entry.publishedAt,
        entry.updatedAt,
      ].some((value) => value !== undefined)
    ) {
      throw new TypeError(
        "Unpublished channel entries cannot contain publication fields",
      );
    }
    return entry;
  }
  if (
    !Number.isSafeInteger(entry.messageId) ||
    entry.messageId <= 0 ||
    !HASH_PATTERN.test(entry.contentHash || "")
  ) {
    throw new TypeError(
      "Published channel entry has invalid acknowledgement fields",
    );
  }
  canonicalIsoTimestamp(entry.publishedAt, "Channel publishedAt");
  if (entry.updatedAt !== undefined)
    canonicalIsoTimestamp(entry.updatedAt, "Channel updatedAt");
  return entry;
}

export class SqliteChannelDeliveriesRepository {
  constructor(database, { listUrlTemplate, channelId }) {
    this.database = database;
    this.listUrlTemplate = listUrlTemplate;
    this.channelId = String(channelId || "");
    if (!this.channelId)
      throw new TypeError("Channel ID is required for the channel repository");
    this.selectState = database.prepare(
      "SELECT * FROM channel_state WHERE singleton = 1",
    );
    this.selectDeliveries = database.prepare(
      "SELECT * FROM channel_deliveries ORDER BY item_id",
    );
    this.insertState = database.prepare(`INSERT INTO channel_state(
      singleton, channel_id, list_url_template, initialized, filter_fingerprint
    ) VALUES (1, ?, ?, 1, ?)`);
    this.upsertState = database.prepare(`INSERT INTO channel_state(
      singleton, channel_id, list_url_template, initialized, filter_fingerprint
    ) VALUES (1, ?, ?, 1, ?) ON CONFLICT(singleton) DO UPDATE SET
      channel_id = excluded.channel_id,
      list_url_template = excluded.list_url_template,
      initialized = excluded.initialized,
      filter_fingerprint = excluded.filter_fingerprint`);
    this.updateFingerprintStatement = database.prepare(
      "UPDATE channel_state SET filter_fingerprint = ? WHERE singleton = 1",
    );
    this.insertDelivery = database.prepare(`INSERT INTO channel_deliveries(
      item_id, status, classified_at, reencountered_at, message_id, content_hash, published_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    this.updateReadmission = database.prepare(`UPDATE channel_deliveries SET
      status = 'pending', reencountered_at = ?, message_id = NULL, content_hash = NULL,
      published_at = NULL, updated_at = NULL WHERE item_id = ? AND status IN ('filtered', 'skipped_initial')`);
    this.upsertAcknowledgement =
      database.prepare(`INSERT INTO channel_deliveries(
      item_id, status, classified_at, reencountered_at, message_id, content_hash, published_at, updated_at
    ) VALUES (?, 'published', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(item_id) DO UPDATE SET
      status = 'published', message_id = excluded.message_id, content_hash = excluded.content_hash,
      published_at = excluded.published_at, updated_at = excluded.updated_at`);
    this.clearDeliveries = database.prepare("DELETE FROM channel_deliveries");
    this.clearState = database.prepare("DELETE FROM channel_state");
  }

  prepare(config, _apartmentState, now) {
    return this.database.transaction("channel_prepare", () => {
      const fingerprint = channelFilterFingerprint(config.channelFilters);
      const previous = this.selectState.get();
      const sequence = Number(
        this.database
          .prepare("SELECT sequence FROM crawl_state WHERE singleton = 1")
          .get()?.sequence || 0,
      );
      const enqueue = this.database.prepare(
        "INSERT OR IGNORE INTO channel_work(item_id) VALUES (?)",
      );
      let filteredCount = 0;
      let skippedCount = 0;
      if (!previous) {
        this.insertState.run(this.channelId, this.listUrlTemplate, fingerprint);
        let selected = 0;
        for (const row of this.database
          .prepare(
            "SELECT * FROM apartments ORDER BY encounter_sequence DESC, encounter_position ASC",
          )
          .iterate()) {
          const matches = apartmentMatchesFilters(
            storedApartment(row),
            config.channelFilters,
          );
          const status = !matches
            ? "filtered"
            : selected++ < config.initialDeliveryLimit
              ? "pending"
              : "skipped_initial";
          if (status === "filtered") filteredCount += 1;
          if (status === "skipped_initial") skippedCount += 1;
          this.insertEntry(row.item_id, {
            status,
            classifiedAt: now.toISOString(),
          });
        }
        this.database
          .prepare(
            `INSERT OR IGNORE INTO channel_work(item_id)
          SELECT a.item_id FROM apartments a JOIN channel_deliveries d USING(item_id)
          WHERE d.status = 'pending' ORDER BY a.encounter_sequence ASC, a.encounter_position DESC`,
          )
          .run();
      } else {
        const ids = `SELECT a.item_id FROM apartments a INDEXED BY apartments_encounter_order_idx JOIN channel_deliveries d USING(item_id)
          WHERE a.encounter_sequence > ? AND d.status = 'skipped_initial'
          UNION SELECT item_id FROM apartments WHERE changed_sequence > ?`;
        // SQL orders only this crawl's bounded candidates, never retained history.
        for (const row of this.database
          .prepare(
            `SELECT a.item_id FROM apartments a JOIN (${ids}) c USING(item_id)
          ORDER BY a.encounter_sequence ASC, a.encounter_position DESC`,
          )
          .iterate(previous.source_sequence, previous.source_sequence))
          enqueue.run(row.item_id);
        if (previous.filter_fingerprint !== fingerprint) {
          for (const row of this.database
            .prepare(
              `SELECT a.*, d.* FROM channel_deliveries d JOIN apartments a USING(item_id)
            WHERE d.status IN ('filtered', 'skipped_initial') ORDER BY a.encounter_sequence ASC, a.encounter_position DESC`,
            )
            .iterate()) {
            if (
              channelReadmissionReason(
                storedApartment(row),
                channelEntry(row),
                config.channelFilters,
                now.getTime(),
              )
            )
              enqueue.run(row.item_id);
          }
          this.updateFingerprintStatement.run(fingerprint);
        }
      }
      // Rebuild only outstanding work so retries and newly discovered cards
      // share the original oldest-first order, regardless of enqueue time.
      this.database
        .prepare(
          `CREATE TEMP TABLE channel_work_ordered AS
        SELECT w.item_id FROM channel_work w JOIN apartments a USING(item_id)
        ORDER BY a.encounter_sequence ASC, a.encounter_position DESC`,
        )
        .run();
      this.database.prepare("DELETE FROM channel_work").run();
      this.database
        .prepare(
          "INSERT INTO channel_work(item_id) SELECT item_id FROM channel_work_ordered",
        )
        .run();
      this.database.prepare("DROP TABLE channel_work_ordered").run();
      this.database
        .prepare(
          "UPDATE channel_state SET source_sequence = ? WHERE singleton = 1",
        )
        .run(sequence);
      return {
        filteredCount,
        skippedCount,
        previousFingerprint: previous?.filter_fingerprint,
      };
    });
  }

  loadCandidates(afterWorkId = 0, limit = 100) {
    return this.database
      .prepare(
        `SELECT w.work_id, a.*, d.* FROM channel_work w
      JOIN apartments a USING(item_id) LEFT JOIN channel_deliveries d USING(item_id)
      WHERE w.work_id > ? ORDER BY w.work_id LIMIT ?`,
      )
      .all(afterWorkId, limit)
      .map((row) => ({
        workId: Number(row.work_id),
        apartment: storedApartment(row),
        entry: row.status ? channelEntry(row) : undefined,
      }));
  }

  complete(itemId) {
    return this.database.transaction("channel_complete", () =>
      Number(
        this.database
          .prepare("DELETE FROM channel_work WHERE item_id = ?")
          .run(itemId).changes,
      ),
    );
  }

  load() {
    const stored = this.selectState.get();
    if (!stored) return undefined;
    const apartments = Object.fromEntries(
      this.selectDeliveries
        .all()
        .map((row) => [row.item_id, channelEntry(row)]),
    );
    const state = {
      version: 1,
      type: "telegram-channel-deliveries",
      channelId: stored.channel_id,
      urlTemplate: stored.list_url_template,
      initialized: Boolean(stored.initialized),
      filterFingerprint: stored.filter_fingerprint,
      apartments,
    };
    if (
      !compatibleChannelState(state, {
        telegramChannelId: this.channelId,
        listUrlTemplate: this.listUrlTemplate,
      })
    ) {
      const error = new Error("Stored channel delivery state is incompatible");
      error.code = "ERR_STATE_DATABASE_DOMAIN_INVALID";
      throw error;
    }
    return state;
  }

  classify(decisions, { transaction = true } = {}) {
    const entries = Object.entries(decisions || {}).map(([itemId, entry]) => [
      itemId,
      validateEntry(itemId, entry),
    ]);
    return runRepositoryTransaction(
      this.database,
      "channel_classify",
      transaction,
      () => {
        for (const [itemId, entry] of entries) this.insertEntry(itemId, entry);
        return entries.length;
      },
    );
  }

  readmit(itemId, reencounteredAt, { transaction = true } = {}) {
    const id = nonEmptyIdentifier(itemId, "Channel item ID");
    canonicalIsoTimestamp(reencounteredAt, "Channel reencounteredAt");
    return runRepositoryTransaction(
      this.database,
      "channel_readmit",
      transaction,
      () => Number(this.updateReadmission.run(reencounteredAt, id).changes),
    );
  }

  acknowledge(itemId, acknowledgement, { transaction = true } = {}) {
    const id = nonEmptyIdentifier(itemId, "Channel item ID");
    const current = this.database
      .prepare("SELECT * FROM channel_deliveries WHERE item_id = ?")
      .get(id);
    if (!current)
      throw new TypeError("Channel acknowledgement requires a classified item");
    const entry = validateEntry(id, {
      status: "published",
      classifiedAt: current.classified_at,
      ...(current.reencountered_at === null
        ? {}
        : { reencounteredAt: current.reencountered_at }),
      ...acknowledgement,
    });
    return runRepositoryTransaction(
      this.database,
      "channel_acknowledge",
      transaction,
      () => {
        this.upsertAcknowledgement.run(
          id,
          entry.classifiedAt,
          entry.reencounteredAt ?? null,
          entry.messageId,
          entry.contentHash,
          entry.publishedAt,
          entry.updatedAt ?? null,
        );
        return 1;
      },
    );
  }

  importState(state, { transaction = true } = {}) {
    if (
      !compatibleChannelState(state, {
        telegramChannelId: this.channelId,
        listUrlTemplate: this.listUrlTemplate,
      })
    ) {
      throw new TypeError("Channel delivery state has an incompatible schema");
    }
    const entries = Object.entries(state.apartments).map(([itemId, entry]) => [
      itemId,
      validateEntry(itemId, entry),
    ]);
    return runRepositoryTransaction(
      this.database,
      "channel_import",
      transaction,
      () => {
        this.clearDeliveries.run();
        this.clearState.run();
        this.upsertState.run(
          this.channelId,
          this.listUrlTemplate,
          state.filterFingerprint,
        );
        for (const [itemId, entry] of entries) this.insertEntry(itemId, entry);
        return entries.length;
      },
    );
  }

  insertEntry(itemId, entry) {
    this.insertDelivery.run(
      itemId,
      entry.status,
      entry.classifiedAt,
      entry.reencounteredAt ?? null,
      entry.messageId ?? null,
      entry.contentHash ?? null,
      entry.publishedAt ?? null,
      entry.updatedAt ?? null,
    );
  }
}

function channelEntry(row) {
  return {
    status: row.status,
    classifiedAt: row.classified_at,
    ...(row.reencountered_at === null
      ? {}
      : { reencounteredAt: row.reencountered_at }),
    ...(row.message_id === null ? {} : { messageId: Number(row.message_id) }),
    ...(row.content_hash === null ? {} : { contentHash: row.content_hash }),
    ...(row.published_at === null ? {} : { publishedAt: row.published_at }),
    ...(row.updated_at === null ? {} : { updatedAt: row.updated_at }),
  };
}

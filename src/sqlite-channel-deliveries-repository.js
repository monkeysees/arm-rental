import { compatibleChannelState } from "./channel.js";
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

function validateFingerprint(value) {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new TypeError(
      "Channel filter fingerprint must be a lowercase SHA-256 digest",
    );
  }
  return value;
}

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

  load() {
    const stored = this.selectState.get();
    if (!stored) return undefined;
    const apartments = Object.fromEntries(
      this.selectDeliveries.all().map((row) => [
        row.item_id,
        {
          status: row.status,
          classifiedAt: row.classified_at,
          ...(row.reencountered_at === null
            ? {}
            : { reencounteredAt: row.reencountered_at }),
          ...(row.message_id === null
            ? {}
            : { messageId: Number(row.message_id) }),
          ...(row.content_hash === null
            ? {}
            : { contentHash: row.content_hash }),
          ...(row.published_at === null
            ? {}
            : { publishedAt: row.published_at }),
          ...(row.updated_at === null ? {} : { updatedAt: row.updated_at }),
        },
      ]),
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

  initialize(filterFingerprint, decisions, { transaction = true } = {}) {
    validateFingerprint(filterFingerprint);
    const entries = Object.entries(decisions || {}).map(([itemId, entry]) => [
      itemId,
      validateEntry(itemId, entry),
    ]);
    return runRepositoryTransaction(
      this.database,
      "channel_initialize",
      transaction,
      () => {
        this.insertState.run(
          this.channelId,
          this.listUrlTemplate,
          filterFingerprint,
        );
        for (const [itemId, entry] of entries) this.insertEntry(itemId, entry);
        return entries.length;
      },
    );
  }

  updateFilterFingerprint(filterFingerprint, { transaction = true } = {}) {
    validateFingerprint(filterFingerprint);
    return runRepositoryTransaction(
      this.database,
      "channel_filter_fingerprint",
      transaction,
      () =>
        Number(this.updateFingerprintStatement.run(filterFingerprint).changes),
    );
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

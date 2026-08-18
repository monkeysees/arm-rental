import {
  canonicalIsoTimestamp,
  entriesFromDecisions,
  nonEmptyIdentifier,
  runRepositoryTransaction,
} from "./sqlite-repository-values.js";

const STATUSES = ["notified", "skipped", "filtered"];

function recipientId(value) {
  return nonEmptyIdentifier(value, "Private recipient ID");
}

function validateRecipient(recipient) {
  if (!recipient || typeof recipient !== "object" || Array.isArray(recipient)) {
    throw new TypeError("Private recipient state must be an object");
  }
  const decisions = Object.fromEntries(
    STATUSES.map((status) => [
      status,
      entriesFromDecisions(recipient[status] || {}, status),
    ]),
  );
  const seen = new Set();
  for (const status of STATUSES) {
    for (const [itemId] of decisions[status]) {
      if (seen.has(itemId))
        throw new TypeError("Private delivery statuses cannot overlap");
      seen.add(itemId);
    }
  }
  return {
    initialSelectionApplied: recipient.initialSelectionApplied === true,
    decisions,
  };
}

export class SqlitePrivateDeliveriesRepository {
  constructor(database, { listUrlTemplate }) {
    this.database = database;
    this.listUrlTemplate = listUrlTemplate;
    this.selectRecipients = database.prepare(
      "SELECT recipient_id, initial_selection_applied FROM private_recipients",
    );
    this.selectDecisions =
      database.prepare(`SELECT recipient_id, item_id, status, decided_at
      FROM private_delivery_decisions ORDER BY recipient_id, item_id`);
    this.upsertRecipient =
      database.prepare(`INSERT INTO private_recipients(recipient_id, initial_selection_applied)
      VALUES (?, ?) ON CONFLICT(recipient_id) DO UPDATE SET initial_selection_applied = excluded.initial_selection_applied`);
    this.ensureRecipientStatement =
      database.prepare(`INSERT INTO private_recipients(recipient_id, initial_selection_applied)
      VALUES (?, 0) ON CONFLICT(recipient_id) DO NOTHING`);
    this.insertDecision =
      database.prepare(`INSERT INTO private_delivery_decisions(recipient_id, item_id, status, decided_at)
      VALUES (?, ?, ?, ?)`);
    this.upsertDecision =
      database.prepare(`INSERT INTO private_delivery_decisions(recipient_id, item_id, status, decided_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(recipient_id, item_id) DO UPDATE SET
      status = excluded.status, decided_at = excluded.decided_at`);
    this.deleteFiltered =
      database.prepare(`DELETE FROM private_delivery_decisions
      WHERE recipient_id = ? AND item_id = ? AND status = 'filtered'`);
    this.deleteRecipientStatement = database.prepare(
      "DELETE FROM private_recipients WHERE recipient_id = ?",
    );
    this.clearDecisions = database.prepare(
      "DELETE FROM private_delivery_decisions",
    );
    this.clearRecipients = database.prepare("DELETE FROM private_recipients");
  }

  loadAllDecisions() {
    const recipients = Object.fromEntries(
      this.selectRecipients.all().map((row) => [
        row.recipient_id,
        {
          notified: {},
          skipped: {},
          filtered: {},
          initialSelectionApplied: Boolean(row.initial_selection_applied),
        },
      ]),
    );
    for (const row of this.selectDecisions.all()) {
      const recipient = recipients[row.recipient_id];
      if (!recipient || !STATUSES.includes(row.status)) {
        const error = new Error("Stored private delivery decision is invalid");
        error.code = "ERR_STATE_DATABASE_DOMAIN_INVALID";
        throw error;
      }
      canonicalIsoTimestamp(
        row.decided_at,
        "Stored private delivery timestamp",
      );
      recipient[row.status][row.item_id] = row.decided_at;
    }
    return {
      version: 2,
      type: "telegram-deliveries",
      urlTemplate: this.listUrlTemplate,
      recipients,
    };
  }

  loadRecipient(value) {
    return this.loadAllDecisions().recipients[recipientId(value)];
  }

  ensureRecipient(value, { transaction = true } = {}) {
    const id = recipientId(value);
    return runRepositoryTransaction(
      this.database,
      "private_recipient_ensure",
      transaction,
      () => {
        this.ensureRecipientStatement.run(id);
        return id;
      },
    );
  }

  initializeSelection(
    value,
    { skipped = {}, filtered = {} },
    { transaction = true } = {},
  ) {
    const id = recipientId(value);
    const skippedEntries = entriesFromDecisions(skipped, "Skipped");
    const filteredEntries = entriesFromDecisions(filtered, "Filtered");
    const skippedIds = new Set(skippedEntries.map(([itemId]) => itemId));
    if (filteredEntries.some(([itemId]) => skippedIds.has(itemId))) {
      throw new TypeError("Initial private delivery statuses cannot overlap");
    }
    return runRepositoryTransaction(
      this.database,
      "private_delivery_initialize",
      transaction,
      () => {
        this.upsertRecipient.run(id, 1);
        for (const [itemId, timestamp] of skippedEntries)
          this.insertDecision.run(id, itemId, "skipped", timestamp);
        for (const [itemId, timestamp] of filteredEntries)
          this.insertDecision.run(id, itemId, "filtered", timestamp);
        return skippedEntries.length + filteredEntries.length;
      },
    );
  }

  addDecisions(value, status, decisions, { transaction = true } = {}) {
    const id = recipientId(value);
    if (!new Set(["skipped", "filtered"]).has(status))
      throw new TypeError("Unsupported private delivery decision status");
    const entries = entriesFromDecisions(decisions, status);
    return runRepositoryTransaction(
      this.database,
      "private_delivery_classify",
      transaction,
      () => {
        this.ensureRecipientStatement.run(id);
        for (const [itemId, timestamp] of entries)
          this.insertDecision.run(id, itemId, status, timestamp);
        return entries.length;
      },
    );
  }

  removeFilteredDecision(value, itemId, { transaction = true } = {}) {
    const id = recipientId(value);
    const normalizedItemId = nonEmptyIdentifier(itemId, "Delivery item ID");
    return runRepositoryTransaction(
      this.database,
      "private_delivery_readmit",
      transaction,
      () => Number(this.deleteFiltered.run(id, normalizedItemId).changes),
    );
  }

  acknowledge(value, itemId, decidedAt, { transaction = true } = {}) {
    const id = recipientId(value);
    const normalizedItemId = nonEmptyIdentifier(itemId, "Delivery item ID");
    canonicalIsoTimestamp(decidedAt, "Private acknowledgement timestamp");
    return runRepositoryTransaction(
      this.database,
      "private_delivery_acknowledge",
      transaction,
      () => {
        this.ensureRecipientStatement.run(id);
        this.upsertDecision.run(id, normalizedItemId, "notified", decidedAt);
        return 1;
      },
    );
  }

  deleteRecipient(value, { transaction = true } = {}) {
    const id = recipientId(value);
    return runRepositoryTransaction(
      this.database,
      "private_recipient_delete",
      transaction,
      () => Number(this.deleteRecipientStatement.run(id).changes),
    );
  }

  importState(state, { transaction = true } = {}) {
    if (
      !state ||
      state.version !== 2 ||
      state.type !== "telegram-deliveries" ||
      state.urlTemplate !== this.listUrlTemplate ||
      !state.recipients ||
      typeof state.recipients !== "object" ||
      Array.isArray(state.recipients)
    ) {
      throw new TypeError("Private delivery state has an incompatible schema");
    }
    const recipients = Object.entries(state.recipients).map(
      ([id, recipient]) => [recipientId(id), validateRecipient(recipient)],
    );
    return runRepositoryTransaction(
      this.database,
      "private_delivery_import",
      transaction,
      () => {
        this.clearDecisions.run();
        this.clearRecipients.run();
        for (const [id, recipient] of recipients) {
          this.upsertRecipient.run(
            id,
            recipient.initialSelectionApplied ? 1 : 0,
          );
          for (const status of STATUSES) {
            for (const [itemId, timestamp] of recipient.decisions[status])
              this.insertDecision.run(id, itemId, status, timestamp);
          }
        }
        return recipients.length;
      },
    );
  }
}

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

function itemIdentifiers(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} apartments must be an array`);
  }
  return value.map((itemId) => nonEmptyIdentifier(itemId, "Delivery item ID"));
}

function invalidDecisionError() {
  const error = new Error("Stored private delivery decision is invalid");
  error.code = "ERR_STATE_DATABASE_DOMAIN_INVALID";
  return error;
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
    this.selectRecipient = database.prepare(
      "SELECT initial_selection_applied FROM private_recipients WHERE recipient_id = ?",
    );
    // The (recipient_id, item_id) primary key indexes this lookup and supplies
    // the ordering, so one recipient is read without touching a peer's rows.
    this.selectRecipientDecisions =
      database.prepare(`SELECT item_id, status, decided_at
      FROM private_delivery_decisions WHERE recipient_id = ? ORDER BY item_id`);
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
    // Counted rather than collected: a caller asking whether the rows are
    // usable must not be handed all of them to find out.
    this.countInvalidDecisions =
      database.prepare(`SELECT count(*) AS invalid FROM private_delivery_decisions
      WHERE strftime('%Y-%m-%dT%H:%M:%fZ', decided_at) IS NOT decided_at`);
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
        throw invalidDecisionError();
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

  /**
   * Proves the stored decisions are usable without holding them.
   *
   * This table keeps every answer the installation has ever recorded, so
   * rebuilding it just to check it puts its whole size on the event loop at
   * every start, and that size only grows. Status and recipient linkage are
   * already refused by the schema's own constraints, which leaves the decision
   * timestamp: SQLite reformats each one through its own date parser, and a
   * value that does not survive that round trip is exactly the value
   * `canonicalIsoTimestamp` refuses when a recipient is later read.
   */
  validate() {
    return Number(this.countInvalidDecisions.get().invalid) === 0;
  }

  loadRecipient(value) {
    const id = recipientId(value);
    const row = this.selectRecipient.get(id);
    if (!row) return undefined;
    const recipient = {
      notified: {},
      skipped: {},
      filtered: {},
      initialSelectionApplied: Boolean(row.initial_selection_applied),
    };
    for (const decision of this.selectRecipientDecisions.all(id)) {
      if (!STATUSES.includes(decision.status)) throw invalidDecisionError();
      canonicalIsoTimestamp(
        decision.decided_at,
        "Stored private delivery timestamp",
      );
      recipient[decision.status][decision.item_id] = decision.decided_at;
    }
    return recipient;
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

  /**
   * Applies one monitoring answer to the history this recipient carries.
   *
   * The bot reopens the selection gate whenever the user answers the question
   * again, so this runs at a start, at a restart after a pause, and at a
   * resumed subscription alike. A recipient that already carries decisions is
   * therefore expected: accepted matches shed the rejection they picked up
   * under the filters that ran before, and declined ones are written over
   * whatever status they held.
   */
  initializeSelection(
    value,
    { skipped = {}, filtered = {}, released = [] },
    { transaction = true } = {},
  ) {
    const id = recipientId(value);
    const skippedEntries = entriesFromDecisions(skipped, "Skipped");
    const filteredEntries = entriesFromDecisions(filtered, "Filtered");
    const releasedIds = itemIdentifiers(released, "Released");
    const skippedIds = new Set(skippedEntries.map(([itemId]) => itemId));
    const decidedIds = new Set([
      ...skippedIds,
      ...filteredEntries.map(([itemId]) => itemId),
    ]);
    if (filteredEntries.some(([itemId]) => skippedIds.has(itemId))) {
      throw new TypeError("Initial private delivery statuses cannot overlap");
    }
    if (releasedIds.some((itemId) => decidedIds.has(itemId))) {
      throw new TypeError("A released apartment cannot also be classified");
    }
    return runRepositoryTransaction(
      this.database,
      "private_delivery_initialize",
      transaction,
      () => {
        this.upsertRecipient.run(id, 1);
        for (const itemId of releasedIds) this.deleteFiltered.run(id, itemId);
        for (const [itemId, timestamp] of skippedEntries)
          this.upsertDecision.run(id, itemId, "skipped", timestamp);
        for (const [itemId, timestamp] of filteredEntries)
          this.upsertDecision.run(id, itemId, "filtered", timestamp);
        return (
          releasedIds.length + skippedEntries.length + filteredEntries.length
        );
      },
    );
  }

  /**
   * Reopens the selection gate so the next crawl applies a fresh answer.
   *
   * The answer itself lives with the bot user, and the gate lives with the
   * delivery history it classifies; keeping them apart is what lets a restart
   * decide the pause's backlog without a second copy of the user's choice.
   */
  requestSelection(value, { transaction = true } = {}) {
    const id = recipientId(value);
    return runRepositoryTransaction(
      this.database,
      "private_selection_request",
      transaction,
      () => {
        this.upsertRecipient.run(id, 0);
        return id;
      },
    );
  }

  /**
   * Records history the user declined, overwriting the rejection it carried.
   *
   * A declined apartment is never released again, so the answer has to survive
   * the filter edit that surfaced it.
   */
  declineHistory(value, decisions, { transaction = true } = {}) {
    const id = recipientId(value);
    const entries = entriesFromDecisions(decisions, "Skipped");
    return runRepositoryTransaction(
      this.database,
      "private_delivery_decline",
      transaction,
      () => {
        this.ensureRecipientStatement.run(id);
        for (const [itemId, timestamp] of entries)
          this.upsertDecision.run(id, itemId, "skipped", timestamp);
        return entries.length;
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

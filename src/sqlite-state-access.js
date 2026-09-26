import { migrateBotState } from "./bot.js";

// A domain value reaches these guards from two directions: rebuilt from SQLite
// rows, or carried in memory since the process first constructed it. Both
// describe the same record, but their keys were inserted in different orders,
// and JSON.stringify would report that as a difference. Ordering keys keeps the
// bounded-write guards measuring meaning instead of construction order. Array
// order is preserved because it carries meaning.
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

function sameValue(left, right) {
  return (
    JSON.stringify(canonicalValue(left)) ===
    JSON.stringify(canonicalValue(right))
  );
}

function changedKeys(previous, next) {
  return new Set([...Object.keys(previous || {}), ...Object.keys(next || {})]);
}

/**
 * The bounded write path for private delivery. Every call touches one
 * recipient's rows inside one transaction, so `state.transaction.*` measures
 * exactly the work a delivery decision performs.
 */
function createDeliveryDecisions(database, repository) {
  return {
    applyInitialSelection: (recipientId, selection) =>
      repository.initializeSelection(recipientId, selection),
    classifyFiltered: (recipientId, filtered) =>
      repository.addDecisions(recipientId, "filtered", filtered),
    readmitFiltered: (recipientId, itemIds) =>
      database.transaction("private_delivery_readmit", () => {
        for (const itemId of itemIds) {
          repository.removeFilteredDecision(recipientId, itemId, {
            transaction: false,
          });
        }
        return itemIds.length;
      }),
    acknowledge: (recipientId, itemId, decidedAt) =>
      repository.acknowledge(recipientId, itemId, decidedAt),
    requestSelection: (recipientId) => repository.requestSelection(recipientId),
    declineHistory: (recipientId, skipped) =>
      repository.declineHistory(recipientId, skipped),
  };
}

function saveTelegramState(repository, state) {
  const previous = repository.load();
  const next = migrateBotState(state);
  const changedUsers = [...changedKeys(previous.users, next.users)].filter(
    (chatId) => !sameValue(previous.users[chatId], next.users[chatId]),
  );
  if (changedUsers.length > 1) {
    throw new TypeError(
      "One Telegram state commit may mutate at most one user",
    );
  }
  if (previous.legacyRecipientId !== next.legacyRecipientId) {
    throw new TypeError(
      "Legacy recipient identity may change only during migration or user deletion",
    );
  }
  const chatId = changedUsers[0];
  if (!chatId) return repository.setUpdateOffset(next.updateOffset);
  return repository.commitUpdate(next.updateOffset, {
    ...(next.users[chatId]
      ? { user: next.users[chatId] }
      : { deleteChatId: Number(chatId) }),
  });
}

/**
 * Names one store per domain so a caller reaches its own rows directly. The
 * Telegram adapter translates each poll's state into bounded user operations.
 * Delivery consumers use candidate and decision operations directly; neither
 * rewrites a whole history. A recipient only ever leaves through the atomic
 * `deleteUserData` transaction.
 */
export function createSqliteStateAccess(database, repositories) {
  return {
    apartments: {
      load: () => repositories.apartments.load(),
      loadCrawl: (kinds) => repositories.apartments.loadCrawl(kinds),
      findLegacyPrices: () => repositories.apartments.findLegacyPrices(),
      findEncountered: (itemIds) =>
        repositories.apartments.findEncountered(itemIds),
      commitCrawl: (crawl) => repositories.apartments.commitCrawl(crawl),
    },
    privateDeliveries: {
      prepareBatch: (id, items) =>
        repositories.privateDeliveries.prepareBatch(id, items),
      nextBatchItem: (id) => repositories.privateDeliveries.nextBatchItem(id),
      acknowledgeBatchItem: (id, item, decidedAt) =>
        repositories.privateDeliveries.acknowledgeBatchItem(
          id,
          item,
          decidedAt,
        ),
      clearBatches: () => repositories.privateDeliveries.clearBatches(),
      load: () => repositories.privateDeliveries.loadAllDecisions(),
      loadCandidates: (recipientId, filters) =>
        repositories.privateDeliveries.loadCandidates(recipientId, filters),
      retainPending: (recipientId, itemIds, workIds) =>
        repositories.privateDeliveries.retainPending(
          recipientId,
          itemIds,
          workIds,
        ),
      loadRecipient: (recipientId, itemIds) =>
        repositories.privateDeliveries.loadRecipient(recipientId, itemIds),
      validate: () => repositories.privateDeliveries.validate(),
      decisions: createDeliveryDecisions(
        database,
        repositories.privateDeliveries,
      ),
    },
    channelDeliveries: repositories.channelDeliveries,
    telegram: {
      load: () => repositories.telegram.load(),
      save: (state) => saveTelegramState(repositories.telegram, state),
    },
    exchangeRates: {
      load: () => repositories.exchangeRates.load(),
      save: (snapshot) => repositories.exchangeRates.save(snapshot),
    },
    /** Removes a user and their delivery history in one transaction. */
    deleteUserData: (chatId) =>
      repositories.telegram.deleteUserAndPrivateDeliveries(
        chatId,
        repositories.privateDeliveries,
      ),
  };
}

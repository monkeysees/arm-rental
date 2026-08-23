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

function saveChannelState(database, repository, state) {
  const previous = repository.load();
  if (!previous) {
    repository.initialize(state.filterFingerprint, state.apartments);
    return state;
  }

  database.transaction("channel_state_commit", () => {
    if (previous.filterFingerprint !== state.filterFingerprint) {
      repository.updateFilterFingerprint(state.filterFingerprint, {
        transaction: false,
      });
    }
    const additions = Object.fromEntries(
      Object.entries(state.apartments).filter(
        ([itemId]) => !Object.hasOwn(previous.apartments, itemId),
      ),
    );
    if (Object.keys(additions).length > 0) {
      repository.classify(additions, { transaction: false });
    }

    for (const [itemId, entry] of Object.entries(state.apartments)) {
      const prior = previous.apartments[itemId];
      if (!prior || sameValue(prior, entry)) continue;
      if (
        entry.status === "pending" &&
        ["filtered", "skipped_initial"].includes(prior.status)
      ) {
        repository.readmit(itemId, entry.reencounteredAt, {
          transaction: false,
        });
        continue;
      }
      if (entry.status === "published") {
        repository.acknowledge(
          itemId,
          {
            messageId: entry.messageId,
            contentHash: entry.contentHash,
            publishedAt: entry.publishedAt,
            ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
          },
          { transaction: false },
        );
        continue;
      }
      throw new TypeError("Unsupported channel delivery state transition");
    }
  });
  return state;
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
 * channel and Telegram stores still accept a whole domain state because their
 * callers hold one in memory for a whole publication or poll; each translates
 * it into the bounded repository operations the change actually implies.
 * Private delivery has no whole-state writer left: every decision is written
 * through `decisions`, and a recipient only ever leaves through the atomic
 * `deleteUserData` transaction.
 */
export function createSqliteStateAccess(database, repositories) {
  return {
    apartments: {
      load: () => repositories.apartments.load(),
      save: (state) => repositories.apartments.commitCrawl(state),
    },
    privateDeliveries: {
      load: () => repositories.privateDeliveries.loadAllDecisions(),
      loadRecipient: (recipientId) =>
        repositories.privateDeliveries.loadRecipient(recipientId),
      validate: () => repositories.privateDeliveries.validate(),
      decisions: createDeliveryDecisions(
        database,
        repositories.privateDeliveries,
      ),
    },
    channelDeliveries: repositories.channelDeliveries
      ? {
          load: () => repositories.channelDeliveries.load(),
          save: (state) =>
            saveChannelState(database, repositories.channelDeliveries, state),
        }
      : null,
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

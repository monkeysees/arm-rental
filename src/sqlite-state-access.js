import path from "node:path";

import { migrateBotState } from "./bot.js";

function samePath(left, right) {
  return path.resolve(left) === path.resolve(right);
}

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

function savePrivateState(database, repository, state) {
  const previous = repository.loadAllDecisions();
  const nextRecipients = state?.recipients || {};
  const previousRecipients = previous.recipients;
  const removed = Object.keys(previousRecipients).filter(
    (recipientId) => !Object.hasOwn(nextRecipients, recipientId),
  );
  if (removed.length > 0) {
    throw new TypeError(
      "Private recipients must be deleted through the atomic user-deletion operation",
    );
  }

  return database.transaction("private_delivery_state_commit", () => {
    for (const recipientId of changedKeys(previousRecipients, nextRecipients)) {
      const prior = previousRecipients[recipientId];
      const next = nextRecipients[recipientId];
      if (!next || sameValue(prior, next)) continue;

      if (!prior) {
        repository.ensureRecipient(recipientId, { transaction: false });
      }
      if (next.initialSelectionApplied && !prior?.initialSelectionApplied) {
        repository.initializeSelection(
          recipientId,
          { skipped: next.skipped || {}, filtered: next.filtered || {} },
          { transaction: false },
        );
      } else {
        for (const status of ["skipped", "filtered"]) {
          const additions = Object.fromEntries(
            Object.entries(next[status] || {}).filter(
              ([itemId, timestamp]) => prior?.[status]?.[itemId] !== timestamp,
            ),
          );
          if (Object.keys(additions).length > 0) {
            repository.addDecisions(recipientId, status, additions, {
              transaction: false,
            });
          }
        }
      }

      for (const itemId of Object.keys(prior?.filtered || {})) {
        if (!Object.hasOwn(next.filtered || {}, itemId)) {
          repository.removeFilteredDecision(recipientId, itemId, {
            transaction: false,
          });
        }
      }
      for (const [itemId, timestamp] of Object.entries(next.notified || {})) {
        if (prior?.notified?.[itemId] !== timestamp) {
          repository.acknowledge(recipientId, itemId, timestamp, {
            transaction: false,
          });
        }
      }
    }
    return state;
  });
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
 * Adapts existing domain entry points to bounded repository operations during
 * the storage cutover. Each filename is only a routing key; SQLite never stores
 * or replaces a serialized copy of a former state file.
 */
export function createSqliteStateAccess(config, database, repositories) {
  const loadState = async (filename) => {
    if (samePath(filename, config.apartmentsStateFile)) {
      return repositories.apartments.load();
    }
    if (samePath(filename, config.deliveryStateFile)) {
      return repositories.privateDeliveries.loadAllDecisions();
    }
    if (samePath(filename, config.channelDeliveryStateFile)) {
      return repositories.channelDeliveries?.load();
    }
    if (samePath(filename, config.telegramStateFile)) {
      return repositories.telegram.load();
    }
    if (samePath(filename, config.exchangeRatesStateFile)) {
      return repositories.exchangeRates.load();
    }
    throw new TypeError("Unknown SQLite domain state route");
  };

  const saveState = async (filename, state) => {
    if (samePath(filename, config.apartmentsStateFile)) {
      return repositories.apartments.commitCrawl(state);
    }
    if (samePath(filename, config.deliveryStateFile)) {
      return savePrivateState(database, repositories.privateDeliveries, state);
    }
    if (samePath(filename, config.channelDeliveryStateFile)) {
      if (!repositories.channelDeliveries) {
        throw new TypeError("Channel delivery storage is not configured");
      }
      return saveChannelState(database, repositories.channelDeliveries, state);
    }
    if (samePath(filename, config.telegramStateFile)) {
      return saveTelegramState(repositories.telegram, state);
    }
    if (samePath(filename, config.exchangeRatesStateFile)) {
      return repositories.exchangeRates.save(state);
    }
    throw new TypeError("Unknown SQLite domain state route");
  };

  return {
    loadState,
    saveState,
    deleteUserData: (chatId) =>
      repositories.telegram.deleteUserAndPrivateDeliveries(
        chatId,
        repositories.privateDeliveries,
      ),
  };
}

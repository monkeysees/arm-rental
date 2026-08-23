/**
 * An in-memory stand-in for the SQLite state access, shaped like the
 * repositories rather than like the state files that used to back them. Each
 * domain answers with the state its repository rebuilds from rows, and the
 * private-delivery decisions are bounded to one recipient exactly as the
 * repository writes are, so a test cannot accidentally exercise a whole-state
 * write path that no longer exists.
 */

function recipientEntry(entry = {}) {
  return {
    notified: { ...(entry.notified || {}) },
    skipped: { ...(entry.skipped || {}) },
    filtered: { ...(entry.filtered || {}) },
    initialSelectionApplied: entry.initialSelectionApplied === true,
  };
}

export function emptyBotState(updateOffset = 0) {
  return {
    version: 3,
    type: "telegram-bot",
    updateOffset,
    users: {},
  };
}

export function createMemoryStateAccess({
  listUrlTemplate,
  channelConfigured = false,
  apartments,
  deliveries = {},
  channel,
  telegram = emptyBotState(),
  exchangeRates,
  // Awaited before every store write, so a test can observe ordering, delay a
  // write, or fail one the way a storage error would.
  onWrite = () => {},
} = {}) {
  let apartmentState = apartments;
  let channelState = channel;
  let telegramState = telegram;
  let exchangeRateState = exchangeRates;
  const recipients = Object.fromEntries(
    Object.entries(deliveries).map(([recipientId, entry]) => [
      recipientId,
      recipientEntry(entry),
    ]),
  );
  const writes = [];

  const write = async (domain, detail) => {
    writes.push({ domain, ...detail });
    await onWrite(domain, detail);
  };
  const recipient = (recipientId) => {
    const id = String(recipientId);
    recipients[id] ??= recipientEntry();
    return recipients[id];
  };
  const clone = (value) =>
    value === undefined ? undefined : structuredClone(value);

  return {
    writes,
    recipients,
    // Synchronous views of what the stores hold, for assertions.
    stored: {
      recipients,
      get apartments() {
        return apartmentState;
      },
      get channel() {
        return channelState;
      },
      get telegram() {
        return telegramState;
      },
      get exchangeRates() {
        return exchangeRateState;
      },
    },
    apartments: {
      load: async () => clone(apartmentState),
      save: async (state) => {
        await write("apartments", { state });
        apartmentState = structuredClone(state);
        return state;
      },
    },
    privateDeliveries: {
      loadRecipient: async (recipientId) =>
        recipients[String(recipientId)]
          ? structuredClone(recipients[String(recipientId)])
          : undefined,
      load: async () => ({
        version: 2,
        type: "telegram-deliveries",
        urlTemplate: listUrlTemplate,
        recipients: structuredClone(recipients),
      }),
      // The repository answers this from the rows without rebuilding them; the
      // stand-in holds too few to care, but it must judge the same timestamps
      // so a test can still refuse a malformed store.
      validate: async () =>
        Object.values(recipients).every((entry) =>
          ["notified", "skipped", "filtered"].every((status) =>
            Object.values(entry[status]).every((decidedAt) => {
              const milliseconds = Date.parse(decidedAt);
              return (
                Number.isFinite(milliseconds) &&
                new Date(milliseconds).toISOString() === decidedAt
              );
            }),
          ),
        ),
      removeRecipient: async (recipientId) => {
        await write("privateDeliveries", { removed: String(recipientId) });
        return delete recipients[String(recipientId)];
      },
      decisions: {
        applyInitialSelection: async (
          recipientId,
          { skipped = {}, filtered = {}, released = [] },
        ) => {
          await write("privateDeliveries", {
            recipientId,
            initialSelection: true,
          });
          const entry = recipient(recipientId);
          entry.initialSelectionApplied = true;
          for (const itemId of released) delete entry.filtered[itemId];
          for (const itemId of Object.keys(skipped))
            delete entry.filtered[itemId];
          Object.assign(entry.skipped, skipped);
          Object.assign(entry.filtered, filtered);
        },
        requestSelection: async (recipientId) => {
          await write("privateDeliveries", {
            recipientId,
            selectionRequested: true,
          });
          recipient(recipientId).initialSelectionApplied = false;
        },
        declineHistory: async (recipientId, skipped) => {
          await write("privateDeliveries", { recipientId, declined: skipped });
          const entry = recipient(recipientId);
          for (const itemId of Object.keys(skipped))
            delete entry.filtered[itemId];
          Object.assign(entry.skipped, skipped);
        },
        classifyFiltered: async (recipientId, filtered) => {
          await write("privateDeliveries", { recipientId, filtered });
          Object.assign(recipient(recipientId).filtered, filtered);
        },
        readmitFiltered: async (recipientId, itemIds) => {
          await write("privateDeliveries", {
            recipientId,
            readmitted: itemIds,
          });
          const entry = recipient(recipientId);
          for (const itemId of itemIds) delete entry.filtered[itemId];
        },
        acknowledge: async (recipientId, itemId, decidedAt) => {
          await write("privateDeliveries", { recipientId, itemId, decidedAt });
          recipient(recipientId).notified[itemId] = decidedAt;
        },
      },
    },
    channelDeliveries: channelConfigured
      ? {
          load: async () => clone(channelState),
          save: async (state) => {
            await write("channelDeliveries", { state });
            channelState = structuredClone(state);
            return state;
          },
        }
      : null,
    telegram: {
      load: async () => clone(telegramState),
      save: async (state) => {
        await write("telegram", { state });
        telegramState = structuredClone(state);
        return state;
      },
    },
    exchangeRates: {
      load: async () => clone(exchangeRateState),
      save: async (snapshot) => {
        await write("exchangeRates", { snapshot });
        exchangeRateState = structuredClone(snapshot);
        return snapshot;
      },
    },
    // The SQLite backend removes the user row and their delivery history in
    // one transaction; the in-memory stand-in mirrors that atomicity.
    deleteUserData: async (chatId) => {
      await write("deleteUserData", { chatId });
      const users = { ...telegramState.users };
      const userDeleted = delete users[String(chatId)];
      const recipientDeleted = delete recipients[String(chatId)];
      telegramState = { ...telegramState, users };
      if (telegramState.legacyRecipientId === String(chatId)) {
        delete telegramState.legacyRecipientId;
      }
      return {
        userDeleted: userDeleted ? 1 : 0,
        recipientDeleted: recipientDeleted ? 1 : 0,
      };
    },
  };
}

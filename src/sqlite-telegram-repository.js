import { compatibleBotState, migrateBotState } from "./bot.js";
import {
  nonnegativeSafeInteger,
  positiveSafeInteger,
  parseStoredJson,
  runRepositoryTransaction,
  serializeJson,
} from "./sqlite-repository-values.js";

function normalizedUser(user) {
  if (!user || typeof user !== "object" || Array.isArray(user))
    throw new TypeError("Telegram user must be an object");
  const chatId = positiveSafeInteger(user.chatId, "Telegram chat ID");
  const state = migrateBotState({
    version: 3,
    type: "telegram-bot",
    updateOffset: 0,
    users: { [chatId]: user },
  });
  return state.users[String(chatId)];
}

export class SqliteTelegramRepository {
  constructor(database) {
    this.database = database;
    this.selectState = database.prepare(
      "SELECT update_offset, legacy_recipient_id FROM telegram_state WHERE singleton = 1",
    );
    this.selectUsers = database.prepare(
      "SELECT * FROM telegram_users ORDER BY chat_id",
    );
    this.updateOffsetStatement = database.prepare(
      "UPDATE telegram_state SET update_offset = ? WHERE singleton = 1",
    );
    this.updateLegacyRecipient = database.prepare(
      "UPDATE telegram_state SET legacy_recipient_id = ? WHERE singleton = 1",
    );
    this.clearLegacyRecipient = database.prepare(
      "UPDATE telegram_state SET legacy_recipient_id = NULL WHERE singleton = 1 AND legacy_recipient_id = ?",
    );
    this.upsertUser = database.prepare(`INSERT INTO telegram_users(
      chat_id, active, send_initial_apartments, filters_json, pending_filter_input, deletion_pending_at
    ) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET
      active = excluded.active,
      send_initial_apartments = excluded.send_initial_apartments,
      filters_json = excluded.filters_json,
      pending_filter_input = excluded.pending_filter_input,
      deletion_pending_at = excluded.deletion_pending_at`);
    this.deleteUserStatement = database.prepare(
      "DELETE FROM telegram_users WHERE chat_id = ?",
    );
    this.clearUsers = database.prepare("DELETE FROM telegram_users");
  }

  load() {
    const stored = this.selectState.get();
    if (!stored) {
      const error = new Error("Stored Telegram state metadata is missing");
      error.code = "ERR_STATE_DATABASE_DOMAIN_INVALID";
      throw error;
    }
    const users = Object.fromEntries(
      this.selectUsers.all().map((row) => [
        String(row.chat_id),
        {
          chatId: Number(row.chat_id),
          active: Boolean(row.active),
          sendInitialApartments: Boolean(row.send_initial_apartments),
          filters: parseStoredJson(row.filters_json, "Telegram filters"),
          pendingFilterInput: row.pending_filter_input,
          ...(row.deletion_pending_at === null
            ? {}
            : { deletionPendingAt: row.deletion_pending_at }),
        },
      ]),
    );
    const state = {
      version: 3,
      type: "telegram-bot",
      updateOffset: Number(stored.update_offset),
      ...(stored.legacy_recipient_id === null
        ? {}
        : { legacyRecipientId: String(stored.legacy_recipient_id) }),
      users,
    };
    if (!compatibleBotState(state)) {
      const error = new Error("Stored Telegram state is incompatible");
      error.code = "ERR_STATE_DATABASE_DOMAIN_INVALID";
      throw error;
    }
    return migrateBotState(state);
  }

  saveUser(user, { transaction = true } = {}) {
    const normalized = normalizedUser(user);
    return runRepositoryTransaction(
      this.database,
      "telegram_user_save",
      transaction,
      () => this.writeUser(normalized),
    );
  }

  setUpdateOffset(updateOffset, { transaction = true } = {}) {
    nonnegativeSafeInteger(updateOffset, "Telegram update offset");
    return runRepositoryTransaction(
      this.database,
      "telegram_update_offset",
      transaction,
      () => {
        this.updateOffsetStatement.run(updateOffset);
        return updateOffset;
      },
    );
  }

  commitUpdate(
    updateOffset,
    { user, deleteChatId } = {},
    { transaction = true } = {},
  ) {
    nonnegativeSafeInteger(updateOffset, "Telegram update offset");
    if (user !== undefined && deleteChatId !== undefined)
      throw new TypeError("Telegram update can mutate only one user action");
    const normalized = user === undefined ? undefined : normalizedUser(user);
    const deletedId =
      deleteChatId === undefined
        ? undefined
        : positiveSafeInteger(deleteChatId, "Telegram chat ID");
    return runRepositoryTransaction(
      this.database,
      "telegram_update_commit",
      transaction,
      () => {
        if (normalized) this.writeUser(normalized);
        if (deletedId !== undefined) this.deleteUserStatement.run(deletedId);
        this.updateOffsetStatement.run(updateOffset);
        return updateOffset;
      },
    );
  }

  deleteUser(chatId, { transaction = true } = {}) {
    const id = positiveSafeInteger(chatId, "Telegram chat ID");
    return runRepositoryTransaction(
      this.database,
      "telegram_user_delete",
      transaction,
      () => Number(this.deleteUserStatement.run(id).changes),
    );
  }

  deleteUserAndPrivateDeliveries(chatId, privateDeliveriesRepository) {
    const id = positiveSafeInteger(chatId, "Telegram chat ID");
    if (!privateDeliveriesRepository?.deleteRecipient)
      throw new TypeError("Private-deliveries repository is required");
    return this.database.transaction("telegram_user_data_delete", () => {
      const decisionsDeleted = privateDeliveriesRepository.deleteRecipient(
        String(id),
        { transaction: false },
      );
      const userDeleted = Number(this.deleteUserStatement.run(id).changes);
      this.clearLegacyRecipient.run(id);
      return { userDeleted, recipientDeleted: decisionsDeleted };
    });
  }

  importState(state, { transaction = true } = {}) {
    const normalized = migrateBotState(state);
    nonnegativeSafeInteger(normalized.updateOffset, "Telegram update offset");
    const users = Object.values(normalized.users).map(normalizedUser);
    const legacyRecipientId =
      normalized.legacyRecipientId === undefined
        ? null
        : positiveSafeInteger(
            Number(normalized.legacyRecipientId),
            "Legacy Telegram recipient ID",
          );
    return runRepositoryTransaction(
      this.database,
      "telegram_import",
      transaction,
      () => {
        this.clearUsers.run();
        this.updateOffsetStatement.run(normalized.updateOffset);
        this.updateLegacyRecipient.run(legacyRecipientId);
        for (const user of users) this.writeUser(user);
        return users.length;
      },
    );
  }

  writeUser(user) {
    this.upsertUser.run(
      user.chatId,
      user.active ? 1 : 0,
      user.sendInitialApartments ? 1 : 0,
      serializeJson(user.filters, "Telegram filters"),
      user.pendingFilterInput,
      user.deletionPendingAt ?? null,
    );
    return user;
  }
}

import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { migrateApartmentState } from "./apartment-state.js";
import { publishChannelApartments } from "./channel.js";
import { crawlApartments } from "./crawler.js";
import { releasableHistory } from "./delivery-selection.js";
import {
  deleteDataMenu,
  deliveryAnnouncementText,
  filtersMenu,
  historyAcceptedText,
  HISTORY_DECLINED_TEXT,
  historyOfferMenu,
  initialDeliveryMenu,
  kindsMenu,
  locationsMenu,
  regionMenu,
  resetFilters,
  toggleKind,
  togglePlace,
  toggleWholeRegion,
} from "./filter-ui.js";
import {
  LOCATION_REGIONS,
  normalizeFilters,
  parseRangeInput,
} from "./filters.js";
import { isPropertyKind } from "./property-kind.js";
import {
  formatApartmentMessage,
  isMainMenuCommand,
  isStopCommand,
  TelegramApi,
} from "./telegram.js";
import {
  synchronizeTelegramMetadata,
  TELEGRAM_METADATA_RETRY_INTERVAL_MS,
} from "./telegram-metadata.js";
import { ExponentialBackoff, isExpectedExternalFailure } from "./retry.js";
import {
  createPrivateRateLimits,
  PrivateDeliveryBarrier,
  PrivateDeliveryRateLimiter,
} from "./rate-limit.js";

const ACCESS_DENIED_TEXT = (senderId) =>
  `Доступ к боту ограничен. Ваш Telegram ID: ${senderId}.`;
const RATE_LIMITED_TEXT =
  "Слишком много запросов. Пожалуйста, попробуйте ещё раз позже.";
const DELETE_NO_DATA_TEXT = "У бота нет сохранённых данных для удаления.";
const DELETE_CANCELLED_TEXT = "Удаление данных отменено.";
const DELETE_COMPLETED_TEXT = "Ваши данные удалены.";
const DELETE_CONFIRM_CALLBACK = "d:confirm";
const DELETE_CANCEL_CALLBACK = "d:cancel";
function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validDeletionTimestamp(value) {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function sameOrder(values, expected) {
  return (
    values.length === expected.length &&
    values.every((value, index) => value === expected[index])
  );
}

/**
 * Stored filters are accepted only in the exact shape this release writes.
 *
 * Housing kinds arrived after the first releases, so a stored filter may still
 * omit them; that record predates houses and means the apartments it has
 * always meant. Anything present, though, must already be normalized.
 */
function compatibleFilters(filters) {
  if (!plainObject(filters)) return false;
  if (
    !plainObject(filters.price) ||
    !plainObject(filters.rooms) ||
    !Array.isArray(filters.locations) ||
    (filters.kinds !== undefined && !Array.isArray(filters.kinds))
  ) {
    return false;
  }
  const normalized = normalizeFilters(filters);
  const exactKeys = (value, keys) =>
    Object.keys(value).sort().join(",") === [...keys].sort().join(",");
  return (
    (exactKeys(filters, ["price", "rooms", "locations"]) ||
      exactKeys(filters, ["kinds", "price", "rooms", "locations"])) &&
    exactKeys(filters.price, ["min", "max"]) &&
    exactKeys(filters.rooms, ["min", "max"]) &&
    ["min", "max"].every(
      (key) =>
        filters.price[key] === normalized.price[key] &&
        filters.rooms[key] === normalized.rooms[key],
    ) &&
    (filters.kinds === undefined ||
      sameOrder(filters.kinds, normalized.kinds)) &&
    sameOrder(filters.locations, normalized.locations)
  );
}

function compatibleBotUser(user, chatId, version) {
  if (!plainObject(user)) return false;
  if (user.chatId !== chatId) return false;
  if (user.active !== undefined && typeof user.active !== "boolean") {
    return false;
  }
  if (
    user.sendInitialApartments !== undefined &&
    typeof user.sendInitialApartments !== "boolean"
  ) {
    return false;
  }
  if (
    user.pendingFilterInput !== undefined &&
    user.pendingFilterInput !== null &&
    !["price", "rooms"].includes(user.pendingFilterInput)
  ) {
    return false;
  }
  if (user.filters !== undefined && !compatibleFilters(user.filters)) {
    return false;
  }
  if (version < 3 && Object.hasOwn(user, "deletionPendingAt")) return false;
  if (user.deletionPendingAt === undefined) return true;
  return (
    validDeletionTimestamp(user.deletionPendingAt) &&
    user.active === false &&
    user.pendingFilterInput === null
  );
}

export function compatibleBotState(state) {
  if (
    !plainObject(state) ||
    ![1, 2, 3].includes(state.version) ||
    state.type !== "telegram-bot" ||
    Object.hasOwn(state, "deletionPendingAt") ||
    !Number.isSafeInteger(state.updateOffset) ||
    state.updateOffset < 0
  ) {
    return false;
  }

  if (state.version === 1) {
    if (
      !positiveSafeInteger(state.ownerId) ||
      !(
        state.chatId === undefined ||
        state.chatId === null ||
        positiveSafeInteger(state.chatId)
      ) ||
      Object.hasOwn(state, "deletionPendingAt")
    ) {
      return false;
    }
    const chatId = state.chatId ?? state.ownerId;
    return compatibleBotUser(
      {
        chatId,
        active: state.active,
        sendInitialApartments: state.sendInitialApartments,
        filters: state.filters,
        pendingFilterInput: state.pendingFilterInput,
      },
      chatId,
      1,
    );
  }
  if (!plainObject(state.users)) return false;
  if (state.legacyRecipientId !== undefined) {
    const legacyRecipientId = Number(state.legacyRecipientId);
    if (
      !positiveSafeInteger(legacyRecipientId) ||
      String(legacyRecipientId) !== state.legacyRecipientId
    ) {
      return false;
    }
  }
  return Object.entries(state.users).every(([key, user]) => {
    const chatId = Number(key);
    return (
      positiveSafeInteger(chatId) &&
      String(chatId) === key &&
      compatibleBotUser(user, chatId, state.version)
    );
  });
}

function withFilterDefaults(user) {
  return {
    ...user,
    active: Boolean(user?.active),
    sendInitialApartments: user?.sendInitialApartments !== false,
    filters: normalizeFilters(user?.filters),
    pendingFilterInput: ["price", "rooms"].includes(user?.pendingFilterInput)
      ? user.pendingFilterInput
      : null,
  };
}

function defaultUser(chatId) {
  return withFilterDefaults({ active: false, chatId });
}

export function migrateBotState(state) {
  if (!compatibleBotState(state)) {
    throw new TypeError("Telegram bot state has an incompatible schema");
  }
  if (state.version === 1) {
    const chatId = state.chatId ?? state.ownerId;
    return {
      version: 3,
      type: state.type,
      updateOffset: state.updateOffset,
      legacyRecipientId: String(chatId),
      users: {
        [chatId]: withFilterDefaults({
          active: state.active,
          chatId,
          sendInitialApartments: state.sendInitialApartments,
          filters: state.filters,
          pendingFilterInput: state.pendingFilterInput,
        }),
      },
    };
  }

  const users = Object.fromEntries(
    Object.entries(state.users).map(([chatId, user]) => [
      chatId,
      withFilterDefaults({ ...user, chatId: Number(chatId) }),
    ]),
  );

  return {
    version: 3,
    type: state.type,
    updateOffset: state.updateOffset,
    ...(typeof state.legacyRecipientId === "string"
      ? { legacyRecipientId: state.legacyRecipientId }
      : {}),
    users,
  };
}

function userState(state, chatId) {
  return state.users[String(chatId)] || defaultUser(chatId);
}

function withUserState(state, chatId, user) {
  return {
    ...state,
    users: {
      ...state.users,
      [chatId]: withFilterDefaults({ ...user, chatId }),
    },
  };
}

function persistedUser(state, senderId) {
  return Object.hasOwn(state.users, String(senderId));
}

function withoutUser(state, senderId) {
  const users = { ...state.users };
  delete users[String(senderId)];
  const next = { ...state, users };
  if (next.legacyRecipientId === String(senderId)) {
    delete next.legacyRecipientId;
  }
  return next;
}

function deletionUpdateKind(update) {
  const callbackData = update.callback_query?.data;
  if (callbackData === DELETE_CONFIRM_CALLBACK) return "confirm";
  if (callbackData === DELETE_CANCEL_CALLBACK) return "cancel";
  return /^\/delete_my_data(?:@[a-z0-9_]+)?(?:\s|$)/iu.test(
    update.message?.text || "",
  )
    ? "request"
    : null;
}

export function isPrivateUserAuthorized(config, senderId) {
  if (!Number.isSafeInteger(senderId) || senderId <= 0) return false;
  if (senderId === config.telegramOwnerId) return true;
  const mode = config.telegramAccessMode ?? "public";
  if (mode === "public") return true;
  if (mode === "allowlist") {
    return (config.telegramAllowedUserIds ?? []).includes(senderId);
  }
  return false;
}

function effectiveActiveUsers(state, config) {
  return Object.values(state.users).filter(
    (user) =>
      user.active &&
      !user.deletionPendingAt &&
      isPrivateUserAuthorized(config, user.chatId),
  );
}

export function privateAccessSummary(state, config) {
  const users = Object.values(state.users || {});
  const authorizedUserCount = users.filter((user) =>
    isPrivateUserAuthorized(config, user.chatId),
  ).length;
  return {
    accessMode: config.telegramAccessMode ?? "public",
    persistedUserCount: users.length,
    authorizedUserCount,
    suspendedUserCount: users.length - authorizedUserCount,
    activeUserCount: effectiveActiveUsers(state, config).length,
  };
}

function privateUpdateContext(update) {
  const query = update.callback_query;
  const message = query?.message || update.message;
  const senderId = query?.from?.id ?? update.message?.from?.id;
  if (
    message?.chat?.type !== "private" ||
    !Number.isSafeInteger(senderId) ||
    senderId <= 0 ||
    senderId !== message.chat.id
  ) {
    return null;
  }
  return { message, query, senderId };
}

function waitForActivation(signal, subscribe) {
  if (signal?.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const done = () => {
      signal?.removeEventListener("abort", done);
      resolve();
    };
    signal?.addEventListener("abort", done, { once: true });
    subscribe(done);
  });
}

async function showFilterView(chatId, messageId, view, actions) {
  if (messageId && actions.editMessage) {
    await actions.editMessage(chatId, messageId, view.text, view.replyMarkup);
    return;
  }
  await actions.sendMessage(chatId, view.text, view.replyMarkup);
}

async function saveAndShowFilterView(state, chatId, messageId, view, actions) {
  await actions.saveState(state);
  await showFilterView(chatId, messageId, view, actions);
}

function validRegionIndex(value) {
  const index = Number(value);
  return Number.isSafeInteger(index) &&
    index >= 0 &&
    index < LOCATION_REGIONS.length
    ? index
    : null;
}

function validPlaceIndex(regionIndex, value) {
  const index = Number(value);
  return Number.isSafeInteger(index) &&
    index >= 0 &&
    index < LOCATION_REGIONS[regionIndex].places.length
    ? index
    : null;
}

async function processFilterCallback(query, state, actions) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const parts = String(query.data || "").split(":");
  const action = parts[1];
  let current = { ...state, pendingFilterInput: null };

  if (action === "price" || action === "rooms") {
    current = { ...current, pendingFilterInput: action };
    const instruction =
      action === "price"
        ? "Введите точную цену или диапазон в армянских драмах."
        : "Введите точное количество комнат или диапазон.";
    const examples =
      action === "price"
        ? "«100000-250000», «100000-» (от 100 000), «-250000» (до 250 000)"
        : "«1-3», «2-» (от 2), «-4» (до 4)";
    await actions.saveState(current);
    await actions.sendMessage(
      chatId,
      [
        instruction,
        `Примеры: ${examples}.`,
        "Чтобы снять это ограничение, отправьте «нет» или /clear.",
        "Чтобы отменить ввод и сохранить текущее значение фильтра, отправьте /cancel.",
      ].join("\n"),
    );
    return current;
  }

  if (action === "menu") {
    await saveAndShowFilterView(
      current,
      chatId,
      messageId,
      filtersMenu(current.filters, current.active),
      actions,
    );
    await actions.offerHistory(chatId, current);
    return current;
  }
  if (action === "locations") {
    await saveAndShowFilterView(
      current,
      chatId,
      messageId,
      locationsMenu(current.filters),
      actions,
    );
    return current;
  }
  if (action === "kinds") {
    await saveAndShowFilterView(
      current,
      chatId,
      messageId,
      kindsMenu(current.filters),
      actions,
    );
    return current;
  }
  if (action === "kind") {
    // An unknown kind can only come from a stale keyboard; redrawing the menu
    // shows the user what this release actually offers.
    if (isPropertyKind(parts[2])) {
      current = { ...current, filters: toggleKind(current.filters, parts[2]) };
    }
    await saveAndShowFilterView(
      current,
      chatId,
      messageId,
      kindsMenu(current.filters),
      actions,
    );
    return current;
  }
  if (action === "reset") {
    current = { ...current, filters: resetFilters() };
    await saveAndShowFilterView(
      current,
      chatId,
      messageId,
      filtersMenu(current.filters, current.active),
      actions,
    );
    await actions.offerHistory(chatId, current);
    return current;
  }
  const regionIndex = validRegionIndex(parts[2]);
  if (regionIndex === null) {
    await actions.saveState(current);
    return current;
  }

  if (action === "region") {
    await saveAndShowFilterView(
      current,
      chatId,
      messageId,
      regionMenu(current.filters, regionIndex),
      actions,
    );
    return current;
  }
  if (action === "all") {
    current = {
      ...current,
      filters: toggleWholeRegion(current.filters, regionIndex),
    };
    await saveAndShowFilterView(
      current,
      chatId,
      messageId,
      regionMenu(current.filters, regionIndex),
      actions,
    );
    return current;
  }
  if (action === "place") {
    const placeIndex = validPlaceIndex(regionIndex, parts[3]);
    if (placeIndex === null) {
      await actions.saveState(current);
      return current;
    }
    current = {
      ...current,
      filters: togglePlace(current.filters, regionIndex, placeIndex),
    };
    await saveAndShowFilterView(
      current,
      chatId,
      messageId,
      regionMenu(current.filters, regionIndex),
      actions,
    );
    return current;
  }

  await actions.saveState(current);
  return current;
}

export async function processUpdates(
  updates,
  config,
  state,
  {
    sendMessage,
    editMessage,
    answerCallback = async () => {},
    saveState,
    onSubscriptionChanged = async () => {},
    onAccessDenied = async () => {},
    onUserRateLimited = async () => {},
    onDeletionPending = async () => {},
    onDeletionCancelled = async () => {},
    onDeletionCallbackError = async () => {},
    offerHistory = async () => {},
    applyHistoryAnswer = async () => 0,
    requestSelection = async () => {},
    isPersistedUserAccessBypass = () => false,
    rateLimits,
    now = () => new Date(),
  },
) {
  let current = migrateBotState(state);
  const effectiveRateLimits =
    rateLimits ??
    createPrivateRateLimits(config.telegramUserUpdatesPerMinute ?? 30);

  for (const update of updates) {
    const nextOffset = Number.isSafeInteger(update.update_id)
      ? update.update_id + 1
      : current.updateOffset;
    current = {
      ...current,
      updateOffset: Math.max(current.updateOffset, nextOffset),
    };
    const query = update.callback_query;
    const context = privateUpdateContext(update);

    if (!context) {
      // Persist ignored and malformed updates before a callback acknowledgement
      // can fail, so replay cannot cross an authorization boundary twice.
      await saveState(current);
      if (query) await answerCallback(query.id);
      continue;
    }

    const { message, senderId } = context;
    const deletionKind = deletionUpdateKind(update);
    const hasPersistedUser = persistedUser(current, senderId);
    const accessBypass =
      hasPersistedUser &&
      (Boolean(deletionKind) ||
        isPersistedUserAccessBypass({ update, senderId }));
    if (!accessBypass && !isPrivateUserAuthorized(config, senderId)) {
      // A rejected update still advances durably before any later response or
      // callback acknowledgement can fail.
      await saveState(current);
      await onAccessDenied({
        accessMode: config.telegramAccessMode ?? "public",
        reason: "not_authorized",
      });
      if (query) await answerCallback(query.id);
      if (
        !query &&
        isMainMenuCommand(message.text) &&
        effectiveRateLimits.accessDeniedResponses.tryAcquire(senderId)
      ) {
        await sendMessage(senderId, ACCESS_DENIED_TEXT(senderId));
      }
      continue;
    }

    if (deletionKind && !hasPersistedUser) {
      if (!effectiveRateLimits.tryConsumeUpdate(senderId, update.update_id)) {
        await saveState(current);
        if (effectiveRateLimits.rateLimitedEvents.tryAcquire("aggregate")) {
          await onUserRateLimited({
            updatesPerMinute: config.telegramUserUpdatesPerMinute ?? 30,
          });
        }
        if (query) await answerCallback(query.id);
        if (effectiveRateLimits.rateLimitedResponses.tryAcquire(senderId)) {
          await sendMessage(senderId, RATE_LIMITED_TEXT);
        }
        continue;
      }
      await saveState(current);
      if (query) await answerCallback(query.id);
      if (effectiveRateLimits.deletionResponses.tryAcquire(senderId)) {
        await sendMessage(senderId, DELETE_NO_DATA_TEXT);
      }
      continue;
    }

    if (
      !accessBypass &&
      !effectiveRateLimits.tryConsumeUpdate(senderId, update.update_id)
    ) {
      await saveState(current);
      if (effectiveRateLimits.rateLimitedEvents.tryAcquire("aggregate")) {
        await onUserRateLimited({
          updatesPerMinute: config.telegramUserUpdatesPerMinute ?? 30,
        });
      }
      if (query) await answerCallback(query.id);
      if (effectiveRateLimits.rateLimitedResponses.tryAcquire(senderId)) {
        await sendMessage(senderId, RATE_LIMITED_TEXT);
      }
      continue;
    }

    const persisted = hasPersistedUser ? userState(current, senderId) : null;
    if (persisted?.deletionPendingAt) {
      await saveState(current);
      if (query) await answerCallback(query.id);
      continue;
    }

    if (deletionKind === "request") {
      await saveState(current);
      if (effectiveRateLimits.deletionResponses.tryAcquire(senderId)) {
        const view = deleteDataMenu();
        await sendMessage(senderId, view.text, view.replyMarkup);
        effectiveRateLimits.activateDeletionConfirmation(senderId);
      }
      continue;
    }

    if (deletionKind === "cancel") {
      const validConfirmation =
        effectiveRateLimits.retireDeletionConfirmation(senderId);
      await saveState(current);
      await answerCallback(query.id);
      if (validConfirmation) {
        await editMessage(
          senderId,
          query.message.message_id,
          DELETE_CANCELLED_TEXT,
        );
        await onDeletionCancelled();
      }
      continue;
    }

    if (deletionKind === "confirm") {
      if (!effectiveRateLimits.hasDeletionConfirmation(senderId)) {
        await saveState(current);
        await answerCallback(query.id);
        continue;
      }
      const user = userState(current, senderId);
      current = withUserState(current, senderId, {
        ...user,
        active: false,
        pendingFilterInput: null,
        deletionPendingAt: now().toISOString(),
      });
      await saveState(current);
      effectiveRateLimits.retireDeletionConfirmation(senderId);
      if (user.active) {
        await onSubscriptionChanged(current, {
          active: false,
          sendInitialApartments: user.sendInitialApartments,
        });
      }
      await onDeletionPending();
      try {
        await answerCallback(query.id);
      } catch (error) {
        await onDeletionCallbackError(error);
      }
      continue;
    }

    if (query) {
      if (query.data === "m:start") {
        const chatId = senderId;
        const user = userState(current, chatId);
        current = withUserState(current, chatId, {
          ...user,
          pendingFilterInput: null,
        });
        await saveState(current);
        await answerCallback(query.id);
        await showFilterView(
          chatId,
          query.message.message_id,
          initialDeliveryMenu(config.initialDeliveryLimit),
          { sendMessage, editMessage },
        );
        continue;
      }
      if (["m:start:initial", "m:start:new", "m:stop"].includes(query.data)) {
        const chatId = senderId;
        const user = userState(current, chatId);
        const active = query.data !== "m:stop";
        const sendInitialApartments =
          query.data === "m:stop"
            ? user.sendInitialApartments
            : query.data === "m:start:initial";
        current = withUserState(current, chatId, {
          ...user,
          active,
          sendInitialApartments,
          pendingFilterInput: null,
        });
        await saveState(current);
        // The answer is durable before the gate that consumes it reopens, so a
        // crash between the two leaves the previous classification standing
        // rather than releasing history against an answer nobody gave. The
        // gate reopens before activation wakes the crawl loop, so the first
        // crawl of this session already classifies the pause's backlog.
        if (active) await requestSelection(chatId);
        await answerCallback(query.id);
        await showFilterView(
          chatId,
          query.message.message_id,
          filtersMenu(user.filters, active),
          { sendMessage, editMessage },
        );
        if (user.active !== active) {
          await onSubscriptionChanged(current, {
            active,
            sendInitialApartments,
          });
        }
        continue;
      }
      if (["m:history:send", "m:history:skip"].includes(query.data)) {
        const chatId = senderId;
        const user = userState(current, chatId);
        const accepted = query.data === "m:history:send";
        // The classification write is what makes either answer durable; the
        // reply only reports it, so it follows the write.
        const count = await applyHistoryAnswer(chatId, user, accepted);
        await saveState(current);
        await answerCallback(query.id);
        await showFilterView(
          chatId,
          query.message.message_id,
          {
            text: accepted ? historyAcceptedText(count) : HISTORY_DECLINED_TEXT,
            // The answer is spent: dropping the keyboard leaves an answered
            // question rather than one that can be answered twice.
            replyMarkup: { inline_keyboard: [] },
          },
          { sendMessage, editMessage },
        );
        continue;
      }
      if (query.data?.startsWith("f:")) {
        const chatId = senderId;
        const actions = {
          sendMessage,
          editMessage,
          offerHistory,
          saveState: async (user) => {
            current = withUserState(current, chatId, user);
            await saveState(current);
          },
        };
        const user = await processFilterCallback(
          query,
          userState(current, chatId),
          actions,
        );
        current = withUserState(current, chatId, user);
        await answerCallback(query.id);
        continue;
      }
      // Unknown callbacks still advance their update offset durably before
      // acknowledgement so a failed acknowledgement cannot replay them.
      await saveState(current);
      await answerCallback(query.id);
      continue;
    }

    if (isMainMenuCommand(message.text)) {
      const user = userState(current, senderId);
      current = withUserState(current, senderId, {
        ...user,
        chatId: senderId,
        pendingFilterInput: null,
      });
      await saveState(current);
      const view = filtersMenu(user.filters, user.active);
      await sendMessage(senderId, view.text, view.replyMarkup);
      await offerHistory(senderId, user);
      continue;
    }

    let user = userState(current, senderId);

    if (isStopCommand(message.text)) {
      const wasActive = user.active;
      user = { ...user, active: false, pendingFilterInput: null };
      current = withUserState(current, senderId, user);
      const view = filtersMenu(user.filters, user.active);
      await saveState(current);
      await sendMessage(senderId, view.text, view.replyMarkup);
      if (wasActive) {
        await onSubscriptionChanged(current, {
          active: false,
          sendInitialApartments: user.sendInitialApartments,
        });
      }
      continue;
    }

    if (/^\/filters(?:@[a-z0-9_]+)?(?:\s|$)/iu.test(message.text || "")) {
      user = { ...user, pendingFilterInput: null };
      current = withUserState(current, senderId, user);
      const view = filtersMenu(user.filters, user.active);
      await saveState(current);
      await sendMessage(senderId, view.text, view.replyMarkup);
      await offerHistory(senderId, user);
      continue;
    }

    if (/^\/cancel(?:@[a-z0-9_]+)?(?:\s|$)/iu.test(message.text || "")) {
      user = { ...user, pendingFilterInput: null };
      current = withUserState(current, senderId, user);
      const view = filtersMenu(user.filters, user.active);
      await saveState(current);
      await sendMessage(senderId, view.text, view.replyMarkup);
      await offerHistory(senderId, user);
      continue;
    }

    if (
      user.pendingFilterInput &&
      /^\/clear(?:@[a-z0-9_]+)?(?:\s|$)/iu.test(message.text || "")
    ) {
      const filterName = user.pendingFilterInput;
      user = {
        ...user,
        filters: {
          ...user.filters,
          [filterName]: parseRangeInput("нет", filterName),
        },
        pendingFilterInput: null,
      };
      current = withUserState(current, senderId, user);
      const view = filtersMenu(user.filters, user.active);
      await saveState(current);
      await sendMessage(senderId, view.text, view.replyMarkup);
      await offerHistory(senderId, user);
      continue;
    }

    if (user.pendingFilterInput && message.text) {
      try {
        const range = parseRangeInput(message.text, user.pendingFilterInput);
        user = {
          ...user,
          filters: {
            ...user.filters,
            [user.pendingFilterInput]: range,
          },
          pendingFilterInput: null,
        };
        current = withUserState(current, senderId, user);
        await saveState(current);
        const view = filtersMenu(user.filters, user.active);
        await sendMessage(senderId, view.text, view.replyMarkup);
        await offerHistory(senderId, user);
      } catch (error) {
        await sendMessage(
          senderId,
          `${error.message}\nПопробуйте ещё раз, отправьте /clear, чтобы снять это ограничение, или /cancel, чтобы отменить ввод и сохранить текущее значение фильтра.`,
        );
      }
    }
  }

  if (updates.length > 0) await saveState(current);
  return current;
}

export async function runTelegramBot(
  config,
  {
    api,
    stateAccess,
    crawl = crawlApartments,
    publishChannel = publishChannelApartments,
    pageFetch = globalThis.fetch,
    sleep = delay,
    onResult = () => {},
    onError = () => {},
    onCrawlSettled = () => {},
    onMonitoringState = () => {},
    onPrivateAccessState = () => {},
    onPrivateAccessDenied = () => {},
    onPrivateUserRateLimited = () => {},
    onPrivateUserDeletionPending = () => {},
    onPrivateUserDeletionCancelled = () => {},
    onPrivateUserDeletionCompleted = () => {},
    onPrivateMonitoringChanged = () => {},
    onPrivateUserDeactivated = () => {},
    onPrivateHistoryDecision = () => {},
    onTelegramMetadataSynchronizationFailed = () => {},
    onTelegramMetadataSynchronized = () => {},
    onTelegramSuccess = () => {},
    onChannelOperation = () => {},
    onChannelFilterFingerprintChange = () => {},
    onSourceIntegrityChecked = () => {},
    onRetry = () => {},
    exchangeRateService,
    metadataRetryIntervalMs = TELEGRAM_METADATA_RETRY_INTERVAL_MS,
    monotonicNow,
    now = () => new Date(),
    signal,
  } = {},
) {
  api ??= new TelegramApi(config.telegramBotToken, {
    timeoutMs: config.timeoutMs,
    retryBaseMs: config.externalRetryBaseMs,
    retryMaxMs: config.externalRetryMaxMs,
    onRetry,
  });
  // The Telegram store always answers with a state; an empty installation
  // reports offset zero and no users rather than nothing at all.
  let state = migrateBotState(await stateAccess.telegram.load());
  let activationWaiter;
  let lastCrawlAttemptStartedAt;
  let botStateMutation = Promise.resolve();
  let deliveryStateMutation = Promise.resolve();
  const privateRateLimits = createPrivateRateLimits(
    config.telegramUserUpdatesPerMinute ?? 30,
    { ...(monotonicNow ? { monotonicNow } : {}) },
  );
  const privateDeliveryRateLimiter = new PrivateDeliveryRateLimiter({
    deliveriesPerMinute: config.telegramPrivateDeliveriesPerMinute ?? 20,
    sleep,
    ...(monotonicNow ? { monotonicNow } : {}),
  });
  const privateDeliveryBarrier = new PrivateDeliveryBarrier();
  const withDeliveryStateMutation = (operation) => {
    const pending = deliveryStateMutation.then(operation);
    deliveryStateMutation = pending.catch(() => {});
    return pending;
  };
  const withBotStateMutation = (operation) => {
    const pending = botStateMutation.then(operation);
    botStateMutation = pending.catch(() => {});
    return pending;
  };
  const persistBotState = async (value) => {
    await stateAccess.telegram.save(value);
    state = value;
    privateRateLimits.acknowledgeOffset(value.updateOffset);
  };

  const pendingDeletionIds = () =>
    Object.values(state.users)
      .filter(({ deletionPendingAt }) => Boolean(deletionPendingAt))
      .map(({ chatId }) => chatId);
  const recoverPendingDeletions = async (recovered) => {
    for (const senderId of pendingDeletionIds()) {
      privateDeliveryBarrier.block(senderId);
      await privateDeliveryRateLimiter.cancelRecipient(senderId);
      await privateDeliveryBarrier.drain(senderId);
      // The user row and their delivery history are removed in one
      // transaction, so a crash can only leave the deletion still pending and
      // the next startup replays it.
      const removed = await withBotStateMutation(() =>
        withDeliveryStateMutation(async () => {
          const user = state.users[String(senderId)];
          if (!user?.deletionPendingAt) return false;
          await stateAccess.deleteUserData(senderId);
          state = withoutUser(state, senderId);
          return true;
        }),
      );
      privateRateLimits.clearSenderBuckets(senderId);
      privateDeliveryRateLimiter.clearRecipient(senderId);
      privateDeliveryBarrier.clear(senderId);
      if (!removed) continue;
      await onPrivateUserDeletionCompleted({ recovered });
      try {
        await api.sendMessage(senderId, DELETE_COMPLETED_TEXT, signal);
      } catch (error) {
        await onError(error, {
          component: "telegram",
          operation: "private-data-deletion-completion",
        });
      }
    }
  };

  await recoverPendingDeletions(true);
  let lastAccessSummary;
  const reportAccessState = async () => {
    const summary = privateAccessSummary(state, config);
    const signature = JSON.stringify(summary);
    if (signature === lastAccessSummary) return;
    lastAccessSummary = signature;
    await onPrivateAccessState(summary);
  };
  await onMonitoringState({
    active: effectiveActiveUsers(state, config).length > 0,
    channelConfigured: Boolean(config.telegramChannelId),
  });
  await reportAccessState();

  const activate = () => {
    activationWaiter?.();
    activationWaiter = undefined;
  };
  /**
   * The rejected history a user's current filters would release.
   *
   * Delivery classifies against the filters that were in force at the time, so
   * widening one leaves matches sitting in the rejected group. The crawl never
   * releases them on its own; the menu offers them, and this is the set behind
   * both the offer and the answer. Stored records are read as the crawl left
   * them: a legacy price that has not been normalized yet carries no AMD
   * amount, so it simply does not match until the next crawl rewrites it.
   */
  const releasableHistoryFor = async (chatId, user) => {
    if (!user?.active || user.deletionPendingAt) return [];
    const recipient = await stateAccess.privateDeliveries.loadRecipient(chatId);
    if (!recipient || Object.keys(recipient.filtered).length === 0) return [];
    const apartmentState = migrateApartmentState(
      await stateAccess.apartments.load(),
      config.listUrlTemplate,
    );
    if (!apartmentState) return [];
    return releasableHistory(
      // Legacy state carries no source order; the next crawl rebuilds it, and
      // until then there is no defensible "newest first" to offer.
      apartmentState.apartmentOrder ?? [],
      apartmentState.apartments,
      recipient,
      normalizeFilters(user.filters),
      now().getTime(),
    ).slice(0, config.initialDeliveryLimit);
  };
  /**
   * Records the answer to a history offer against the current candidates.
   *
   * Accepting clears the rejection so the next crawl delivers the apartment
   * with the rest of its batch; declining marks it skipped, which delivery
   * never releases. Both pass through the delivery-state chain, so an answer
   * cannot interleave with a crawl's classification or a pending deletion.
   */
  const applyHistoryAnswer = async (chatId, user, accepted) => {
    const releasable = await releasableHistoryFor(chatId, user);
    if (releasable.length === 0) return 0;
    const recipientId = String(chatId);
    const decisions = stateAccess.privateDeliveries.decisions;
    await withDeliveryStateMutation(() =>
      accepted
        ? decisions.readmitFiltered(recipientId, releasable)
        : decisions.declineHistory(
            recipientId,
            Object.fromEntries(
              releasable.map((itemId) => [itemId, now().toISOString()]),
            ),
          ),
    );
    await onPrivateHistoryDecision({
      accepted,
      count: releasable.length,
    });
    return releasable.length;
  };
  /**
   * Reopens the recipient's selection gate for the answer just persisted.
   *
   * The next crawl then classifies whatever accumulated while monitoring was
   * off against that answer, instead of treating a pause's backlog as news.
   */
  const requestSelection = (chatId) =>
    withDeliveryStateMutation(() =>
      stateAccess.privateDeliveries.decisions.requestSelection(String(chatId)),
    );
  const deactivateUnavailableUser = async (chatId, reason) => {
    const changed = await withBotStateMutation(async () => {
      if (!persistedUser(state, chatId)) return false;
      const user = userState(state, chatId);
      await persistBotState(
        withUserState(state, chatId, { ...user, active: false }),
      );
      return true;
    });
    if (!changed) return;
    await onMonitoringState({
      active: effectiveActiveUsers(state, config).length > 0,
      channelConfigured: Boolean(config.telegramChannelId),
    });
    await reportAccessState();
    await onPrivateUserDeactivated({ reason });
  };
  const updateBackoff = new ExponentialBackoff({
    baseDelayMs: config.externalRetryBaseMs || 1_000,
    maxDelayMs: config.externalRetryMaxMs || 60_000,
  });
  const crawlBackoff = new ExponentialBackoff({
    baseDelayMs: config.externalRetryBaseMs || 1_000,
    maxDelayMs: config.externalRetryMaxMs || 60_000,
  });

  const updateLoop = async () => {
    while (!signal?.aborted) {
      try {
        if (pendingDeletionIds().length > 0) {
          await recoverPendingDeletions(true);
        }
        privateRateLimits.pruneInactive();
        privateDeliveryRateLimiter.pruneInactive();
        const unavailableUsers = new Map();
        const sendMessage = async (chatId, text, replyMarkup) => {
          try {
            return await api.sendMessage(chatId, text, signal, replyMarkup);
          } catch (error) {
            if (!error.terminal) throw error;
            unavailableUsers.set(
              chatId,
              error.code || "ERR_TELEGRAM_PRIVATE_UNAVAILABLE",
            );
            return undefined;
          }
        };
        const editMessage = async (chatId, messageId, text, replyMarkup) => {
          try {
            return await api.editMessageText(
              chatId,
              messageId,
              text,
              signal,
              replyMarkup,
            );
          } catch (error) {
            if (!error.terminal) throw error;
            unavailableUsers.set(
              chatId,
              error.code || "ERR_TELEGRAM_PRIVATE_UNAVAILABLE",
            );
            return undefined;
          }
        };
        const updates = await api.getUpdates(
          state.updateOffset,
          config.telegramPollTimeoutSeconds,
          signal,
        );
        state = await withBotStateMutation(() =>
          processUpdates(updates, config, state, {
            sendMessage,
            editMessage,
            offerHistory: async (chatId, user) => {
              const releasable = await releasableHistoryFor(chatId, user);
              if (releasable.length === 0) return;
              const view = historyOfferMenu(releasable.length);
              await sendMessage(chatId, view.text, view.replyMarkup);
            },
            applyHistoryAnswer,
            requestSelection,
            answerCallback: (callbackQueryId) =>
              api.answerCallbackQuery(callbackQueryId, signal),
            saveState: persistBotState,
            onSubscriptionChanged: async (
              changedState,
              { active, sendInitialApartments },
            ) => {
              state = changedState;
              if (active) activate();
              await onMonitoringState({
                active: effectiveActiveUsers(state, config).length > 0,
                channelConfigured: Boolean(config.telegramChannelId),
              });
              await onPrivateMonitoringChanged({
                active,
                activeUserCount: effectiveActiveUsers(state, config).length,
                sendInitialApartments,
              });
            },
            onAccessDenied: onPrivateAccessDenied,
            onUserRateLimited: onPrivateUserRateLimited,
            onDeletionPending: onPrivateUserDeletionPending,
            onDeletionCancelled: onPrivateUserDeletionCancelled,
            onDeletionCallbackError: (error) =>
              onError(error, {
                component: "telegram",
                operation: "private-data-deletion-callback",
              }),
            rateLimits: privateRateLimits,
            now,
          }),
        );
        if (pendingDeletionIds().length > 0) {
          await recoverPendingDeletions(false);
        }
        await reportAccessState();
        for (const [chatId, reason] of unavailableUsers) {
          await deactivateUnavailableUser(chatId, reason);
        }
        await onTelegramSuccess();
        updateBackoff.reset();
      } catch (error) {
        if (signal?.aborted) return;
        await onError(error, { component: "telegram" });
        if (error.terminal) throw error;
        const retryDelayMs = isExpectedExternalFailure(error)
          ? updateBackoff.nextDelay()
          : 2_000;
        await onRetry({
          component: "telegram",
          operation: "update-poll",
          delayMs: retryDelayMs,
        });
        await sleep(retryDelayMs, undefined, { signal }).catch((sleepError) => {
          if (sleepError.name !== "AbortError") throw sleepError;
        });
      }
    }
  };

  const monitorLoop = async () => {
    while (!signal?.aborted) {
      let wokeFromDormancy = false;
      if (
        effectiveActiveUsers(state, config).length === 0 &&
        !config.telegramChannelId
      ) {
        await waitForActivation(signal, (resolve) => {
          activationWaiter = resolve;
        });
        if (signal?.aborted) return;
        wokeFromDormancy = true;
      }

      if (wokeFromDormancy && lastCrawlAttemptStartedAt !== undefined) {
        const now = monotonicNow?.() ?? performance.now();
        const remainingIntervalMs = Math.max(
          0,
          config.pollIntervalMs - (now - lastCrawlAttemptStartedAt),
        );
        if (remainingIntervalMs > 0) {
          try {
            await sleep(remainingIntervalMs, undefined, { signal });
          } catch (error) {
            if (error.name !== "AbortError") throw error;
            return;
          }
        }
      }

      if (
        effectiveActiveUsers(state, config).length === 0 &&
        !config.telegramChannelId
      ) {
        continue;
      }

      let failureComponent = "cba";
      const crawlId = randomUUID();
      const crawlStartedAt = Date.now();
      lastCrawlAttemptStartedAt = monotonicNow?.() ?? performance.now();
      try {
        const exchangeRates = await exchangeRateService?.getSnapshot(signal);
        failureComponent = "list_am";
        const privateUsers = effectiveActiveUsers(state, config);
        let channelResult = {
          sentCount: 0,
          editedCount: 0,
          filteredCount: 0,
          skippedCount: 0,
          readmittedCount: 0,
        };
        const result = await crawl(config, {
          fetchPage: pageFetch,
          stateAccess,
          exchangeRates,
          onSourceIntegrityChecked: (observation) =>
            onSourceIntegrityChecked({ ...observation, crawlId }),
          ...(privateUsers.length > 0
            ? {
                privateDeliveries: privateUsers.map((user) => {
                  const isAuthorized = () => {
                    const currentUser = state.users[String(user.chatId)];
                    return Boolean(
                      currentUser?.active &&
                      !currentUser.deletionPendingAt &&
                      isPrivateUserAuthorized(config, user.chatId),
                    );
                  };
                  const sendPrivate = async (text) => {
                    try {
                      await privateDeliveryRateLimiter.run(
                        String(user.chatId),
                        async (deliverySignal) => {
                          if (!isAuthorized()) {
                            const error = new Error(
                              "Private recipient is no longer available",
                            );
                            error.privateRecipientUnavailable = true;
                            throw error;
                          }
                          await api.sendMessage(
                            user.chatId,
                            text,
                            deliverySignal,
                          );
                        },
                        { signal },
                      );
                    } catch (error) {
                      if (error.privateRecipientUnavailable) throw error;
                      error.privateDeliveryFailure = true;
                      if (error.terminal) {
                        // A user can block the bot at any time. Remove that
                        // private subscription without terminating monitoring
                        // for every other user or the public channel.
                        if (isAuthorized()) {
                          await deactivateUnavailableUser(
                            user.chatId,
                            error.code || "ERR_TELEGRAM_PRIVATE_UNAVAILABLE",
                          );
                        }
                        error.privateRecipientUnavailable = true;
                        error.terminal = false;
                      }
                      throw error;
                    }
                  };
                  return {
                    recipientId: String(user.chatId),
                    filters: user.filters,
                    sendInitialApartments: user.sendInitialApartments,
                    isAuthorized,
                    runDeliveryWorker: (operation) =>
                      privateDeliveryBarrier.run(user.chatId, operation),
                    // The heads-up that precedes a batch carrying history is a
                    // delivery like any other: it waits behind the same
                    // product-rate bucket and rechecks authorization, so it
                    // cannot outrun a suspension or burst past Telegram.
                    announceDelivery: ({ count }) =>
                      sendPrivate(deliveryAnnouncementText(count)),
                    deliverApartment: (apartment) =>
                      sendPrivate(formatApartmentMessage(apartment)),
                  };
                }),
                deliveryStateMutation: withDeliveryStateMutation,
              }
            : {}),
          ...(config.telegramChannelId
            ? {
                afterStateSaved: async (apartmentState) => {
                  try {
                    channelResult = await publishChannel(
                      config,
                      apartmentState,
                      {
                        api,
                        signal,
                        stateStore: stateAccess.channelDeliveries,
                        onOperation: (event) =>
                          onChannelOperation({
                            ...event,
                            crawlId,
                            durationMs: Date.now() - crawlStartedAt,
                          }),
                        onFilterFingerprintChange: (event) =>
                          onChannelFilterFingerprintChange({
                            ...event,
                            crawlId,
                            durationMs: Date.now() - crawlStartedAt,
                          }),
                      },
                    );
                  } catch (error) {
                    if (error.terminal) {
                      error.channelPermissionFailure = true;
                      throw error;
                    }
                    await onError(error, {
                      component: "telegram-channel",
                      crawlId,
                      durationMs: Date.now() - crawlStartedAt,
                    });
                  }
                },
              }
            : {}),
        });
        crawlBackoff.reset();
        await onResult({
          ...result,
          channel: channelResult,
          crawlId,
          durationMs: Date.now() - crawlStartedAt,
        });
      } catch (error) {
        if (signal?.aborted) return;
        const component = error.channelPermissionFailure
          ? "telegram-channel"
          : error.privateDeliveryFailure
            ? "telegram"
            : failureComponent;
        await onError(error, {
          component,
          crawlFailure: true,
          crawlId,
          durationMs: Date.now() - crawlStartedAt,
        });
        if (error.terminal) throw error;
        if (isExpectedExternalFailure(error)) {
          const retryDelayMs = crawlBackoff.nextDelay();
          await onRetry({
            component,
            operation: "crawl",
            crawlId,
            delayMs: retryDelayMs,
          });
          try {
            await sleep(retryDelayMs, undefined, { signal });
          } catch (sleepError) {
            if (sleepError.name !== "AbortError") throw sleepError;
            return;
          }
          continue;
        }
      } finally {
        // The crawl's pages belong to one browsing session, so the browser is
        // released here rather than after each page. Runs on every exit from
        // the attempt, including the retry `continue` and the abort `return`,
        // so no path leaves a browser alive across the poll interval. The
        // handler owns its own failures: throwing here would replace whatever
        // error the crawl was already reporting.
        await onCrawlSettled({ crawlId });
      }

      try {
        await sleep(config.pollIntervalMs, undefined, { signal });
      } catch (error) {
        if (error.name !== "AbortError") throw error;
      }
    }
  };

  const exchangeRateLoop = async () => {
    if (!exchangeRateService) return;

    while (!signal?.aborted) {
      try {
        await exchangeRateService.getSnapshot(signal);
      } catch {
        if (signal?.aborted) return;
        // The service reports fallback and cold-start failures through its
        // dedicated onFetchError callback.
      }

      try {
        await sleep(60_000, undefined, { signal });
      } catch (error) {
        if (error.name !== "AbortError") throw error;
      }
    }
  };

  const metadataLoop = async () => {
    while (!signal?.aborted) {
      try {
        await synchronizeTelegramMetadata(api, signal);
      } catch (error) {
        if (signal?.aborted) return;
        await onTelegramMetadataSynchronizationFailed(error, {
          retryDelayMs: metadataRetryIntervalMs,
        });
        try {
          await sleep(metadataRetryIntervalMs, undefined, { signal });
        } catch (sleepError) {
          if (sleepError.name !== "AbortError") throw sleepError;
          return;
        }
        continue;
      }

      await onTelegramMetadataSynchronized();
      return;
    }
  };

  await Promise.all([
    metadataLoop(),
    updateLoop(),
    monitorLoop(),
    exchangeRateLoop(),
  ]);
}

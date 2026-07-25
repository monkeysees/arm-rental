import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { publishChannelApartments } from "./channel.js";
import { crawlApartments } from "./crawler.js";
import {
  filtersMenu,
  initialDeliveryMenu,
  locationsMenu,
  regionMenu,
  resetFilters,
  togglePlace,
  toggleWholeRegion,
} from "./filter-ui.js";
import {
  LOCATION_REGIONS,
  normalizeFilters,
  parseRangeInput,
} from "./filters.js";
import { readState, writeState } from "./state.js";
import {
  formatApartmentMessage,
  isStartCommand,
  TelegramApi,
} from "./telegram.js";
import { ExponentialBackoff, isExpectedExternalFailure } from "./retry.js";
import {
  createPrivateRateLimits,
  PrivateDeliveryRateLimiter,
} from "./rate-limit.js";

const ACCESS_DENIED_TEXT = (senderId) =>
  `Доступ к боту ограничен. Ваш Telegram ID: ${senderId}.`;
const RATE_LIMITED_TEXT =
  "Слишком много запросов. Пожалуйста, попробуйте ещё раз позже.";

export function compatibleBotState(state) {
  return Boolean(
    state &&
    [1, 2].includes(state.version) &&
    state.type === "telegram-bot" &&
    (state.version === 1
      ? Number.isSafeInteger(state.ownerId) && state.ownerId > 0
      : state.users &&
        typeof state.users === "object" &&
        !Array.isArray(state.users)),
  );
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

function withBotDefaults(state) {
  if (state.version === 1) {
    const chatId = state.chatId ?? state.ownerId;
    return {
      version: 2,
      type: state.type,
      updateOffset: state.updateOffset || 0,
      legacyRecipientId: String(chatId),
      users: {
        [chatId]: withFilterDefaults({
          active: state.active,
          chatId,
          filters: state.filters,
          pendingFilterInput: state.pendingFilterInput,
        }),
      },
    };
  }

  const users = Object.fromEntries(
    Object.entries(state.users || {})
      .filter(([chatId, user]) => {
        const parsedChatId = Number(chatId);
        return (
          Number.isSafeInteger(parsedChatId) &&
          parsedChatId > 0 &&
          user &&
          typeof user === "object" &&
          !Array.isArray(user)
        );
      })
      .map(([chatId, user]) => [
        chatId,
        withFilterDefaults({ ...user, chatId: Number(chatId) }),
      ]),
  );

  return {
    version: 2,
    type: state.type,
    updateOffset: state.updateOffset || 0,
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
        "Чтобы снять ограничение, отправьте «нет».",
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
  if (action === "reset") {
    current = { ...current, filters: resetFilters() };
    await saveAndShowFilterView(
      current,
      chatId,
      messageId,
      filtersMenu(current.filters, current.active),
      actions,
    );
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
    isPersistedUserAccessBypass = () => false,
    rateLimits,
  },
) {
  let current = withBotDefaults(state);
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
      if (query) await answerCallback(query.id);
      continue;
    }

    const { message, senderId } = context;
    const accessBypass =
      persistedUser(current, senderId) &&
      isPersistedUserAccessBypass({ update, senderId });
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
        isStartCommand(message.text) &&
        effectiveRateLimits.accessDeniedResponses.tryAcquire(senderId)
      ) {
        await sendMessage(senderId, ACCESS_DENIED_TEXT(senderId));
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

    if (query) {
      await answerCallback(query.id);
      if (query.data === "m:start") {
        const chatId = senderId;
        const user = userState(current, chatId);
        current = withUserState(current, chatId, {
          ...user,
          pendingFilterInput: null,
        });
        await saveState(current);
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
      if (query.data?.startsWith("f:")) {
        const chatId = senderId;
        const actions = {
          sendMessage,
          editMessage,
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
      }
      continue;
    }

    if (isStartCommand(message.text)) {
      const user = userState(current, senderId);
      current = withUserState(current, senderId, {
        ...user,
        chatId: senderId,
        pendingFilterInput: null,
      });
      await saveState(current);
      const view = filtersMenu(user.filters, user.active);
      await sendMessage(senderId, view.text, view.replyMarkup);
      continue;
    }

    let user = userState(current, senderId);

    if (/^\/filters(?:@[a-z0-9_]+)?(?:\s|$)/iu.test(message.text || "")) {
      user = { ...user, pendingFilterInput: null };
      current = withUserState(current, senderId, user);
      const view = filtersMenu(user.filters, user.active);
      await saveState(current);
      await sendMessage(senderId, view.text, view.replyMarkup);
      continue;
    }

    if (/^\/cancel(?:@[a-z0-9_]+)?(?:\s|$)/iu.test(message.text || "")) {
      user = { ...user, pendingFilterInput: null };
      current = withUserState(current, senderId, user);
      await saveState(current);
      await sendMessage(senderId, "Ввод фильтра отменён.");
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
      } catch (error) {
        await sendMessage(
          senderId,
          `${error.message}\nПопробуйте ещё раз или отправьте команду /cancel.`,
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
    loadState = readState,
    saveState = writeState,
    crawl = crawlApartments,
    publishChannel = publishChannelApartments,
    pageFetch = globalThis.fetch,
    sleep = delay,
    onResult = () => {},
    onError = () => {},
    onMonitoringState = () => {},
    onPrivateAccessState = () => {},
    onPrivateAccessDenied = () => {},
    onPrivateUserRateLimited = () => {},
    onPrivateMonitoringChanged = () => {},
    onPrivateUserDeactivated = () => {},
    onTelegramSuccess = () => {},
    onChannelOperation = () => {},
    onChannelFilterFingerprintChange = () => {},
    onRetry = () => {},
    exchangeRateService,
    monotonicNow,
    signal,
  } = {},
) {
  api ??= new TelegramApi(config.telegramBotToken, {
    timeoutMs: config.timeoutMs,
    retryBaseMs: config.externalRetryBaseMs,
    retryMaxMs: config.externalRetryMaxMs,
    onRetry,
  });
  const stored = await loadState(config.telegramStateFile);
  let state = compatibleBotState(stored)
    ? withBotDefaults(stored)
    : {
        version: 2,
        type: "telegram-bot",
        updateOffset: 0,
        users: {},
      };
  let activationWaiter;
  let lastCrawlAttemptStartedAt;
  let botStateMutation = Promise.resolve();
  const withBotStateMutation = (operation) => {
    const pending = botStateMutation.then(operation);
    botStateMutation = pending.catch(() => {});
    return pending;
  };
  const persistBotState = async (value) => {
    await saveState(config.telegramStateFile, value);
    state = value;
  };
  const privateRateLimits = createPrivateRateLimits(
    config.telegramUserUpdatesPerMinute ?? 30,
    { ...(monotonicNow ? { monotonicNow } : {}) },
  );
  const privateDeliveryRateLimiter = new PrivateDeliveryRateLimiter({
    deliveriesPerMinute: config.telegramPrivateDeliveriesPerMinute ?? 20,
    sleep,
    ...(monotonicNow ? { monotonicNow } : {}),
  });
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
        privateRateLimits.pruneInactive();
        privateDeliveryRateLimiter.pruneInactive();
        const unavailableUsers = new Map();
        const updates = await api.getUpdates(
          state.updateOffset,
          config.telegramPollTimeoutSeconds,
          signal,
        );
        state = await withBotStateMutation(() =>
          processUpdates(updates, config, state, {
            sendMessage: async (chatId, text, replyMarkup) => {
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
            },
            editMessage: async (chatId, messageId, text, replyMarkup) => {
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
            },
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
            rateLimits: privateRateLimits,
          }),
        );
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
        };
        const result = await crawl(config, {
          fetchPage: pageFetch,
          exchangeRates,
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
                  return {
                    recipientId: String(user.chatId),
                    filters: user.filters,
                    sendInitialApartments: user.sendInitialApartments,
                    isAuthorized,
                    deliverApartment: async (apartment) => {
                      try {
                        await privateDeliveryRateLimiter.run(
                          String(user.chatId),
                          async () => {
                            if (!isAuthorized()) {
                              const error = new Error(
                                "Private recipient is no longer available",
                              );
                              error.privateRecipientUnavailable = true;
                              throw error;
                            }
                            await api.sendMessage(
                              user.chatId,
                              formatApartmentMessage(apartment),
                              signal,
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
                          await deactivateUnavailableUser(
                            user.chatId,
                            error.code || "ERR_TELEGRAM_PRIVATE_UNAVAILABLE",
                          );
                          error.privateRecipientUnavailable = true;
                          error.terminal = false;
                        }
                        throw error;
                      }
                    },
                  };
                }),
                legacyRecipientId:
                  state.legacyRecipientId || String(config.telegramOwnerId),
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

  await Promise.all([updateLoop(), monitorLoop(), exchangeRateLoop()]);
}

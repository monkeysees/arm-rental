import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { publishChannelApartments } from "./channel.js";
import { crawlApartments } from "./crawler.js";
import {
  filtersMenu,
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

function activeUsers(state) {
  return Object.values(state.users).filter(({ active }) => active);
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
  },
) {
  let current = withBotDefaults(state);

  for (const update of updates) {
    current = { ...current, updateOffset: update.update_id + 1 };
    const query = update.callback_query;
    const isPrivateCallback =
      query?.message?.chat?.type === "private" &&
      query.from?.id === query.message.chat.id;

    if (query) {
      await answerCallback(query.id);
      if (isPrivateCallback && ["m:start", "m:stop"].includes(query.data)) {
        const chatId = query.message.chat.id;
        const user = userState(current, chatId);
        const active = query.data === "m:start";
        current = withUserState(current, chatId, {
          ...user,
          active,
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
          await onSubscriptionChanged(current, { active });
        }
        continue;
      }
      if (isPrivateCallback && query.data?.startsWith("f:")) {
        const chatId = query.message.chat.id;
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

    const message = update.message;
    const isPrivateChat =
      message?.chat?.type === "private" && message.from?.id === message.chat.id;

    if (isPrivateChat && isStartCommand(message.text)) {
      const user = userState(current, message.chat.id);
      current = withUserState(current, message.chat.id, {
        ...user,
        chatId: message.chat.id,
        pendingFilterInput: null,
      });
      await saveState(current);
      const view = filtersMenu(user.filters, user.active);
      await sendMessage(message.chat.id, view.text, view.replyMarkup);
      continue;
    }

    if (!isPrivateChat) continue;

    let user = userState(current, message.chat.id);

    if (/^\/filters(?:@[a-z0-9_]+)?(?:\s|$)/iu.test(message.text || "")) {
      user = { ...user, pendingFilterInput: null };
      current = withUserState(current, message.chat.id, user);
      const view = filtersMenu(user.filters, user.active);
      await saveState(current);
      await sendMessage(message.chat.id, view.text, view.replyMarkup);
      continue;
    }

    if (/^\/cancel(?:@[a-z0-9_]+)?(?:\s|$)/iu.test(message.text || "")) {
      user = { ...user, pendingFilterInput: null };
      current = withUserState(current, message.chat.id, user);
      await saveState(current);
      await sendMessage(message.chat.id, "Ввод фильтра отменён.");
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
        current = withUserState(current, message.chat.id, user);
        await saveState(current);
        const view = filtersMenu(user.filters, user.active);
        await sendMessage(message.chat.id, view.text, view.replyMarkup);
      } catch (error) {
        await sendMessage(
          message.chat.id,
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
    onPrivateMonitoringChanged = () => {},
    onPrivateUserDeactivated = () => {},
    onTelegramSuccess = () => {},
    onChannelOperation = () => {},
    onChannelFilterFingerprintChange = () => {},
    onRetry = () => {},
    exchangeRateService,
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
  await onMonitoringState({
    active: activeUsers(state).length > 0,
    channelConfigured: Boolean(config.telegramChannelId),
  });

  const activate = () => {
    activationWaiter?.();
    activationWaiter = undefined;
  };
  const deactivateUnavailableUser = async (chatId, reason) => {
    const user = userState(state, chatId);
    state = withUserState(state, chatId, { ...user, active: false });
    await saveState(config.telegramStateFile, state);
    await onMonitoringState({
      active: activeUsers(state).length > 0,
      channelConfigured: Boolean(config.telegramChannelId),
    });
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
        const unavailableUsers = new Map();
        const updates = await api.getUpdates(
          state.updateOffset,
          config.telegramPollTimeoutSeconds,
          signal,
        );
        state = await processUpdates(updates, config, state, {
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
          saveState: (value) => saveState(config.telegramStateFile, value),
          onSubscriptionChanged: async (changedState, { active }) => {
            state = changedState;
            if (active) activate();
            await onMonitoringState({
              active: activeUsers(state).length > 0,
              channelConfigured: Boolean(config.telegramChannelId),
            });
            await onPrivateMonitoringChanged({
              active,
              activeUserCount: activeUsers(state).length,
            });
          },
        });
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
      if (activeUsers(state).length === 0 && !config.telegramChannelId) {
        await waitForActivation(signal, (resolve) => {
          activationWaiter = resolve;
        });
        if (signal?.aborted) return;
      }

      let failureComponent = "cba";
      const crawlId = randomUUID();
      const crawlStartedAt = Date.now();
      try {
        const exchangeRates = await exchangeRateService?.getSnapshot(signal);
        failureComponent = "list_am";
        const privateUsers = activeUsers(state);
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
                privateDeliveries: privateUsers.map((user) => ({
                  recipientId: String(user.chatId),
                  filters: user.filters,
                  deliverApartment: async (apartment) => {
                    try {
                      await api.sendMessage(
                        user.chatId,
                        formatApartmentMessage(apartment),
                        signal,
                      );
                    } catch (error) {
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
                })),
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

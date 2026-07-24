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
  emptyFilters,
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

export function compatibleBotState(state, ownerId) {
  return Boolean(
    state &&
      state.version === 1 &&
      state.type === "telegram-bot" &&
      state.ownerId === ownerId,
  );
}

function withFilterDefaults(state) {
  return {
    ...state,
    filters: normalizeFilters(state?.filters),
    pendingFilterInput: ["price", "rooms"].includes(state?.pendingFilterInput)
      ? state.pendingFilterInput
      : null,
  };
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

function filterShortcut() {
  return {
    inline_keyboard: [[{ text: "Настроить фильтры", callback_data: "f:menu" }]],
  };
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
      filtersMenu(current.filters),
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
      filtersMenu(current.filters),
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
    onActivated = () => {},
  },
) {
  let current = withFilterDefaults(state);
  const actions = { sendMessage, editMessage, saveState };

  for (const update of updates) {
    current = { ...current, updateOffset: update.update_id + 1 };
    const query = update.callback_query;
    const isOwnerPrivateCallback =
      query?.from?.id === config.telegramOwnerId &&
      query.message?.chat?.type === "private" &&
      query.message.chat.id === config.telegramOwnerId;

    if (query) {
      await answerCallback(query.id);
      if (isOwnerPrivateCallback && query.data?.startsWith("f:")) {
        current = await processFilterCallback(query, current, actions);
      }
      continue;
    }

    const message = update.message;
    const isOwnerPrivateChat =
      message?.from?.id === config.telegramOwnerId &&
      message.chat?.type === "private" &&
      message.chat.id === config.telegramOwnerId;

    if (isOwnerPrivateChat && isStartCommand(message.text)) {
      const wasActive = current.active;
      current = {
        ...current,
        active: true,
        chatId: message.chat.id,
      };
      await saveState(current);
      onActivated(current);
      await sendMessage(
        current.chatId,
        wasActive
          ? "Мониторинг объявлений уже запущен."
          : "Мониторинг объявлений запущен.",
        filterShortcut(),
      );
      continue;
    }

    if (!isOwnerPrivateChat) continue;

    if (/^\/filters(?:@[a-z0-9_]+)?(?:\s|$)/iu.test(message.text || "")) {
      current = { ...current, pendingFilterInput: null };
      const view = filtersMenu(current.filters);
      await saveState(current);
      await sendMessage(message.chat.id, view.text, view.replyMarkup);
      continue;
    }

    if (/^\/cancel(?:@[a-z0-9_]+)?(?:\s|$)/iu.test(message.text || "")) {
      current = { ...current, pendingFilterInput: null };
      await saveState(current);
      await sendMessage(message.chat.id, "Ввод фильтра отменён.");
      continue;
    }

    if (current.pendingFilterInput && message.text) {
      try {
        const range = parseRangeInput(message.text, current.pendingFilterInput);
        current = {
          ...current,
          filters: {
            ...current.filters,
            [current.pendingFilterInput]: range,
          },
          pendingFilterInput: null,
        };
        await saveState(current);
        const view = filtersMenu(current.filters);
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
    api = new TelegramApi(config.telegramBotToken, {
      timeoutMs: config.timeoutMs,
    }),
    loadState = readState,
    saveState = writeState,
    crawl = crawlApartments,
    publishChannel = publishChannelApartments,
    pageFetch = globalThis.fetch,
    sleep = delay,
    onResult = () => {},
    onError = () => {},
    onChannelOperation = () => {},
    onChannelFilterFingerprintChange = () => {},
    exchangeRateService,
    signal,
  } = {},
) {
  const stored = await loadState(config.telegramStateFile);
  let state = compatibleBotState(stored, config.telegramOwnerId)
    ? withFilterDefaults(stored)
    : {
        version: 1,
        type: "telegram-bot",
        ownerId: config.telegramOwnerId,
        active: false,
        chatId: null,
        updateOffset: 0,
        filters: emptyFilters(),
        pendingFilterInput: null,
      };
  let activationWaiter;

  const activate = () => {
    activationWaiter?.();
    activationWaiter = undefined;
  };

  const updateLoop = async () => {
    while (!signal?.aborted) {
      try {
        const updates = await api.getUpdates(
          state.updateOffset,
          config.telegramPollTimeoutSeconds,
          signal,
        );
        state = await processUpdates(updates, config, state, {
          sendMessage: (chatId, text, replyMarkup) =>
            api.sendMessage(chatId, text, signal, replyMarkup),
          editMessage: (chatId, messageId, text, replyMarkup) =>
            api.editMessageText(chatId, messageId, text, signal, replyMarkup),
          answerCallback: (callbackQueryId) =>
            api.answerCallbackQuery(callbackQueryId, signal),
          saveState: (value) => saveState(config.telegramStateFile, value),
          onActivated: (activatedState) => {
            state = activatedState;
            activate();
          },
        });
      } catch (error) {
        if (signal?.aborted) return;
        await onError(error);
        await sleep(2_000, undefined, { signal }).catch((sleepError) => {
          if (sleepError.name !== "AbortError") throw sleepError;
        });
      }
    }
  };

  const monitorLoop = async () => {
    while (!signal?.aborted) {
      if (!state.active && !config.telegramChannelId) {
        await waitForActivation(signal, (resolve) => {
          activationWaiter = resolve;
        });
        if (signal?.aborted) return;
      }

      try {
        const exchangeRates = await exchangeRateService?.getSnapshot(signal);
        const privateChatId = state.active ? state.chatId : null;
        let channelResult = {
          sentCount: 0,
          editedCount: 0,
          filteredCount: 0,
          skippedCount: 0,
        };
        const result = await crawl(config, {
          fetchPage: pageFetch,
          filters: state.filters,
          exchangeRates,
          ...(privateChatId
            ? {
                deliverApartment: (apartment) =>
                  api.sendMessage(
                    privateChatId,
                    formatApartmentMessage(apartment),
                    signal,
                  ),
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
                        onOperation: onChannelOperation,
                        onFilterFingerprintChange:
                          onChannelFilterFingerprintChange,
                      },
                    );
                  } catch (error) {
                    await onError(error, { component: "telegram-channel" });
                  }
                },
              }
            : {}),
        });
        await onResult({ ...result, channel: channelResult });
      } catch (error) {
        if (signal?.aborted) return;
        await onError(error);
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

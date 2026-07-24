import { setTimeout as delay } from "node:timers/promises";

import { crawlApartments } from "./crawler.js";
import { readState, writeState } from "./state.js";
import {
  formatApartmentMessage,
  isStartCommand,
  TelegramApi,
} from "./telegram.js";

function compatibleBotState(state, ownerId) {
  return Boolean(
    state &&
      state.version === 1 &&
      state.type === "telegram-bot" &&
      state.ownerId === ownerId,
  );
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

export async function processUpdates(
  updates,
  config,
  state,
  { sendMessage, saveState, onActivated = () => {} },
) {
  let current = state;

  for (const update of updates) {
    current = { ...current, updateOffset: update.update_id + 1 };
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
          ? "Apartment monitoring is already running."
          : "Apartment monitoring started.",
      );
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
    pageFetch = globalThis.fetch,
    sleep = delay,
    onResult = () => {},
    onError = () => {},
    signal,
  } = {},
) {
  const stored = await loadState(config.telegramStateFile);
  let state = compatibleBotState(stored, config.telegramOwnerId)
    ? stored
    : {
        version: 1,
        type: "telegram-bot",
        ownerId: config.telegramOwnerId,
        active: false,
        chatId: null,
        updateOffset: 0,
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
          sendMessage: (chatId, text) => api.sendMessage(chatId, text, signal),
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
      if (!state.active) {
        await waitForActivation(signal, (resolve) => {
          activationWaiter = resolve;
        });
        if (signal?.aborted) return;
      }

      try {
        const result = await crawl(config, {
          fetchPage: pageFetch,
          deliverApartment: (apartment) =>
            api.sendMessage(
              state.chatId,
              formatApartmentMessage(apartment),
              signal,
            ),
        });
        await onResult(result);
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

  await Promise.all([updateLoop(), monitorLoop()]);
}

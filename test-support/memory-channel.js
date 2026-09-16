import { apartmentMatchesFilters } from "../src/filters.js";
import {
  channelFilterFingerprint,
  compatibleChannelState,
} from "../src/channel.js";

export function createMemoryChannelStore({
  getState,
  setState,
  getApartments = () => undefined,
  onWrite = async () => {},
}) {
  let source;
  let work = [];
  let nextWorkId = 1;
  const save = async (state) => {
    await onWrite(state);
    setState(structuredClone(state));
  };
  return {
    load: async () => structuredClone(getState()),
    prepare: async (config, supplied, now) => {
      source = supplied?.apartments ? supplied : getApartments();
      const previous = getState();
      let state = structuredClone(previous);
      let filteredCount = 0;
      let skippedCount = 0;
      const order = [
        ...new Set([
          ...(source?.apartmentOrder || []),
          ...Object.keys(source?.apartments || {}),
        ]),
      ].filter((id) => source.apartments[id]);
      if (!compatibleChannelState(state, config)) {
        state = {
          version: 1,
          type: "telegram-channel-deliveries",
          channelId: config.telegramChannelId,
          urlTemplate: config.listUrlTemplate,
          initialized: true,
          filterFingerprint: channelFilterFingerprint(config.channelFilters),
          apartments: {},
        };
        let selected = 0;
        for (const id of order) {
          const matches = apartmentMatchesFilters(
            source.apartments[id],
            config.channelFilters,
          );
          const status = !matches
            ? "filtered"
            : selected++ < config.initialDeliveryLimit
              ? "pending"
              : "skipped_initial";
          state.apartments[id] = { status, classifiedAt: now.toISOString() };
          if (status === "filtered") filteredCount += 1;
          if (status === "skipped_initial") skippedCount += 1;
        }
        work = [];
        await save(state);
      } else if (
        state.filterFingerprint !==
        channelFilterFingerprint(config.channelFilters)
      ) {
        state.filterFingerprint = channelFilterFingerprint(
          config.channelFilters,
        );
        await save(state);
      }
      for (const id of order.reverse()) {
        if (!work.some((entry) => entry.itemId === id))
          work.push({ workId: nextWorkId++, itemId: id });
      }
      return {
        filteredCount,
        skippedCount,
        previousFingerprint: previous?.filterFingerprint,
      };
    },
    loadCandidates: async (cursor, limit) =>
      work
        .filter(
          (entry) => entry.workId > cursor && source?.apartments[entry.itemId],
        )
        .slice(0, limit)
        .map(({ workId, itemId }) => ({
          workId,
          apartment: structuredClone(source.apartments[itemId]),
          entry: structuredClone(getState().apartments[itemId]),
        })),
    classify: async (decisions) => {
      const state = structuredClone(getState());
      Object.assign(state.apartments, decisions);
      await save(state);
    },
    readmit: async (id, reencounteredAt) => {
      const state = structuredClone(getState());
      Object.assign(state.apartments[id], {
        status: "pending",
        reencounteredAt,
      });
      await save(state);
    },
    acknowledge: async (id, acknowledgement) => {
      const state = structuredClone(getState());
      const entry = state.apartments[id];
      delete entry.updatedAt;
      Object.assign(entry, acknowledgement, { status: "published" });
      await save(state);
    },
    complete: async (id) => {
      work = work.filter((entry) => entry.itemId !== id);
    },
  };
}

import { createHash } from "node:crypto";

import {
  apartmentMatchesFilters,
  emptyFilters,
  LOCATION_REGIONS,
  parseRangeInput,
  placeLocationId,
  regionLocationId,
} from "./filters.js";
import { amdPriceAmount } from "./prices.js";
import { readState, writeState } from "./state.js";
import { formatApartmentMessage } from "./telegram.js";

const CHANNEL_STATE_VERSION = 1;
const CHANNEL_STATE_TYPE = "telegram-channel-deliveries";
const CHANNEL_STATUSES = new Set([
  "pending",
  "published",
  "filtered",
  "skipped_initial",
]);

function normalizedName(value) {
  return String(value).normalize("NFKC").trim().toLocaleLowerCase("ru-RU");
}

function parseChannelRange(value, kind, environmentName) {
  if (value === undefined || String(value).trim() === "") {
    return { min: null, max: null };
  }

  const compact = String(value)
    .trim()
    .replace(/\s+/gu, "")
    .replace(/[–—]/gu, "-");
  if (!/^(?:\d+|\d+-\d*|-\d+)$/u.test(compact)) {
    throw new Error(
      `${environmentName} must be an exact, open, or closed integer range`,
    );
  }

  try {
    return parseRangeInput(compact, kind);
  } catch (error) {
    throw new Error(`${environmentName} is invalid: ${error.message}`, {
      cause: error,
    });
  }
}

function locationIndexes() {
  const regions = new Map();
  const places = new Map();

  for (const [regionIndex, region] of LOCATION_REGIONS.entries()) {
    const regionName = normalizedName(region.name);
    const regionMatches = regions.get(regionName) || [];
    regionMatches.push(regionIndex);
    regions.set(regionName, regionMatches);

    for (const [placeIndex, place] of region.places.entries()) {
      const placeName = normalizedName(place);
      const placeMatches = places.get(placeName) || [];
      placeMatches.push({ regionIndex, placeIndex });
      places.set(placeName, placeMatches);
    }
  }

  return { regions, places };
}

const LOCATION_INDEXES = locationIndexes();

function resolveLocationSelector(selector) {
  const match = selector.match(/^(region|place)\s*:(.+)$/iu);
  if (!match) {
    throw new Error(
      `CHANNEL_FILTER_LOCATIONS selector "${selector}" must use region:<name> or place:<name>`,
    );
  }

  const [, type, rawName] = match;
  const name = normalizedName(rawName);
  if (!name) {
    throw new Error(
      `CHANNEL_FILTER_LOCATIONS selector "${selector}" has no name`,
    );
  }

  const matches =
    type.toLocaleLowerCase("en-US") === "region"
      ? LOCATION_INDEXES.regions.get(name) || []
      : LOCATION_INDEXES.places.get(name) || [];
  if (matches.length === 0) {
    throw new Error(
      `CHANNEL_FILTER_LOCATIONS selector "${selector}" is unknown`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `CHANNEL_FILTER_LOCATIONS selector "${selector}" is ambiguous`,
    );
  }

  if (typeof matches[0] === "number") {
    return regionLocationId(matches[0]);
  }
  return placeLocationId(matches[0].regionIndex, matches[0].placeIndex);
}

export function parseChannelFilters({ price, rooms, locations } = {}) {
  const filters = {
    ...emptyFilters(),
    price: parseChannelRange(price, "price", "CHANNEL_FILTER_PRICE_AMD"),
    rooms: parseChannelRange(rooms, "rooms", "CHANNEL_FILTER_ROOMS"),
  };
  const locationText =
    locations === undefined || String(locations).trim() === ""
      ? "region:Ереван"
      : String(locations).trim();

  if (normalizedName(locationText) === "all") return filters;

  const selectors = locationText.split(",").map((selector) => selector.trim());
  if (selectors.some((selector) => selector === "")) {
    throw new Error("CHANNEL_FILTER_LOCATIONS contains an empty selector");
  }
  if (selectors.some((selector) => normalizedName(selector) === "all")) {
    throw new Error(
      'CHANNEL_FILTER_LOCATIONS "all" cannot be combined with selectors',
    );
  }

  const resolved = selectors.map(resolveLocationSelector);
  const unique = new Set(resolved);
  if (unique.size !== resolved.length) {
    throw new Error(
      "CHANNEL_FILTER_LOCATIONS contains duplicate selectors for the same location",
    );
  }

  for (const id of resolved) {
    if (!id.startsWith("p:")) continue;
    const regionIndex = Number(id.split(":")[1]);
    if (unique.has(regionLocationId(regionIndex))) {
      throw new Error(
        "CHANNEL_FILTER_LOCATIONS cannot combine a whole region with one of its places",
      );
    }
  }

  return { ...filters, locations: resolved };
}

export function channelFilterFingerprint(filters) {
  return createHash("sha256").update(JSON.stringify(filters)).digest("hex");
}

function locationParts(value) {
  return String(value || "")
    .normalize("NFKC")
    .split(/\s*[,/]\s*/u)
    .map((part) => normalizedName(part))
    .filter(Boolean);
}

function knownLocation(apartment) {
  const parts = locationParts(apartment?.location);

  for (const part of parts) {
    const matches = LOCATION_INDEXES.places.get(part) || [];
    if (matches.length === 1) {
      const { regionIndex, placeIndex } = matches[0];
      return {
        region: LOCATION_REGIONS[regionIndex].name,
        locality: LOCATION_REGIONS[regionIndex].places[placeIndex],
      };
    }
  }

  for (const part of parts) {
    const matches = LOCATION_INDEXES.regions.get(part) || [];
    if (matches.length === 1) {
      const region = LOCATION_REGIONS[matches[0]].name;
      return { region, locality: region };
    }
  }

  return {
    region: null,
    locality: apartment?.location?.trim() || null,
  };
}

function hashtag(value, fallback) {
  if (!value) return fallback;
  const normalized = normalizedName(value)
    .replace(/[\s-]+/gu, "_")
    .replace(/[^\p{L}\p{N}_]/gu, "")
    .replace(/_+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return normalized ? `#${normalized}` : fallback;
}

export function channelHashtags(apartment) {
  const location = knownLocation(apartment);
  const regionTag = hashtag(location.region, "#регион_не_указан");
  const localityTag = hashtag(location.locality, "#локация_не_указана");
  const tags = [regionTag];
  if (localityTag !== regionTag) tags.push(localityTag);

  const amountAmd = amdPriceAmount(apartment?.price);
  if (Number.isFinite(amountAmd) && amountAmd > 0) {
    const bucket = Math.floor((amountAmd - 1) / 50_000);
    tags.push(`#цена_${bucket * 50 + 1}_${(bucket + 1) * 50}`);
  } else {
    tags.push("#цена_не_указана");
  }

  if (Number.isSafeInteger(apartment?.rooms) && apartment.rooms > 0) {
    tags.push(`#${apartment.rooms}комн`);
  } else {
    tags.push("#комнаты_не_указаны");
  }
  return tags;
}

export function formatChannelApartmentMessage(apartment) {
  return `${formatApartmentMessage(apartment)}\n\n${channelHashtags(apartment).join(" ")}`;
}

export function channelContentHash(message) {
  return createHash("sha256").update(message).digest("hex");
}

function validIsoDate(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function validChannelEntry(entry) {
  if (
    !entry ||
    typeof entry !== "object" ||
    !CHANNEL_STATUSES.has(entry.status) ||
    !validIsoDate(entry.classifiedAt)
  ) {
    return false;
  }
  if (entry.status !== "published") {
    return (
      entry.messageId === undefined &&
      entry.contentHash === undefined &&
      entry.publishedAt === undefined &&
      entry.updatedAt === undefined
    );
  }
  return (
    Number.isSafeInteger(entry.messageId) &&
    entry.messageId > 0 &&
    typeof entry.contentHash === "string" &&
    /^[a-f0-9]{64}$/u.test(entry.contentHash) &&
    validIsoDate(entry.publishedAt) &&
    (entry.updatedAt === undefined || validIsoDate(entry.updatedAt))
  );
}

export function compatibleChannelState(state, config) {
  return Boolean(
    state &&
    state.version === CHANNEL_STATE_VERSION &&
    state.type === CHANNEL_STATE_TYPE &&
    state.channelId === config.telegramChannelId &&
    state.urlTemplate === config.listUrlTemplate &&
    state.initialized === true &&
    typeof state.filterFingerprint === "string" &&
    /^[a-f0-9]{64}$/u.test(state.filterFingerprint) &&
    state.apartments &&
    typeof state.apartments === "object" &&
    !Array.isArray(state.apartments) &&
    Object.values(state.apartments).every(validChannelEntry),
  );
}

function newChannelState(config, filterFingerprint) {
  return {
    version: CHANNEL_STATE_VERSION,
    type: CHANNEL_STATE_TYPE,
    channelId: config.telegramChannelId,
    urlTemplate: config.listUrlTemplate,
    initialized: true,
    filterFingerprint,
    apartments: {},
  };
}

function missingChannelMessage(error) {
  return /message (?:to edit )?not found|message_id_invalid/iu.test(
    error?.message || "",
  );
}

function operationEvent(onOperation, details) {
  onOperation({
    channelId: details.channelId,
    itemId: details.itemId,
    operation: details.operation,
    outcome: details.outcome,
    ...(details.messageId ? { messageId: details.messageId } : {}),
    ...(details.error ? { error: details.error } : {}),
  });
}

export async function publishChannelApartments(
  config,
  apartmentState,
  {
    api,
    loadState = readState,
    saveState = writeState,
    now = () => new Date(),
    signal,
    onOperation = () => {},
    onFilterFingerprintChange = () => {},
  } = {},
) {
  if (!config.telegramChannelId) {
    return { sentCount: 0, editedCount: 0, filteredCount: 0, skippedCount: 0 };
  }
  if (!api) {
    throw new Error("A Telegram API client is required for channel publishing");
  }

  const fingerprint = channelFilterFingerprint(config.channelFilters);
  const stored = await loadState(config.channelDeliveryStateFile);
  const compatible = compatibleChannelState(stored, config);
  let state = compatible
    ? structuredClone(stored)
    : newChannelState(config, fingerprint);
  const apartments = apartmentState?.apartments || {};
  const orderedIds = new Set();
  const takeUnorderedId = (itemId) => {
    if (!Object.hasOwn(apartments, itemId) || orderedIds.has(itemId)) {
      return false;
    }
    orderedIds.add(itemId);
    return true;
  };
  const apartmentOrder = [
    ...(apartmentState?.apartmentOrder || []).filter(takeUnorderedId),
    ...Object.keys(apartments).filter(takeUnorderedId),
  ];
  let filteredCount = 0;
  let skippedCount = 0;

  if (!compatible) {
    const classifiedAt = now().toISOString();
    const matchingIds = apartmentOrder.filter((itemId) =>
      apartmentMatchesFilters(apartments[itemId], config.channelFilters),
    );
    const matchingSet = new Set(matchingIds);
    const selectedSet = new Set(
      matchingIds.slice(0, config.initialDeliveryLimit),
    );

    state.apartments = Object.fromEntries(
      apartmentOrder.map((itemId) => {
        let status = "filtered";
        if (selectedSet.has(itemId)) status = "pending";
        else if (matchingSet.has(itemId)) status = "skipped_initial";
        if (status === "filtered") filteredCount += 1;
        if (status === "skipped_initial") skippedCount += 1;
        return [itemId, { status, classifiedAt }];
      }),
    );
    // The whole initial admission decision is durable before the first send.
    await saveState(config.channelDeliveryStateFile, state);
  } else {
    if (state.filterFingerprint !== fingerprint) {
      onFilterFingerprintChange({
        channelId: config.telegramChannelId,
        previousFingerprint: state.filterFingerprint,
        filterFingerprint: fingerprint,
      });
      state.filterFingerprint = fingerprint;
      await saveState(config.channelDeliveryStateFile, state);
    }

    const unclassified = apartmentOrder.filter(
      (itemId) => !state.apartments[itemId],
    );
    if (unclassified.length > 0) {
      const classifiedAt = now().toISOString();
      for (const itemId of unclassified) {
        const status = apartmentMatchesFilters(
          apartments[itemId],
          config.channelFilters,
        )
          ? "pending"
          : "filtered";
        if (status === "filtered") filteredCount += 1;
        state.apartments[itemId] = { status, classifiedAt };
      }
      await saveState(config.channelDeliveryStateFile, state);
    }
  }

  let sentCount = 0;
  let editedCount = 0;
  const pendingIds = [...apartmentOrder]
    .reverse()
    .filter((itemId) => state.apartments[itemId]?.status === "pending");

  for (const itemId of pendingIds) {
    const apartment = apartments[itemId];
    if (!apartment) continue;
    let message;
    let contentHash;
    try {
      message = formatChannelApartmentMessage(apartment);
      contentHash = channelContentHash(message);
      const result = await api.sendMessage(
        config.telegramChannelId,
        message,
        signal,
      );
      if (!Number.isSafeInteger(result?.message_id) || result.message_id <= 0) {
        throw new Error("Telegram sendMessage returned an invalid message_id");
      }
      const publishedAt = now().toISOString();
      state.apartments[itemId] = {
        ...state.apartments[itemId],
        status: "published",
        messageId: result.message_id,
        contentHash,
        publishedAt,
      };
      await saveState(config.channelDeliveryStateFile, state);
      sentCount += 1;
      operationEvent(onOperation, {
        channelId: config.telegramChannelId,
        itemId,
        operation: "send",
        outcome: "success",
        messageId: result.message_id,
      });
    } catch (error) {
      operationEvent(onOperation, {
        channelId: config.telegramChannelId,
        itemId,
        operation: "send",
        outcome: "failed",
        error,
      });
    }
  }

  const publishedIds = apartmentOrder.filter(
    (itemId) => state.apartments[itemId]?.status === "published",
  );
  for (const itemId of publishedIds) {
    const apartment = apartments[itemId];
    const entry = state.apartments[itemId];
    if (!apartment) continue;

    let message;
    let contentHash;
    try {
      message = formatChannelApartmentMessage(apartment);
      contentHash = channelContentHash(message);
      if (contentHash === entry.contentHash) continue;

      try {
        await api.editMessageText(
          config.telegramChannelId,
          entry.messageId,
          message,
          signal,
        );
      } catch (error) {
        if (!missingChannelMessage(error)) throw error;

        const result = await api.sendMessage(
          config.telegramChannelId,
          message,
          signal,
        );
        if (
          !Number.isSafeInteger(result?.message_id) ||
          result.message_id <= 0
        ) {
          throw new Error(
            "Telegram sendMessage returned an invalid message_id",
            { cause: error },
          );
        }
        entry.messageId = result.message_id;
      }

      entry.contentHash = contentHash;
      entry.updatedAt = now().toISOString();
      await saveState(config.channelDeliveryStateFile, state);
      editedCount += 1;
      operationEvent(onOperation, {
        channelId: config.telegramChannelId,
        itemId,
        operation: "edit",
        outcome: "success",
        messageId: entry.messageId,
      });
    } catch (error) {
      operationEvent(onOperation, {
        channelId: config.telegramChannelId,
        itemId,
        operation: "edit",
        outcome: "failed",
        messageId: entry.messageId,
        error,
      });
    }
  }

  return {
    sentCount,
    editedCount,
    filteredCount,
    skippedCount,
  };
}

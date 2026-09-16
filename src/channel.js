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
import { APARTMENT } from "./property-kind.js";
import {
  postedWithinSourceActivityWindow,
  withinSourceActivityWindow,
} from "./source-activity.js";
import { formatApartmentMessage } from "./telegram.js";

const CHANNEL_STATE_VERSION = 1;
const CHANNEL_STATE_TYPE = "telegram-channel-deliveries";
const CHANNEL_REPOST_AGE_MS = 3 * 24 * 60 * 60 * 1000;
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
    // The channel publishes apartments, and says so explicitly rather than
    // inheriting whatever the default happens to be.
    kinds: [APARTMENT],
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
    !validIsoDate(entry.classifiedAt) ||
    (entry.reencounteredAt !== undefined &&
      !validIsoDate(entry.reencounteredAt))
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
    ...(details.reason ? { reason: details.reason } : {}),
    ...(details.error ? { error: details.error } : {}),
  });
}

function encounteredAfterClassification(apartment, entry) {
  return (
    validIsoDate(apartment?.lastSeenAt) &&
    Date.parse(apartment.lastSeenAt) > Date.parse(entry.classifiedAt)
  );
}

function updatedAfterClassification(apartment, entry) {
  return (
    validIsoDate(apartment?.updatedAt) &&
    Date.parse(apartment.updatedAt) > Date.parse(entry.classifiedAt)
  );
}

function shouldRepost(entry, currentTime) {
  return (
    currentTime.getTime() - Date.parse(entry.publishedAt) >
    CHANNEL_REPOST_AGE_MS
  );
}

export async function publishChannelApartments(
  config,
  apartmentState,
  {
    api,
    stateStore,
    now = () => new Date(),
    signal,
    onOperation = () => {},
    onFilterFingerprintChange = () => {},
  } = {},
) {
  if (!config.telegramChannelId) {
    return {
      sentCount: 0,
      editedCount: 0,
      filteredCount: 0,
      skippedCount: 0,
      readmittedCount: 0,
    };
  }
  if (!api) {
    throw new Error("A Telegram API client is required for channel publishing");
  }

  const fingerprint = channelFilterFingerprint(config.channelFilters);
  if (!stateStore) {
    throw new Error("Channel delivery storage is not configured");
  }
  const reference = now();
  const prepared = await stateStore.prepare(config, apartmentState, reference);
  const { skippedCount } = prepared;
  let readmittedCount = 0;
  if (
    prepared.previousFingerprint &&
    prepared.previousFingerprint !== fingerprint
  ) {
    onFilterFingerprintChange({
      channelId: config.telegramChannelId,
      previousFingerprint: prepared.previousFingerprint,
      filterFingerprint: fingerprint,
    });
  }
  let sentCount = 0;
  let editedCount = 0;
  let cursor = 0;
  for (;;) {
    const candidates = await stateStore.loadCandidates(cursor, 100);
    if (candidates.length === 0) break;
    for (const { workId, apartment, entry: storedEntry } of candidates) {
      cursor = workId;
      const itemId = apartment.itemId;
      let entry = storedEntry;
      if (!entry) {
        entry = {
          status: apartmentMatchesFilters(apartment, config.channelFilters)
            ? "pending"
            : "filtered",
          classifiedAt: now().toISOString(),
        };
        await stateStore.classify({ [itemId]: entry });
        if (entry.status === "filtered") prepared.filteredCount += 1;
      }
      const reason = channelReadmissionReason(
        apartment,
        entry,
        config.channelFilters,
        reference.getTime(),
      );
      if (reason) {
        await stateStore.readmit(
          itemId,
          apartment.lastSeenAt || now().toISOString(),
        );
        entry = { ...entry, status: "pending" };
        readmittedCount += 1;
        operationEvent(onOperation, {
          channelId: config.telegramChannelId,
          itemId,
          operation: "readmit",
          outcome: "success",
          reason,
        });
      }
      if (!["pending", "published"].includes(entry.status)) {
        await stateStore.complete(itemId);
        continue;
      }
      let operation = entry.status === "pending" ? "send" : "edit";
      try {
        const message = formatChannelApartmentMessage(apartment);
        const contentHash = channelContentHash(message);
        if (entry.status === "published" && contentHash === entry.contentHash) {
          await stateStore.complete(itemId);
          continue;
        }
        let messageId = entry.messageId;
        let publishedAt = entry.publishedAt;
        let updatedAt;
        if (entry.status === "pending" || shouldRepost(entry, now())) {
          if (entry.status === "published") operation = "repost";
          const result = await api.sendMessage(
            config.telegramChannelId,
            message,
            signal,
          );
          messageId = result?.message_id;
          publishedAt = now().toISOString();
        } else {
          try {
            await api.editMessageText(
              config.telegramChannelId,
              messageId,
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
            messageId = result?.message_id;
          }
          updatedAt = now().toISOString();
        }
        if (!Number.isSafeInteger(messageId) || messageId <= 0)
          throw new Error(
            "Telegram sendMessage returned an invalid message_id",
          );
        await stateStore.acknowledge(itemId, {
          messageId,
          contentHash,
          publishedAt,
          ...(updatedAt ? { updatedAt } : {}),
        });
        await stateStore.complete(itemId);
        if (operation === "edit") editedCount += 1;
        else sentCount += 1;
        operationEvent(onOperation, {
          channelId: config.telegramChannelId,
          itemId,
          operation,
          outcome: "success",
          messageId,
        });
      } catch (error) {
        operationEvent(onOperation, {
          channelId: config.telegramChannelId,
          itemId,
          operation,
          outcome: "failed",
          messageId: entry.messageId,
          error,
        });
      }
    }
  }
  return {
    sentCount,
    editedCount,
    filteredCount: prepared.filteredCount,
    skippedCount,
    readmittedCount,
  };
}

export function channelReadmissionReason(apartment, entry, filters, reference) {
  if (!apartmentMatchesFilters(apartment, filters)) return null;
  if (
    entry.status === "skipped_initial" &&
    encounteredAfterClassification(apartment, entry) &&
    withinSourceActivityWindow(apartment.lastSeenAt, reference)
  )
    return "reencountered";
  if (entry.status !== "filtered") return null;
  if (
    updatedAfterClassification(apartment, entry) &&
    withinSourceActivityWindow(apartment.updatedAt, reference)
  )
    return "updated_match";
  return postedWithinSourceActivityWindow(apartment, reference)
    ? "recent_match"
    : null;
}

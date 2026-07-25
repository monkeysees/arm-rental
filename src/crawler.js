import { extractRegularApartments } from "./list-am.js";
import {
  apartmentMatchesFilters,
  emptyFilters,
  normalizeFilters,
} from "./filters.js";
import {
  currencyCode,
  normalizeApartmentPrice,
  originalPrice,
} from "./prices.js";
import { readState, writeState } from "./state.js";
import { pageUrl } from "./target.js";

const MONTH_NUMBERS = new Map(
  [
    ["январь", 0],
    ["января", 0],
    ["февраль", 1],
    ["февраля", 1],
    ["март", 2],
    ["марта", 2],
    ["апрель", 3],
    ["апреля", 3],
    ["май", 4],
    ["мая", 4],
    ["mай", 4],
    ["июнь", 5],
    ["июня", 5],
    ["июль", 6],
    ["июля", 6],
    ["август", 7],
    ["августа", 7],
    ["сентябрь", 8],
    ["сентября", 8],
    ["октябрь", 9],
    ["октября", 9],
    ["ноябрь", 10],
    ["ноября", 10],
    ["декабрь", 11],
    ["декабря", 11],
    ["january", 0],
    ["february", 1],
    ["march", 2],
    ["april", 3],
    ["may", 4],
    ["june", 5],
    ["july", 6],
    ["august", 7],
    ["september", 8],
    ["october", 9],
    ["november", 10],
    ["december", 11],
  ].map(([month, number]) => [month, number]),
);

export function compatibleApartmentState(state, template) {
  return Boolean(
    state &&
    [1, 2].includes(state.version) &&
    state.type === "list-am-apartments" &&
    state.urlTemplate === template &&
    state.apartments &&
    typeof state.apartments === "object" &&
    !Array.isArray(state.apartments),
  );
}

export function compatibleDeliveryState(state, template) {
  return Boolean(
    state &&
    [1, 2].includes(state.version) &&
    state.type === "telegram-deliveries" &&
    state.urlTemplate === template &&
    (state.version === 1
      ? state.notified &&
        typeof state.notified === "object" &&
        !Array.isArray(state.notified)
      : state.recipients &&
        typeof state.recipients === "object" &&
        !Array.isArray(state.recipients)),
  );
}

function deliveryRecipientState(state = {}) {
  return {
    notified: state.notified || {},
    skipped: state.skipped || {},
    filtered: state.filtered || {},
    initialSelectionApplied:
      state.initialSelectionApplied ??
      Object.keys(state.notified || {}).length > 0,
  };
}

export function deliveryStateCounts(state) {
  const recipients =
    state?.version === 2
      ? Object.values(state.recipients || {})
      : state
        ? [state]
        : [];
  return recipients.reduce(
    (counts, recipient) => ({
      recipients: counts.recipients + 1,
      notified: counts.notified + Object.keys(recipient.notified || {}).length,
      skipped: counts.skipped + Object.keys(recipient.skipped || {}).length,
      filtered: counts.filtered + Object.keys(recipient.filtered || {}).length,
    }),
    { recipients: 0, notified: 0, skipped: 0, filtered: 0 },
  );
}

async function fetchHtml(url, fetchPage) {
  const response = await fetchPage(url);
  if (!response.ok) {
    const error = new Error(
      `List.am returned HTTP ${response.status} ${response.statusText}`,
    );
    error.httpStatus = response.status;
    throw error;
  }
  return response.text();
}

function dateSortValue(value) {
  const match = value?.match(
    /^[^,]+,\s*([^,\s]+)\s+(\d{1,2}),\s*(\d{4}),\s*(\d{1,2}):(\d{2})$/u,
  );
  if (!match) return null;

  const month = MONTH_NUMBERS.get(match[1].toLocaleLowerCase("ru-RU"));
  if (month === undefined) return null;

  const [, , dayText, yearText, hourText, minuteText] = match;
  const [day, year, hour, minute] = [
    dayText,
    yearText,
    hourText,
    minuteText,
  ].map(Number);
  const sortValue = Date.UTC(year, month, day, hour, minute);
  const parsed = new Date(sortValue);

  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month ||
    parsed.getUTCDate() !== day ||
    parsed.getUTCHours() !== hour ||
    parsed.getUTCMinutes() !== minute
  ) {
    return null;
  }

  // UTC is only a stable way to compare the displayed calendar components;
  // the source date remains stored verbatim and is not treated as UTC.
  return sortValue;
}

function latestKnownPostingDate(apartments) {
  let latestDate = null;
  let latestValue = null;

  for (const apartment of Object.values(apartments)) {
    const value = dateSortValue(apartment?.date);
    if (value !== null && (latestValue === null || value > latestValue)) {
      latestDate = apartment.date;
      latestValue = value;
    }
  }

  return { date: latestDate, value: latestValue };
}

const SOURCE_FIELDS = [
  "title",
  "location",
  "rooms",
  "areaSqM",
  "floor",
  "url",
  "date",
];

function originalPriceValues(price) {
  const original = originalPrice(price);
  return {
    amount: original.amount,
    currency: currencyCode(original.currency),
  };
}

function sourceDataChanged(previous, observed) {
  if (SOURCE_FIELDS.some((field) => previous[field] !== observed[field])) {
    return true;
  }
  const previousPrice = originalPriceValues(previous.price);
  const observedPrice = originalPriceValues(observed.price);
  return (
    previousPrice.amount !== observedPrice.amount ||
    previousPrice.currency !== observedPrice.currency
  );
}

function hasUpdateAfterDelivery(apartment, deliveredAt) {
  const updatedAt = Date.parse(apartment?.updatedAt);
  const deliveredAtValue = Date.parse(deliveredAt);
  return (
    Number.isFinite(updatedAt) &&
    Number.isFinite(deliveredAtValue) &&
    updatedAt > deliveredAtValue
  );
}

export async function crawlApartments(
  config,
  {
    fetchPage = globalThis.fetch,
    loadState = readState,
    saveState = writeState,
    deliverApartment,
    privateDeliveries,
    legacyRecipientId,
    exchangeRates,
    filters = emptyFilters(),
    now = () => new Date(),
    afterStateSaved,
  } = {},
) {
  const deliveryTargets =
    privateDeliveries ||
    (deliverApartment
      ? [
          {
            recipientId: "default",
            filters,
            deliverApartment,
          },
        ]
      : []);
  const recipientIds = deliveryTargets.map(({ recipientId }) =>
    String(recipientId),
  );
  if (new Set(recipientIds).size !== recipientIds.length) {
    throw new Error("Private delivery recipient IDs must be unique");
  }

  const stored = await loadState(config.apartmentsStateFile);
  const compatible = compatibleApartmentState(stored, config.listUrlTemplate);
  const previousApartments = compatible
    ? Object.fromEntries(
        Object.entries(stored.apartments).map(([itemId, apartment]) => [
          itemId,
          {
            ...apartment,
            price: normalizeApartmentPrice(apartment.price, exchangeRates),
          },
        ]),
      )
    : {};
  const previousOrder = compatible ? stored.apartmentOrder || [] : [];
  const initialRun = Object.keys(previousApartments).length === 0;
  const lastKnownPostingDate = latestKnownPostingDate(previousApartments);
  const discovered = [];
  const observedKnown = new Map();
  const encounteredIdSet = new Set();
  const encounteredOrder = [];
  const pageSignatures = new Set();
  let pagesParsed = 0;
  let stoppedAtKnownDate = null;
  let exhausted = false;

  pageLoop: for (let page = 1; ; page += 1) {
    if (
      (initialRun || lastKnownPostingDate.value === null) &&
      page > config.initialPageCount
    ) {
      break;
    }

    const html = await fetchHtml(
      pageUrl(page, config.listUrlTemplate),
      fetchPage,
    );
    const apartments = extractRegularApartments(html);
    pagesParsed += 1;

    if (apartments.length === 0) {
      exhausted = true;
      break;
    }

    const signature = apartments.map(({ itemId }) => itemId).join(",");
    if (pageSignatures.has(signature)) {
      exhausted = true;
      break;
    }
    pageSignatures.add(signature);

    for (const apartment of apartments) {
      const postingDateValue = dateSortValue(apartment.date);
      const knownApartment = Object.hasOwn(
        previousApartments,
        apartment.itemId,
      );
      if (
        !initialRun &&
        lastKnownPostingDate.value !== null &&
        postingDateValue !== null &&
        postingDateValue < lastKnownPostingDate.value
      ) {
        // A renewed known ad can retain its old displayed date while moving
        // back into the newest results. Record that encounter before applying
        // the date watermark so delivery can re-admit an initially skipped ad.
        if (!encounteredIdSet.has(apartment.itemId) && knownApartment) {
          encounteredIdSet.add(apartment.itemId);
          encounteredOrder.push(apartment.itemId);
          observedKnown.set(apartment.itemId, apartment);
        }
        stoppedAtKnownDate = lastKnownPostingDate.date;
        break pageLoop;
      }
      if (encounteredIdSet.has(apartment.itemId)) continue;
      encounteredIdSet.add(apartment.itemId);
      encounteredOrder.push(apartment.itemId);
      if (knownApartment) {
        observedKnown.set(apartment.itemId, apartment);
        continue;
      }
      discovered.push({
        ...apartment,
        price: normalizeApartmentPrice(apartment.price, exchangeRates),
      });
    }
  }

  const checkedAt = now().toISOString();
  const apartments = { ...previousApartments };
  const updated = [];
  for (const [itemId, observed] of observedKnown) {
    const previous = previousApartments[itemId];
    if (!sourceDataChanged(previous, observed)) {
      apartments[itemId] = { ...previous, lastSeenAt: checkedAt };
      continue;
    }

    const priceChanged =
      originalPriceValues(previous.price).amount !==
        originalPriceValues(observed.price).amount ||
      originalPriceValues(previous.price).currency !==
        originalPriceValues(observed.price).currency;
    const apartment = {
      ...observed,
      price: priceChanged
        ? normalizeApartmentPrice(observed.price, exchangeRates)
        : previous.price,
      firstSeenAt: previous.firstSeenAt,
      lastSeenAt: checkedAt,
      updatedAt: checkedAt,
    };
    apartments[itemId] = apartment;
    updated.push(apartment);
  }
  for (const apartment of discovered) {
    apartments[apartment.itemId] = {
      ...apartment,
      firstSeenAt: checkedAt,
      lastSeenAt: checkedAt,
    };
  }
  const orderedIds = new Set(encounteredOrder);
  const takeUnorderedId = (itemId) => {
    if (!Object.hasOwn(apartments, itemId) || orderedIds.has(itemId)) {
      return false;
    }
    orderedIds.add(itemId);
    return true;
  };
  const retainedOrder = previousOrder.filter(takeUnorderedId);
  const missingFromOrder = Object.keys(apartments).filter(takeUnorderedId);
  const apartmentOrder = [
    ...encounteredOrder,
    ...retainedOrder,
    ...missingFromOrder,
  ];

  const state = {
    version: 2,
    type: "list-am-apartments",
    urlTemplate: config.listUrlTemplate,
    checkedAt,
    lastCrawl: {
      initialRun,
      pagesParsed,
      discoveredCount: discovered.length,
      updatedCount: updated.length,
      lastKnownDate: lastKnownPostingDate.date,
      stoppedAtKnownDate,
      exhausted,
    },
    apartments,
    apartmentOrder,
  };

  await saveState(config.apartmentsStateFile, state);

  const channelPublication = afterStateSaved
    ? Promise.resolve().then(() => afterStateSaved(state))
    : Promise.resolve();

  let notifiedCount = 0;
  let skippedCount = 0;
  let filteredCount = 0;
  const privateDelivery = async () => {
    if (deliveryTargets.length === 0) return;
    const storedDeliveries = await loadState(config.deliveryStateFile);
    let deliveryState = compatibleDeliveryState(
      storedDeliveries,
      config.listUrlTemplate,
    )
      ? storedDeliveries.version === 2
        ? {
            ...storedDeliveries,
            recipients: Object.fromEntries(
              Object.entries(storedDeliveries.recipients).map(
                ([recipientId, recipient]) => [
                  recipientId,
                  deliveryRecipientState(recipient),
                ],
              ),
            ),
          }
        : {
            version: 2,
            type: "telegram-deliveries",
            urlTemplate: config.listUrlTemplate,
            recipients: {
              [legacyRecipientId || recipientIds[0]]:
                deliveryRecipientState(storedDeliveries),
            },
          }
      : {
          version: 2,
          type: "telegram-deliveries",
          urlTemplate: config.listUrlTemplate,
          recipients: {},
        };

    // Recipient workers run concurrently, but their independent histories live
    // in one JSON file. Merge and persist them through one failure-latching
    // chain so a whole-file replacement cannot lose a peer acknowledgement.
    let deliveryStateWrites = Promise.resolve();
    const saveRecipient = (recipientId, recipient) => {
      deliveryStateWrites = deliveryStateWrites.then(async () => {
        deliveryState = {
          ...deliveryState,
          recipients: {
            ...deliveryState.recipients,
            [recipientId]: recipient,
          },
        };
        await saveState(config.deliveryStateFile, deliveryState);
      });
      return deliveryStateWrites;
    };

    const deliverRecipient = async (target) => {
      if (target.isAuthorized?.() === false) return;
      const recipientId = String(target.recipientId);
      const recipientFilters = normalizeFilters(target.filters);
      let recipient = deliveryRecipientState(
        deliveryState.recipients[recipientId],
      );

      if (!recipient.initialSelectionApplied && apartmentOrder.length > 0) {
        const classifiedAt = now().toISOString();
        const matchingIds = apartmentOrder.filter((itemId) =>
          apartmentMatchesFilters(apartments[itemId], recipientFilters),
        );
        const matchingIdSet = new Set(matchingIds);
        const initialDeliveryLimit =
          target.sendInitialApartments === false
            ? 0
            : config.initialDeliveryLimit;
        const selectedIds = new Set(matchingIds.slice(0, initialDeliveryLimit));
        const skipped = Object.fromEntries(
          matchingIds
            .filter((itemId) => !selectedIds.has(itemId))
            .map((itemId) => [itemId, classifiedAt]),
        );
        const filtered = Object.fromEntries(
          apartmentOrder
            .filter((itemId) => !matchingIdSet.has(itemId))
            .map((itemId) => [itemId, classifiedAt]),
        );
        skippedCount += Object.keys(skipped).length;
        filteredCount += Object.keys(filtered).length;
        recipient = {
          ...recipient,
          initialSelectionApplied: true,
          skipped: { ...recipient.skipped, ...skipped },
          filtered: { ...recipient.filtered, ...filtered },
        };
        // Persist classification before sending so a restart cannot enqueue
        // historical apartments that were intentionally omitted for this user.
        await saveRecipient(recipientId, recipient);
      }

      const unclassifiedIds = apartmentOrder.filter(
        (itemId) =>
          !recipient.notified[itemId] &&
          !recipient.skipped[itemId] &&
          !recipient.filtered[itemId],
      );
      const newlyFilteredIds = unclassifiedIds.filter(
        (itemId) =>
          !apartmentMatchesFilters(apartments[itemId], recipientFilters),
      );
      if (newlyFilteredIds.length > 0) {
        const filteredAt = now().toISOString();
        recipient = {
          ...recipient,
          filtered: {
            ...recipient.filtered,
            ...Object.fromEntries(
              newlyFilteredIds.map((itemId) => [itemId, filteredAt]),
            ),
          },
        };
        filteredCount += newlyFilteredIds.length;
        await saveRecipient(recipientId, recipient);
      }

      // List.am is newest-first; reverse its stable order for ascending delivery.
      const pending = [...apartmentOrder]
        .reverse()
        .filter((itemId) => {
          const deliveredAt = recipient.notified[itemId];
          if (deliveredAt) {
            return (
              hasUpdateAfterDelivery(apartments[itemId], deliveredAt) &&
              apartmentMatchesFilters(apartments[itemId], recipientFilters)
            );
          }
          return !recipient.skipped[itemId] && !recipient.filtered[itemId];
        })
        .map((itemId) => apartments[itemId])
        .filter(Boolean);

      for (const apartment of pending) {
        if (target.isAuthorized?.() === false) break;
        try {
          await target.deliverApartment(apartment);
        } catch (error) {
          if (error.privateRecipientUnavailable) break;
          throw error;
        }
        recipient = {
          ...recipient,
          notified: {
            ...recipient.notified,
            [apartment.itemId]: now().toISOString(),
          },
        };
        await saveRecipient(recipientId, recipient);
        notifiedCount += 1;
      }
    };

    const outcomes = await Promise.allSettled(
      deliveryTargets.map(deliverRecipient),
    );
    const failed = outcomes.find(({ status }) => status === "rejected");
    if (failed) throw failed.reason;
  };

  const [privateOutcome, channelOutcome] = await Promise.allSettled([
    privateDelivery(),
    channelPublication,
  ]);
  if (privateOutcome.status === "rejected") throw privateOutcome.reason;
  if (channelOutcome.status === "rejected") throw channelOutcome.reason;

  return {
    status: initialRun
      ? "initial-crawl"
      : discovered.length > 0
        ? "new-apartments"
        : updated.length > 0
          ? "updated-apartments"
          : "unchanged",
    initialRun,
    pagesParsed,
    discovered,
    discoveredCount: discovered.length,
    updated,
    updatedCount: updated.length,
    notifiedCount,
    skippedCount,
    filteredCount,
    totalCount: Object.keys(apartments).length,
    lastKnownDate: lastKnownPostingDate.date,
    stoppedAtKnownDate,
    exhausted,
  };
}

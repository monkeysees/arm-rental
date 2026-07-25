import { extractRegularApartments } from "./list-am.js";
import { apartmentMatchesFilters, emptyFilters } from "./filters.js";
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
    state.version === 1 &&
    state.type === "telegram-deliveries" &&
    state.urlTemplate === template &&
    state.notified &&
    typeof state.notified === "object" &&
    !Array.isArray(state.notified),
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

export async function crawlApartments(
  config,
  {
    fetchPage = globalThis.fetch,
    loadState = readState,
    saveState = writeState,
    deliverApartment,
    exchangeRates,
    filters = emptyFilters(),
    now = () => new Date(),
    afterStateSaved,
  } = {},
) {
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
      if (
        !initialRun &&
        lastKnownPostingDate.value !== null &&
        postingDateValue !== null &&
        postingDateValue < lastKnownPostingDate.value
      ) {
        stoppedAtKnownDate = lastKnownPostingDate.date;
        break pageLoop;
      }
      if (encounteredIdSet.has(apartment.itemId)) continue;
      encounteredIdSet.add(apartment.itemId);
      encounteredOrder.push(apartment.itemId);
      if (Object.hasOwn(previousApartments, apartment.itemId)) {
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
    if (!sourceDataChanged(previous, observed)) continue;

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
      updatedAt: checkedAt,
    };
    apartments[itemId] = apartment;
    updated.push(apartment);
  }
  for (const apartment of discovered) {
    apartments[apartment.itemId] = {
      ...apartment,
      firstSeenAt: checkedAt,
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
    if (!deliverApartment) return;
    const storedDeliveries = await loadState(config.deliveryStateFile);
    let deliveryState = compatibleDeliveryState(
      storedDeliveries,
      config.listUrlTemplate,
    )
      ? {
          ...storedDeliveries,
          skipped: storedDeliveries.skipped || {},
          filtered: storedDeliveries.filtered || {},
          initialSelectionApplied:
            storedDeliveries.initialSelectionApplied ??
            Object.keys(storedDeliveries.notified).length > 0,
        }
      : {
          version: 1,
          type: "telegram-deliveries",
          urlTemplate: config.listUrlTemplate,
          notified: {},
          skipped: {},
          filtered: {},
          initialSelectionApplied: false,
        };

    if (!deliveryState.initialSelectionApplied && apartmentOrder.length > 0) {
      const classifiedAt = now().toISOString();
      const matchingIds = apartmentOrder.filter((itemId) =>
        apartmentMatchesFilters(apartments[itemId], filters),
      );
      const matchingIdSet = new Set(matchingIds);
      const selectedIds = new Set(
        matchingIds.slice(0, config.initialDeliveryLimit),
      );
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
      skippedCount = Object.keys(skipped).length;
      filteredCount = Object.keys(filtered).length;
      deliveryState = {
        ...deliveryState,
        initialSelectionApplied: true,
        skipped: {
          ...deliveryState.skipped,
          ...skipped,
        },
        filtered: {
          ...deliveryState.filtered,
          ...filtered,
        },
      };
      // Persist the initial selection before delivery so restarts cannot enqueue
      // omitted historical or non-matching apartments.
      await saveState(config.deliveryStateFile, deliveryState);
    }

    const unclassifiedIds = apartmentOrder.filter(
      (itemId) =>
        !deliveryState.notified[itemId] &&
        !deliveryState.skipped[itemId] &&
        !deliveryState.filtered[itemId],
    );
    const newlyFilteredIds = unclassifiedIds.filter(
      (itemId) => !apartmentMatchesFilters(apartments[itemId], filters),
    );
    if (newlyFilteredIds.length > 0) {
      const filteredAt = now().toISOString();
      deliveryState = {
        ...deliveryState,
        filtered: {
          ...deliveryState.filtered,
          ...Object.fromEntries(
            newlyFilteredIds.map((itemId) => [itemId, filteredAt]),
          ),
        },
      };
      filteredCount += newlyFilteredIds.length;
      await saveState(config.deliveryStateFile, deliveryState);
    }

    // List.am is newest-first; reversing its stable order sends by date ascending.
    const pending = [...apartmentOrder]
      .reverse()
      .filter(
        (itemId) =>
          !deliveryState.notified[itemId] &&
          !deliveryState.skipped[itemId] &&
          !deliveryState.filtered[itemId],
      )
      .map((itemId) => apartments[itemId])
      .filter(Boolean);

    for (const apartment of pending) {
      await deliverApartment(apartment);
      deliveryState = {
        ...deliveryState,
        notified: {
          ...deliveryState.notified,
          [apartment.itemId]: now().toISOString(),
        },
      };
      await saveState(config.deliveryStateFile, deliveryState);
      notifiedCount += 1;
    }
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

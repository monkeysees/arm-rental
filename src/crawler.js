import { extractRegularApartments } from "./list-am.js";
import { readState, writeState } from "./state.js";
import { pageUrl } from "./target.js";

function compatibleState(state, template) {
  return Boolean(
    state &&
      state.version === 1 &&
      state.type === "list-am-apartments" &&
      state.urlTemplate === template &&
      state.apartments &&
      typeof state.apartments === "object",
  );
}

function compatibleDeliveryState(state, template) {
  return Boolean(
    state &&
      state.version === 1 &&
      state.type === "telegram-deliveries" &&
      state.urlTemplate === template &&
      state.notified &&
      typeof state.notified === "object",
  );
}

async function fetchHtml(url, fetchPage) {
  const response = await fetchPage(url);
  if (!response.ok) {
    throw new Error(
      `List.am returned HTTP ${response.status} ${response.statusText}`,
    );
  }
  return response.text();
}

export async function crawlApartments(
  config,
  {
    fetchPage = globalThis.fetch,
    loadState = readState,
    saveState = writeState,
    deliverApartment,
    now = () => new Date(),
  } = {},
) {
  const stored = await loadState(config.apartmentsStateFile);
  const compatible = compatibleState(stored, config.listUrlTemplate);
  const previousApartments = compatible ? stored.apartments : {};
  const previousOrder = compatible ? stored.apartmentOrder || [] : [];
  const initialRun = Object.keys(previousApartments).length === 0;
  const discovered = [];
  const discoveredIdSet = new Set();
  const pageSignatures = new Set();
  let pagesParsed = 0;
  let stoppedAtKnownId = null;
  let exhausted = false;

  pageLoop: for (let page = 1; ; page += 1) {
    if (initialRun && page > config.initialPageCount) break;

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
      if (!initialRun && Object.hasOwn(previousApartments, apartment.itemId)) {
        stoppedAtKnownId = apartment.itemId;
        break pageLoop;
      }
      if (discoveredIdSet.has(apartment.itemId)) continue;
      discovered.push(apartment);
      discoveredIdSet.add(apartment.itemId);
    }
  }

  const checkedAt = now().toISOString();
  const apartments = { ...previousApartments };
  for (const apartment of discovered) {
    apartments[apartment.itemId] = {
      ...apartment,
      firstSeenAt: checkedAt,
    };
  }
  const discoveredIds = discovered.map(({ itemId }) => itemId);
  const apartmentOrder = [
    ...discoveredIds,
    ...previousOrder.filter((itemId) => !discoveredIdSet.has(itemId)),
  ];

  const state = {
    version: 1,
    type: "list-am-apartments",
    urlTemplate: config.listUrlTemplate,
    checkedAt,
    lastCrawl: {
      initialRun,
      pagesParsed,
      discoveredCount: discovered.length,
      stoppedAtKnownId,
      exhausted,
    },
    apartments,
    apartmentOrder,
  };

  await saveState(config.apartmentsStateFile, state);

  let notifiedCount = 0;
  let skippedCount = 0;
  if (deliverApartment) {
    const storedDeliveries = await loadState(config.deliveryStateFile);
    let deliveryState = compatibleDeliveryState(
      storedDeliveries,
      config.listUrlTemplate,
    )
      ? {
          ...storedDeliveries,
          skipped: storedDeliveries.skipped || {},
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
          initialSelectionApplied: false,
        };

    if (!deliveryState.initialSelectionApplied && apartmentOrder.length > 0) {
      const skippedAt = now().toISOString();
      const skipped = Object.fromEntries(
        apartmentOrder
          .slice(config.initialDeliveryLimit)
          .map((itemId) => [itemId, skippedAt]),
      );
      skippedCount = Object.keys(skipped).length;
      deliveryState = {
        ...deliveryState,
        initialSelectionApplied: true,
        skipped: {
          ...deliveryState.skipped,
          ...skipped,
        },
      };
      // Persist the initial selection before delivery so restarts cannot enqueue
      // the intentionally omitted historical apartments.
      await saveState(config.deliveryStateFile, deliveryState);
    }

    // List.am is newest-first; reversing its stable order sends by date ascending.
    const pending = [...apartmentOrder]
      .reverse()
      .filter(
        (itemId) =>
          !deliveryState.notified[itemId] && !deliveryState.skipped[itemId],
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
  }

  return {
    status: initialRun
      ? "initial-crawl"
      : discovered.length > 0
        ? "new-apartments"
        : "unchanged",
    initialRun,
    pagesParsed,
    discovered,
    discoveredCount: discovered.length,
    notifiedCount,
    skippedCount,
    totalCount: Object.keys(apartments).length,
    stoppedAtKnownId,
    exhausted,
  };
}

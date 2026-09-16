import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import {
  APARTMENT_STATE_VERSION,
  SOURCE_INTEGRITY_HISTORY_LIMIT,
} from "./apartment-state.js";
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
import { APARTMENT, propertyKindOf } from "./property-kind.js";
import { pageUrl } from "./target.js";
import { formatPostingDate, postingDateSortValue } from "./posting-date.js";
import {
  withinSourceActivity,
  withinSourceActivityWindow,
} from "./source-activity.js";
import { selectableHistory } from "./delivery-selection.js";
import { retryAfterMilliseconds } from "./retry.js";
import {
  parseAndEvaluateRegularApartments,
  sourceIntegrityPageSummary,
} from "./source-integrity.js";

/**
 * The private-delivery store rebuilds one recipient entry per stored row, so
 * every key is present but may be empty, and a recipient the store has never
 * seen is absent altogether. Filling both gaps here keeps the delivery loop
 * free of optional chaining.
 */
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
    error.retryAfterMs = retryAfterMilliseconds(
      response.headers?.get("retry-after"),
    );
    throw error;
  }
  return response.text();
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

/**
 * The posting date a card carries, or the one the crawl supplies for it.
 *
 * List.am omits the date entirely on some redesigned cards, and an ad without
 * one counts as posted when it was first parsed. The stamp is taken once: date
 * is a source field, so restamping it on every pass would report the ad as
 * changed every crawl and redeliver it forever. Every later crawl therefore
 * reuses whatever readable date the ad is already stored with.
 */
function resolvePostingDate(parsed, previousApartments, crawlDate) {
  if (postingDateSortValue(parsed.date) !== null) return parsed.date;
  const stored = previousApartments[parsed.itemId]?.date;
  return postingDateSortValue(stored) !== null ? stored : crawlDate;
}

function hasApartmentUpdateAfter(apartment, timestamp) {
  const updatedAt = Date.parse(apartment?.updatedAt);
  const timestampValue = Date.parse(timestamp);
  return (
    Number.isFinite(updatedAt) &&
    Number.isFinite(timestampValue) &&
    updatedAt > timestampValue
  );
}

/**
 * The List.am categories this crawl reads.
 *
 * Configuration names them. A caller carrying only the single template this
 * bot was built around keeps crawling exactly that one category, which is the
 * apartment listing the template has always pointed at.
 */
function configuredListSources(config) {
  if (config.listSources?.length) return config.listSources;
  return [{ kind: APARTMENT, urlTemplate: config.listUrlTemplate }];
}

/** Keeps each category's first-page history bounded and separate. */
function appendedFirstPageCounts(priorCounts, observedCounts) {
  const counts = { ...priorCounts };
  for (const [kind, parsedCount] of Object.entries(observedCounts)) {
    counts[kind] = [...(counts[kind] || []), parsedCount].slice(
      -SOURCE_INTEGRITY_HISTORY_LIMIT,
    );
  }
  return counts;
}

export async function crawlApartments(
  config,
  {
    fetchPage = globalThis.fetch,
    stateAccess,
    deliverApartment,
    privateDeliveries,
    exchangeRates,
    filters = emptyFilters(),
    now = () => new Date(),
    afterStateSaved,
    deliveryStateMutation,
    onSourceIntegrityChecked = () => {},
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

  const listSources = configuredListSources(config);
  const apartmentState = await stateAccess.apartments.loadCrawl(
    listSources.map(({ kind }) => kind),
  );
  const previousApartments = {};
  const priorFirstPageCounts =
    apartmentState.sourceIntegrity?.recentFirstPageCounts || {};
  const initialRun = apartmentState.totalCount === 0;
  // The partial index is empty after legacy prices have been frozen once.
  const changes = new Map(
    (await stateAccess.apartments.findLegacyPrices()).map((apartment) => [
      apartment.itemId,
      {
        ...apartment,
        kind: propertyKindOf(apartment),
        price: normalizeApartmentPrice(apartment.price, exchangeRates),
      },
    ]),
  );
  // Taken once, so every card this crawl has to date for itself is dated
  // identically no matter how long the crawl's pagination runs.
  const crawlPostingDate = formatPostingDate(now().getTime());
  const discovered = [];
  const observedKnown = new Map();
  // Identity is global: the same List.am item is recorded once even in the
  // improbable case that both categories list it.
  const encounteredIdSet = new Set();
  const encounteredOrder = [];
  const encounteredPostingDates = new Map();
  const firstPageParsedCounts = {};
  const sourceIntegrityChecks = [];
  const sourceSummaries = [];
  let pagesParsed = 0;

  // Each category is its own newest-first stream: it keeps its own date
  // watermark, its own pagination, and its own first-run page budget, so a
  // category added to an existing installation starts from scratch while the
  // established one keeps crawling incrementally.
  for (const { kind, urlTemplate } of listSources) {
    const lastKnownPostingDate = apartmentState.watermarks[kind];
    const kindInitialRun = lastKnownPostingDate.initialRun;
    // A category added to an installation that already holds listings performs
    // its first crawl inside an ordinary deployment, and the candidate
    // observation window bounds how long any one crawl may take there. A full
    // initial budget cannot finish inside it, and an unfinished crawl persists
    // nothing, so the category would restart the same oversized first crawl on
    // every attempt and never establish the history that makes it incremental.
    // A first installation is observed differently and keeps the full budget.
    const pageBudget =
      kindInitialRun && !initialRun
        ? config.addedCategoryPageCount
        : config.initialPageCount;
    const pageSignatures = new Set();
    let kindPagesParsed = 0;
    let stoppedAtKnownDate = null;
    let exhausted = false;

    pageLoop: for (let page = 1; ; page += 1) {
      if (
        (kindInitialRun || lastKnownPostingDate.value === null) &&
        page > pageBudget
      ) {
        break;
      }

      const html = await fetchHtml(pageUrl(page, urlTemplate), fetchPage);
      const diagnostics = parseAndEvaluateRegularApartments(html, {
        page,
        kind,
        priorFirstPageCounts: priorFirstPageCounts[kind] || [],
      });
      const { apartments } = diagnostics;
      sourceIntegrityChecks.push(
        sourceIntegrityPageSummary(diagnostics, page, kind),
      );
      if (page === 1) firstPageParsedCounts[kind] = diagnostics.parsedCount;
      kindPagesParsed += 1;
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

      const known = await stateAccess.apartments.findEncountered(
        apartments.map(({ itemId }) => itemId),
      );
      for (const [itemId, apartment] of Object.entries(known)) {
        previousApartments[itemId] = {
          ...apartment,
          kind: propertyKindOf(apartment),
          price: normalizeApartmentPrice(apartment.price, exchangeRates),
        };
      }

      for (const parsed of apartments) {
        // Only a date the source printed can say the crawl has reached history.
        // A date the crawl supplied names the minute it was taken, which always
        // falls below the end-of-day value a printed same-day card resolves to,
        // so admitting it here would retire a card first seen seconds ago and
        // abandon the rest of the page behind it.
        const sourceDated = postingDateSortValue(parsed.date) !== null;
        const apartment = {
          ...parsed,
          kind,
          date: resolvePostingDate(
            parsed,
            previousApartments,
            crawlPostingDate,
          ),
        };
        const postingDateValue = postingDateSortValue(apartment.date);
        const knownApartment = Object.hasOwn(
          previousApartments,
          apartment.itemId,
        );
        if (
          !kindInitialRun &&
          sourceDated &&
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
            encounteredPostingDates.set(apartment.itemId, postingDateValue);
            observedKnown.set(apartment.itemId, apartment);
          }
          stoppedAtKnownDate = lastKnownPostingDate.date;
          break pageLoop;
        }
        if (encounteredIdSet.has(apartment.itemId)) continue;
        encounteredIdSet.add(apartment.itemId);
        encounteredOrder.push(apartment.itemId);
        encounteredPostingDates.set(apartment.itemId, postingDateValue);
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

    sourceSummaries.push({
      kind,
      initialRun: kindInitialRun,
      pagesParsed: kindPagesParsed,
      lastKnownDate: lastKnownPostingDate.date,
      stoppedAtKnownDate,
      exhausted,
    });
  }

  // All fetched pages have passed before source health recovers. This occurs
  // before persistence and delivery so later infrastructure failures cannot
  // leave the source-integrity alert firing.
  await onSourceIntegrityChecked({ pages: sourceIntegrityChecks });

  const checkedAt = now().toISOString();
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
      lastSeenAt: checkedAt,
      updatedAt: checkedAt,
    };
    changes.set(itemId, apartment);
    updated.push(apartment);
  }
  for (const apartment of discovered) {
    changes.set(apartment.itemId, {
      ...apartment,
      firstSeenAt: checkedAt,
      lastSeenAt: checkedAt,
    });
  }
  // Each category is read newest-first, but they are read one after another,
  // so their encounters are merged back into one newest-first sequence. Every
  // later decision — history selection, channel publication, and the ascending
  // delivery that reverses this order — reads it as one stream rather than as
  // one category after another. A card the source dated and a card the crawl
  // dated for itself both carry a value here; the null branch remains for a
  // date no reading can produce, and keeps such a card behind the dated ones.
  const mergedEncounterOrder = encounteredOrder
    .map((itemId, index) => ({
      itemId,
      index,
      postedAt: encounteredPostingDates.get(itemId) ?? null,
    }))
    .sort((left, right) => {
      if (left.postedAt === right.postedAt) return left.index - right.index;
      if (left.postedAt === null) return 1;
      if (right.postedAt === null) return -1;
      return right.postedAt - left.postedAt;
    })
    .map(({ itemId }) => itemId);
  const crawlMetadata = {
    version: APARTMENT_STATE_VERSION,
    type: "list-am-apartments",
    urlTemplate: config.listUrlTemplate,
    checkedAt,
    lastCrawl: {
      initialRun,
      pagesParsed,
      discoveredCount: discovered.length,
      updatedCount: updated.length,
      sources: sourceSummaries,
    },
    sourceIntegrity: {
      recentFirstPageCounts: appendedFirstPageCounts(
        priorFirstPageCounts,
        firstPageParsedCounts,
      ),
      lastSuccessfulAt: checkedAt,
    },
  };

  const totalCount = await stateAccess.apartments.commitCrawl({
    ...crawlMetadata,
    changes: [...changes.values()],
    encounteredOrder: mergedEncounterOrder,
  });
  const channelPublication = afterStateSaved
    ? Promise.resolve().then(() => afterStateSaved(crawlMetadata))
    : Promise.resolve();

  let notifiedCount = 0;
  let skippedCount = 0;
  let filteredCount = 0;
  let readmittedCount = 0;
  // Delivery measures source activity against the instant this crawl read
  // List.am, so every recipient in the fan-out applies the same window.
  const sourceActivityReference = Date.parse(checkedAt);
  // What this crawl itself saw appear or change: the news half of any batch.
  const freshIds = new Set(
    [...discovered, ...updated].map(({ itemId }) => itemId),
  );
  const privateDelivery = async () => {
    if (deliveryTargets.length === 0) return;

    // Recipient workers run concurrently while every decision passes through
    // one chain. Bounded writes can no longer overwrite a peer, but the chain
    // is still what orders a decision against the user deletion the bot may be
    // committing at the same moment, so a late acknowledgement cannot
    // resurrect a deleted recipient. It also latches the first failure, so
    // nothing further is recorded once a write has failed.
    let deliveryStateWrites = Promise.resolve();
    const recordDecision =
      deliveryStateMutation ||
      ((operation) => {
        deliveryStateWrites = deliveryStateWrites.then(operation);
        return deliveryStateWrites;
      });
    const decisions = stateAccess.privateDeliveries.decisions;

    const deliverRecipient = async (target) => {
      if (target.isAuthorized?.() === false) return;
      const recipientId = String(target.recipientId);
      const recipientFilters = normalizeFilters(target.filters);
      const { apartments, apartmentOrder, workIds } = await recordDecision(
        () => {
          if (target.isAuthorized?.() === false)
            return { apartments: {}, apartmentOrder: [] };
          return stateAccess.privateDeliveries.loadCandidates(
            recipientId,
            JSON.stringify(recipientFilters),
          );
        },
      );
      if (target.isAuthorized?.() === false) return;
      const activeSourceIds = new Set(
        apartmentOrder.filter((itemId) =>
          withinSourceActivity(apartments[itemId], sourceActivityReference),
        ),
      );
      // Explicit selection/filter changes include expired unclassified history;
      // routine workers only decode source changes and outstanding work.
      let recipient = deliveryRecipientState(
        await stateAccess.privateDeliveries.loadRecipient(
          recipientId,
          apartmentOrder,
        ),
      );

      // The bot reopens this gate every time the user answers the monitoring
      // question, so a start, a restart after a pause, and a resumed
      // subscription all classify the history that accumulated meanwhile
      // against the answer the user just gave.
      let selectionApplied = false;
      if (!recipient.initialSelectionApplied && apartmentOrder.length > 0) {
        const classifiedAt = now().toISOString();
        const selectable = selectableHistory(
          apartmentOrder,
          apartments,
          recipient,
          recipientFilters,
          sourceActivityReference,
        );
        const selectionLimit =
          target.sendInitialApartments === false
            ? 0
            : config.initialDeliveryLimit;
        const selectedIds = new Set(selectable.slice(0, selectionLimit));
        // An accepted match may have been rejected under the filters this user
        // ran before the pause; clearing that rejection is what returns it to
        // the pending set.
        const released = [...selectedIds].filter(
          (itemId) => recipient.filtered[itemId],
        );
        const skipped = Object.fromEntries(
          selectable
            .filter((itemId) => !selectedIds.has(itemId))
            .map((itemId) => [itemId, classifiedAt]),
        );
        // Rejections keep the timestamp of the crawl that first recorded them,
        // because that is what a later List.am update is measured against.
        const filtered = Object.fromEntries(
          apartmentOrder
            .filter(
              (itemId) =>
                !recipient.notified[itemId] &&
                !recipient.skipped[itemId] &&
                !recipient.filtered[itemId] &&
                !apartmentMatchesFilters(apartments[itemId], recipientFilters),
            )
            .map((itemId) => [itemId, classifiedAt]),
        );
        skippedCount += Object.keys(skipped).length;
        filteredCount += Object.keys(filtered).length;
        readmittedCount += released.length;
        // A decision taken now replaces the rejection an apartment carried
        // from an earlier session: accepted ones return to the pending set,
        // declined ones are skipped, and neither may stay filtered as well.
        const retainedFiltered = { ...recipient.filtered, ...filtered };
        for (const itemId of [...released, ...Object.keys(skipped)]) {
          delete retainedFiltered[itemId];
        }
        recipient = {
          ...recipient,
          initialSelectionApplied: true,
          skipped: { ...recipient.skipped, ...skipped },
          filtered: retainedFiltered,
        };
        selectionApplied = true;
        // Persist classification before sending so a restart cannot enqueue
        // historical apartments that were intentionally omitted for this user.
        await recordDecision(() =>
          decisions.applyInitialSelection(recipientId, {
            skipped,
            filtered,
            released,
          }),
        );
      }

      // A rejected apartment starts matching only when the user edits their
      // filters or List.am changes the card. Delivery releases the second case
      // on its own: the card's data changed inside the window after the
      // rejection, which is fresh source activity rather than history. A
      // widened filter releases nothing here — the bot asks the user about
      // that backlog through the menu instead.
      const readmittedIds = apartmentOrder.filter((itemId) => {
        const filteredAt = recipient.filtered[itemId];
        if (!filteredAt) return false;
        const apartment = apartments[itemId];
        return (
          hasApartmentUpdateAfter(apartment, filteredAt) &&
          withinSourceActivityWindow(
            apartment.updatedAt,
            sourceActivityReference,
          ) &&
          apartmentMatchesFilters(apartment, recipientFilters)
        );
      });
      if (readmittedIds.length > 0) {
        const filtered = { ...recipient.filtered };
        for (const itemId of readmittedIds) delete filtered[itemId];
        recipient = { ...recipient, filtered };
        // Make re-admission durable before Telegram delivery. If sending is
        // interrupted, the now-unclassified apartment remains pending on the
        // next crawl instead of falling back into its obsolete rejection.
        await recordDecision(() =>
          decisions.readmitFiltered(recipientId, readmittedIds),
        );
        readmittedCount += readmittedIds.length;
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
        const newlyFiltered = Object.fromEntries(
          newlyFilteredIds.map((itemId) => [itemId, filteredAt]),
        );
        recipient = {
          ...recipient,
          filtered: { ...recipient.filtered, ...newlyFiltered },
        };
        filteredCount += newlyFilteredIds.length;
        await recordDecision(() =>
          decisions.classifyFiltered(recipientId, newlyFiltered),
        );
      }

      // List.am is newest-first; reverse its stable order for ascending delivery.
      const pending = [...apartmentOrder]
        .reverse()
        .filter((itemId) => {
          // One bound covers every path into the pending set: a private
          // recipient is only ever sent what List.am posted or changed inside
          // the source-activity window. An older card waits for its next
          // List.am update instead of arriving as news.
          if (!activeSourceIds.has(itemId)) {
            return false;
          }
          const deliveredAt = recipient.notified[itemId];
          if (deliveredAt) {
            // The same bound guards redelivery: a stale update that only
            // becomes a match because the user widened a filter is history,
            // not news. A genuine change is always observed by the crawl that
            // records it, so it is inside the window when it matters.
            return (
              hasApartmentUpdateAfter(apartments[itemId], deliveredAt) &&
              withinSourceActivityWindow(
                apartments[itemId].updatedAt,
                sourceActivityReference,
              ) &&
              apartmentMatchesFilters(apartments[itemId], recipientFilters)
            );
          }
          return !recipient.skipped[itemId] && !recipient.filtered[itemId];
        })
        .map((itemId) => apartments[itemId])
        .filter(Boolean);

      await recordDecision(() =>
        stateAccess.privateDeliveries.retainPending(
          recipientId,
          pending.map(({ itemId }) => itemId),
          workIds,
        ),
      );

      // A batch that carries history — everything this crawl selected for a
      // fresh answer, or left pending by an earlier interrupted send —
      // announces itself first, so a burst of apartments never arrives
      // unexplained. A routine crawl delivering what it has just seen appear
      // or change on List.am stays silent and sends the apartment alone.
      const carriesHistory =
        selectionApplied || pending.some(({ itemId }) => !freshIds.has(itemId));
      if (pending.length > 0 && carriesHistory && target.announceDelivery) {
        if (target.isAuthorized?.() === false) return;
        try {
          await target.announceDelivery({ count: pending.length });
        } catch (error) {
          if (!error.privateRecipientUnavailable) throw error;
          return;
        }
      }

      const remaining = new Set(pending.map(({ itemId }) => itemId));
      for (const apartment of pending) {
        if (target.isAuthorized?.() === false) break;
        try {
          await target.deliverApartment(apartment);
        } catch (error) {
          if (error.privateRecipientUnavailable) break;
          throw error;
        }
        const deliveredAt = now().toISOString();
        recipient = {
          ...recipient,
          notified: { ...recipient.notified, [apartment.itemId]: deliveredAt },
        };
        await recordDecision(() =>
          decisions.acknowledge(recipientId, apartment.itemId, deliveredAt),
        );
        remaining.delete(apartment.itemId);
        notifiedCount += 1;
      }
      if (remaining.size !== pending.length)
        await recordDecision(() =>
          stateAccess.privateDeliveries.retainPending(
            recipientId,
            [...remaining],
            workIds,
          ),
        );
    };

    const workers = [];
    const startWorker = async (target) =>
      target.runDeliveryWorker
        ? target.runDeliveryWorker(() => deliverRecipient(target))
        : deliverRecipient(target);
    for (const target of deliveryTargets) {
      // Promise continuations alone starve health and source I/O during fan-out.
      // Stagger worker starts across event-loop turns while sends stay concurrent.
      await yieldToEventLoop();
      workers.push(Promise.allSettled([startWorker(target)]));
      await yieldToEventLoop();
    }
    const outcomes = (await Promise.all(workers)).flat();
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
    readmittedCount,
    totalCount,
    sources: sourceSummaries,
    sourceIntegrity: { pages: sourceIntegrityChecks },
  };
}

import {
  formatPropertyKinds,
  propertyKindLabel,
  PROPERTY_KINDS,
} from "./property-kind.js";
import { SOURCE_ACTIVITY_WINDOW_MS } from "./source-activity.js";
import {
  emptyFilters,
  formatLocations,
  formatRange,
  LOCATION_REGIONS,
  normalizeFilters,
  placeLocationId,
  regionLocationId,
} from "./filters.js";

function button(text, callbackData) {
  return { text, callback_data: callbackData };
}

export function filtersMenu(filters, active = false) {
  const normalized = normalizeFilters(filters);
  return {
    text: [
      "Главное меню",
      "",
      `Мониторинг: ${active ? "запущен" : "остановлен"}`,
      `Тип жилья: ${formatPropertyKinds(normalized.kinds)}`,
      `Цена (֏): ${formatRange(normalized.price)}`,
      `Комнаты: ${formatRange(normalized.rooms)}`,
      `Местоположение: ${formatLocations(normalized.locations)}`,
    ].join("\n"),
    replyMarkup: {
      inline_keyboard: [
        [button("Цена, ֏", "f:price"), button("Комнаты", "f:rooms")],
        [
          button("Тип жилья", "f:kinds"),
          button("Местоположение", "f:locations"),
        ],
        [button("Сбросить фильтры", "f:reset")],
        [
          active
            ? button("Остановить мониторинг", "m:stop")
            : button("Запустить мониторинг", "m:start"),
        ],
      ],
    },
  };
}

/**
 * The delivery promise every history question is phrased against.
 *
 * Russian counts change the noun's ending, so the hour count picks its own
 * form: the label stays correct if the window is ever retuned.
 */
export function sourceActivityWindowLabel() {
  const hours = Math.round(SOURCE_ACTIVITY_WINDOW_MS / (60 * 60 * 1000));
  const tail = hours % 100;
  const last = tail % 10;
  const form =
    tail >= 11 && tail <= 14
      ? "часов"
      : last === 1
        ? "час"
        : last >= 2 && last <= 4
          ? "часа"
          : "часов";
  return `${hours} ${form}`;
}

export function initialDeliveryMenu(limit = 100) {
  return {
    text: [
      "Отправить уже найденные объявления?",
      "",
      `Перед запуском мониторинга бот может отправить подходящие объявления за последние ${sourceActivityWindowLabel()} — не больше ${limit}. Или можно начать только с новых объявлений.`,
    ].join("\n"),
    replyMarkup: {
      inline_keyboard: [
        [button("Да, отправить", "m:start:initial")],
        [button("Нет, только новые", "m:start:new")],
        [button("← В главное меню", "f:menu")],
      ],
    },
  };
}

/**
 * Offers the history a widened filter uncovered.
 *
 * Delivery never releases that backlog on its own, so this is the only way a
 * previously rejected listing reaches the user. Declining is durable: those
 * listings are marked skipped and are not offered again.
 */
export function historyOfferMenu(count) {
  return {
    text: [
      "Фильтры изменены.",
      "",
      `Подходящих объявлений за последние ${sourceActivityWindowLabel()}: ${count}.`,
      "Отправить их или ждать только новые объявления?",
    ].join("\n"),
    replyMarkup: {
      inline_keyboard: [
        [button("Да, отправить", "m:history:send")],
        [button("Нет, только новые", "m:history:skip")],
      ],
    },
  };
}

/** Precedes a batch that carries history, so a burst is never unexplained. */
export function deliveryAnnouncementText(count) {
  return [
    `Подходящих объявлений за последние ${sourceActivityWindowLabel()}: ${count}.`,
    "Отправляю…",
  ].join(" ");
}

export function historyAcceptedText(count) {
  return count > 0
    ? `Хорошо, отправлю их при следующей проверке. Объявлений: ${count}.`
    : "Отправлять нечего: подходящих объявлений за это время не осталось.";
}

export const HISTORY_DECLINED_TEXT =
  "Хорошо, эти объявления отправлены не будут — придут только новые.";

export function deleteDataMenu() {
  return {
    text: [
      "Удалить все ваши данные?",
      "",
      "Будут удалены фильтры и история уведомлений, а мониторинг остановится.",
      "При новой регистрации подписка будет создана заново, и потребуется снова выбрать, отправлять ли уже найденные объявления.",
    ].join("\n"),
    replyMarkup: {
      inline_keyboard: [
        [button("Удалить мои данные", "d:confirm")],
        [button("Отмена", "d:cancel")],
      ],
    },
  };
}

/**
 * The housing kinds this subscription follows.
 *
 * At least one kind is always selected: a subscription that followed nothing
 * would silently deliver nothing, so the menu simply refuses to clear the last
 * remaining choice.
 */
export function kindsMenu(filters) {
  const selected = new Set(normalizeFilters(filters).kinds);
  return {
    text: [
      "Тип жилья",
      "",
      "Выберите, какие объявления отслеживать. Можно выбрать оба типа, но не меньше одного.",
      `Выбрано: ${formatPropertyKinds([...selected])}`,
    ].join("\n"),
    replyMarkup: {
      inline_keyboard: [
        ...PROPERTY_KINDS.map((kind) => [
          button(
            `${selected.has(kind) ? "✅" : "▫️"} ${propertyKindLabel(kind)}`,
            `f:kind:${kind}`,
          ),
        ]),
        [button("← В главное меню", "f:menu")],
      ],
    },
  };
}

/** Toggles one kind, keeping the selection non-empty. */
export function toggleKind(filters, kind) {
  const normalized = normalizeFilters(filters);
  const selected = new Set(normalized.kinds);
  if (!selected.has(kind)) selected.add(kind);
  else if (selected.size > 1) selected.delete(kind);

  return {
    ...normalized,
    kinds: PROPERTY_KINDS.filter((candidate) => selected.has(candidate)),
  };
}

export function locationsMenu(filters) {
  const selected = new Set(normalizeFilters(filters).locations);
  const inlineKeyboard = LOCATION_REGIONS.map((region, regionIndex) => {
    const wholeRegion = selected.has(regionLocationId(regionIndex));
    const selectedPlaces = region.places.filter((_place, placeIndex) =>
      selected.has(placeLocationId(regionIndex, placeIndex)),
    ).length;
    const marker = wholeRegion
      ? "✅"
      : selectedPlaces > 0
        ? `• ${selectedPlaces}`
        : "▫️";
    return [button(`${marker} ${region.name}`, `f:region:${regionIndex}`)];
  });
  inlineKeyboard.push([button("← В главное меню", "f:menu")]);

  return {
    text: [
      "Выбор местоположения",
      "",
      "Откройте нужный раздел. Можно выбрать его целиком или указать одно или несколько отдельных мест.",
      `Выбрано: ${formatLocations([...selected])}`,
    ].join("\n"),
    replyMarkup: { inline_keyboard: inlineKeyboard },
  };
}

export function regionMenu(filters, regionIndex) {
  const normalized = normalizeFilters(filters);
  const selected = new Set(normalized.locations);
  const region = LOCATION_REGIONS[regionIndex];
  if (!region) return locationsMenu(filters);

  const wholeRegionId = regionLocationId(regionIndex);
  const inlineKeyboard = [
    [
      button(
        `${selected.has(wholeRegionId) ? "✅" : "▫️"} ${
          regionIndex === 0 ? "Весь Ереван" : "Весь регион"
        }`,
        `f:all:${regionIndex}`,
      ),
    ],
    ...region.places.map((place, placeIndex) => {
      const id = placeLocationId(regionIndex, placeIndex);
      return [
        button(
          `${selected.has(id) ? "✅" : "▫️"} ${place}`,
          `f:place:${regionIndex}:${placeIndex}`,
        ),
      ];
    }),
    [button("← К списку", "f:locations")],
  ];

  return {
    text: [
      regionIndex === 0 ? "Ереван и его районы" : region.name,
      "",
      regionIndex === 0
        ? "Выберите весь Ереван или один или несколько его районов."
        : "Выберите весь регион или один или несколько городов и населённых пунктов.",
    ].join("\n"),
    replyMarkup: { inline_keyboard: inlineKeyboard },
  };
}

export function toggleWholeRegion(filters, regionIndex) {
  const normalized = normalizeFilters(filters);
  const selected = new Set(normalized.locations);
  const regionId = regionLocationId(regionIndex);

  if (selected.has(regionId)) {
    selected.delete(regionId);
  } else {
    for (
      let placeIndex = 0;
      placeIndex < LOCATION_REGIONS[regionIndex].places.length;
      placeIndex += 1
    ) {
      selected.delete(placeLocationId(regionIndex, placeIndex));
    }
    selected.add(regionId);
  }

  return { ...normalized, locations: [...selected] };
}

export function togglePlace(filters, regionIndex, placeIndex) {
  const normalized = normalizeFilters(filters);
  const selected = new Set(normalized.locations);
  const placeId = placeLocationId(regionIndex, placeIndex);

  selected.delete(regionLocationId(regionIndex));
  if (selected.has(placeId)) selected.delete(placeId);
  else selected.add(placeId);

  return { ...normalized, locations: [...selected] };
}

export function resetFilters() {
  return emptyFilters();
}

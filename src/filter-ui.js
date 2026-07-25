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
      "Фильтры объявлений",
      "",
      `Мониторинг: ${active ? "запущен" : "остановлен"}`,
      `Цена (֏): ${formatRange(normalized.price)}`,
      `Комнаты: ${formatRange(normalized.rooms)}`,
      `Местоположение: ${formatLocations(normalized.locations)}`,
    ].join("\n"),
    replyMarkup: {
      inline_keyboard: [
        [button("💰 Цена, ֏", "f:price"), button("🚪 Комнаты", "f:rooms")],
        [button("📍 Местоположение", "f:locations")],
        [button("Сбросить всё", "f:reset")],
        [
          active
            ? button("⏹ Остановить мониторинг", "m:stop")
            : button("▶️ Запустить мониторинг", "m:start"),
        ],
      ],
    },
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
  inlineKeyboard.push([button("← К фильтрам", "f:menu")]);

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

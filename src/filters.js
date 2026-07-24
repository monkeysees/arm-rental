export const LOCATION_REGIONS = [
  {
    name: "Ереван",
    places: [
      "Ачапняк",
      "Арабкир",
      "Аван",
      "Давташен",
      "Эребуни",
      "Канакер-Зейтун",
      "Кентрон",
      "Малатия-Себастия",
      "Нор Норк",
      "Норк-Мараш",
      "Нубарашен",
      "Шенгавит",
    ],
  },
  {
    name: "Армавир",
    places: [
      "Армавир",
      "Эчмиадзин",
      "Баграмян",
      "Мердзаван",
      "Мецамор",
      "Паракар",
      "Таиров",
      "Акналич",
      "Норакерт",
    ],
  },
  {
    name: "Арарат",
    places: [
      "Арташат",
      "Масис",
      "Арарат",
      "Аргаванд",
      "Айнтап",
      "Геганист",
      "Хачпар",
      "Нор Харберд",
      "Веди",
      "Далар",
      "Джрашен",
      "Норамарг",
    ],
  },
  {
    name: "Котайк",
    places: [
      "Абовян",
      "Ариндж",
      "Бюрегаван",
      "Чаренцаван",
      "Дзорахбюр",
      "Гарни",
      "Раздан",
      "Джрвеж",
      "Касах",
      "Котайк",
      "Мргашен",
      "Нор Ачин",
      "Прошян",
      "Цахкадзор",
      "Верин Птгни",
      "Зовуни",
      "Мехрадзор",
    ],
  },
  {
    name: "Ширак",
    places: ["Гюмри", "Ахурян", "Артик", "Ашоцк", "Маралик"],
  },
  {
    name: "Лори",
    places: [
      "Ванадзор",
      "Алаверди",
      "Степанаван",
      "Ташир",
      "Каркоп",
      "Туманян",
    ],
  },
  {
    name: "Гехаркуник",
    places: ["Гавар", "Мартуни", "Севан", "Варденис"],
  },
  {
    name: "Сюник",
    places: ["Горис", "Капан", "Сисиан", "Каджаран"],
  },
  {
    name: "Арагацотн",
    places: [
      "Апаран",
      "Аштарак",
      "Талин",
      "Уджан",
      "Сасуник",
      "Ехипатруш",
      "Еринджатап",
    ],
  },
  {
    name: "Тавуш",
    places: ["Дилижан", "Иджеван"],
  },
  {
    name: "Вайоц Дзор",
    places: ["Джермук", "Вайк", "Егегнадзор", "Арени"],
  },
];

export function regionLocationId(regionIndex) {
  return `r:${regionIndex}`;
}

export function placeLocationId(regionIndex, placeIndex) {
  return `p:${regionIndex}:${placeIndex}`;
}

const VALID_LOCATION_IDS = new Set(
  LOCATION_REGIONS.flatMap((region, regionIndex) => [
    regionLocationId(regionIndex),
    ...region.places.map((_place, placeIndex) =>
      placeLocationId(regionIndex, placeIndex),
    ),
  ]),
);

export function emptyFilters() {
  return {
    price: { min: null, max: null },
    rooms: { min: null, max: null },
    locations: [],
  };
}

function optionalNumber(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function normalizeFilters(value) {
  let locations = Array.isArray(value?.locations)
    ? [...new Set(value.locations.filter((id) => VALID_LOCATION_IDS.has(id)))]
    : [];
  const selected = new Set(locations);
  locations = locations.filter((id) => {
    if (!id.startsWith("p:")) return true;
    const regionIndex = id.split(":")[1];
    return !selected.has(regionLocationId(Number(regionIndex)));
  });

  return {
    price: {
      min: optionalNumber(value?.price?.min),
      max: optionalNumber(value?.price?.max),
    },
    rooms: {
      min: optionalNumber(value?.rooms?.min),
      max: optionalNumber(value?.rooms?.max),
    },
    locations,
  };
}

function matchesRange(value, range) {
  if (range.min === null && range.max === null) return true;
  if (!Number.isFinite(value)) return false;
  return (
    (range.min === null || value >= range.min) &&
    (range.max === null || value <= range.max)
  );
}

function normalizedLocationParts(value) {
  return new Set(
    String(value || "")
      .normalize("NFKC")
      .split(/\s*[,/]\s*/u)
      .map((part) => part.trim().toLocaleLowerCase("ru-RU"))
      .filter(Boolean),
  );
}

function selectedLocationNames(locationIds) {
  const names = new Set();

  for (const id of locationIds) {
    const [type, regionText, placeText] = id.split(":");
    const regionIndex = Number(regionText);
    const region = LOCATION_REGIONS[regionIndex];
    if (!region) continue;

    if (type === "r") {
      names.add(region.name);
      for (const place of region.places) names.add(place);
    } else if (type === "p") {
      const place = region.places[Number(placeText)];
      if (place) names.add(place);
    }
  }

  return [...names].map((name) =>
    name.normalize("NFKC").toLocaleLowerCase("ru-RU"),
  );
}

export function apartmentMatchesFilters(apartment, rawFilters) {
  const filters = normalizeFilters(rawFilters);
  if (!matchesRange(apartment?.price?.amount, filters.price)) return false;
  if (!matchesRange(apartment?.rooms, filters.rooms)) return false;
  if (filters.locations.length === 0) return true;

  const apartmentLocations = normalizedLocationParts(apartment?.location);
  return selectedLocationNames(filters.locations).some((location) =>
    apartmentLocations.has(location),
  );
}

function parseNonNegativeInteger(value, label) {
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${label}: используйте только целые числа.`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label}: число слишком большое.`);
  }
  return parsed;
}

export function parseRangeInput(value, kind) {
  const label = kind === "price" ? "Цена" : "Количество комнат";
  const text = String(value || "")
    .trim()
    .toLocaleLowerCase("ru-RU");

  if (["нет", "любой", "любое", "сбросить"].includes(text)) {
    return { min: null, max: null };
  }

  const compact = text.replace(/\s+/gu, "").replace(/[–—]/gu, "-");
  const match = compact.match(/^(\d*)-(\d*)$/u);
  const exact = compact.match(/^\d+$/u);
  if (!match && !exact) {
    const examples =
      kind === "price"
        ? "«100000-250000», «100000-» или «-250000»"
        : "«1-3», «2-» или «-4»";
    throw new Error(
      `${label}: введите целое число или диапазон, например ${examples}.`,
    );
  }

  const minimumText = exact?.[0] || match[1];
  const maximumText = exact?.[0] || match[2];
  if (!minimumText && !maximumText) {
    throw new Error(`${label}: укажите хотя бы одну границу диапазона.`);
  }

  const min = minimumText ? parseNonNegativeInteger(minimumText, label) : null;
  const max = maximumText ? parseNonNegativeInteger(maximumText, label) : null;

  if (kind === "rooms" && (min === 0 || max === 0)) {
    throw new Error("Количество комнат должно быть не меньше одного.");
  }
  if (min !== null && max !== null && min > max) {
    throw new Error(
      `${label}: минимальное значение не может быть больше максимального.`,
    );
  }

  return { min, max };
}

function formatNumber(value) {
  return value.toLocaleString("ru-RU");
}

export function formatRange(range, suffix = "") {
  if (range.min === null && range.max === null) return "без ограничений";
  if (range.min !== null && range.max !== null) {
    return range.min === range.max
      ? `${formatNumber(range.min)}${suffix}`
      : `${formatNumber(range.min)}–${formatNumber(range.max)}${suffix}`;
  }
  return range.min !== null
    ? `от ${formatNumber(range.min)}${suffix}`
    : `до ${formatNumber(range.max)}${suffix}`;
}

export function locationSelectionLabel(id) {
  const [type, regionText, placeText] = id.split(":");
  const regionIndex = Number(regionText);
  const region = LOCATION_REGIONS[regionIndex];
  if (!region) return null;
  if (type === "r") {
    return regionIndex === 0
      ? "Ереван целиком"
      : `${region.name} (весь регион)`;
  }
  return region.places[Number(placeText)] || null;
}

export function formatLocations(locationIds) {
  const labels = locationIds.map(locationSelectionLabel).filter(Boolean);
  if (labels.length === 0) return "без ограничений";
  if (labels.length <= 3) return labels.join(", ");
  return `${labels.slice(0, 3).join(", ")} и ещё ${labels.length - 3}`;
}

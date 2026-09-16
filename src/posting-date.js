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

/** Words List.am prints instead of a calendar day for the most recent cards. */
const RELATIVE_DAYS_AGO = new Map([
  ["сегодня", 0],
  ["today", 0],
  ["вчера", 1],
  ["yesterday", 1],
]);

// "Пятница, Июль 24, 2026, 14:31" — the only form that names an instant.
const DATED_INSTANT =
  /^[^,]+,\s*([^,\s]+)\s+(\d{1,2}),\s*(\d{4}),\s*(\d{1,2}):(\d{2})$/u;
// "Сегодня, 00:00"
const RELATIVE_DAY = /^([^\s,]+)\s*,\s*(\d{1,2}):(\d{2})$/u;
// "Сентябрь 04"
const MONTH_AND_DAY = /^([^\s,]+)\s+(\d{1,2})$/u;

/** The weekday names List.am leads a fully dated card with. */
const WEEKDAY_NAMES = [
  "Воскресенье",
  "Понедельник",
  "Вторник",
  "Среда",
  "Четверг",
  "Пятница",
  "Суббота",
];

/** The nominative month names List.am prints on a card that names a day. */
const MONTH_NAMES = [
  "Январь",
  "Февраль",
  "Март",
  "Апрель",
  "Май",
  "Июнь",
  "Июль",
  "Август",
  "Сентябрь",
  "Октябрь",
  "Ноябрь",
  "Декабрь",
];

const DAY_MS = 24 * 60 * 60 * 1000;
/** How far ahead of the reference an inferred year may still land. */
const FUTURE_TOLERANCE_MS = 2 * DAY_MS;

function monthNumber(name) {
  return MONTH_NUMBERS.get(name.toLocaleLowerCase("ru-RU"));
}

/**
 * The last millisecond of a displayed calendar day.
 *
 * A card that names only a day could have been posted at any hour of it. The
 * end of the day is the estimate that keeps such a card inside the delivery
 * window for as long as it might belong there: reading it as midnight would
 * retire a card up to a day early and silently drop listings that are still
 * current.
 */
function endOfDay(year, month, day) {
  const value = Date.UTC(year, month, day, 23, 59, 59, 999);
  const parsed = new Date(value);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return value;
}

/**
 * The year a month and day without one belong to.
 *
 * List.am stopped printing the year, so a card read in January that names a
 * December day belongs to the year before the one being read in.
 */
function inferYear(month, day, referenceValue) {
  const year = new Date(referenceValue).getUTCFullYear();
  const candidate = endOfDay(year, month, day);
  if (candidate === null) return year;
  return candidate - referenceValue > FUTURE_TOLERANCE_MS ? year - 1 : year;
}

/**
 * Returns a stable ordering value for List.am's displayed posting date.
 *
 * UTC is used only to compare the displayed calendar components; the source
 * value is not interpreted as an instant in UTC.
 *
 * List.am's redesigned cards name a calendar day rather than an instant, so
 * every form that lacks a year resolves to day granularity even when it prints
 * a clock time. Mixing the two precisions inside one category would order a
 * card printed as "Сегодня, 00:00" behind same-day cards printed as a date,
 * and the crawl's date watermark would read that as history.
 */
export function postingDateSortValue(value, referenceValue = Date.now()) {
  if (typeof value !== "string") return null;
  const text = value.trim();

  const instant = text.match(DATED_INSTANT);
  if (instant) {
    const month = monthNumber(instant[1]);
    if (month === undefined) return null;
    const [, , dayText, yearText, hourText, minuteText] = instant;
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
    return sortValue;
  }

  const relative = text.match(RELATIVE_DAY);
  if (relative) {
    const daysAgo = RELATIVE_DAYS_AGO.get(
      relative[1].toLocaleLowerCase("ru-RU"),
    );
    const [hour, minute] = [relative[2], relative[3]].map(Number);
    if (daysAgo === undefined || hour > 23 || minute > 59) return null;
    const day = new Date(referenceValue - daysAgo * DAY_MS);
    return endOfDay(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  }

  const monthDay = text.match(MONTH_AND_DAY);
  if (monthDay) {
    const month = monthNumber(monthDay[1]);
    if (month === undefined) return null;
    const day = Number(monthDay[2]);
    return endOfDay(inferYear(month, day, referenceValue), month, day);
  }

  return null;
}

/** Index keys retain relative/yearless semantics without scanning old payloads. */
export function postingDateIndex(value) {
  const text = typeof value === "string" ? value.trim() : "";
  const annual = text.match(MONTH_AND_DAY);
  if (annual) {
    const month = monthNumber(annual[1]);
    const day = Number(annual[2]);
    if (month !== undefined && endOfDay(2000, month, day) !== null) {
      return { bucket: "annual", key: month * 32 + day };
    }
  }
  const relative = text.match(RELATIVE_DAY);
  if (relative && postingDateSortValue(text) !== null) {
    return {
      bucket: "relative",
      key: -RELATIVE_DAYS_AGO.get(relative[1].toLocaleLowerCase("ru-RU")),
    };
  }
  return { bucket: "fixed", key: postingDateSortValue(text) };
}

export function annualPostingDateCutoff(referenceValue = Date.now()) {
  const date = new Date(referenceValue + FUTURE_TOLERANCE_MS - (DAY_MS - 1));
  return date.getUTCMonth() * 32 + date.getUTCDate();
}

/**
 * Renders an instant in the dated form List.am prints with a year and a clock.
 *
 * Some redesigned cards carry no date at all, and the crawl supplies one for
 * them. This is the one displayed form that names an instant, so a supplied
 * date keeps the minute it was taken rather than collapsing to a whole day.
 *
 * That precision is why a supplied date must never be compared against the
 * crawl's date watermark: printed same-day cards resolve to the end of their
 * day, so any instant within today is below them and the watermark would read
 * a card the crawl has only just seen as history. The crawler excludes cards
 * the source left undated from that comparison for exactly this reason.
 *
 * The components are rendered in UTC, so a stamp taken late in the UTC evening
 * names the day before the one List.am's own clock is on. That is deliberate:
 * this module reads every printed component as UTC too, and rendering the
 * source's zone here would make the string parse back four hours ahead of the
 * instant it was taken. The offset is absorbed the way `source-activity.js`
 * absorbs it, by a window a whole day wide, rather than by guessing the zone.
 */
export function formatPostingDate(value = Date.now()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return (
    `${WEEKDAY_NAMES[date.getUTCDay()]}, ` +
    `${MONTH_NAMES[date.getUTCMonth()]} ${day}, ` +
    `${date.getUTCFullYear()}, ${hours}:${minutes}`
  );
}

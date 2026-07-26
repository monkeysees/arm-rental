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

/**
 * Returns a stable ordering value for List.am's displayed posting date.
 * UTC is used only to compare the displayed calendar components; the source
 * value is not interpreted as an instant in UTC.
 */
export function postingDateSortValue(value) {
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

  return sortValue;
}

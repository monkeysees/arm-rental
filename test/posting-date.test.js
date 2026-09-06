import assert from "node:assert/strict";
import test from "node:test";

import {
  formatPostingDate,
  postingDateSortValue,
} from "../src/posting-date.js";
import { postedWithinSourceActivityWindow } from "../src/source-activity.js";

test("posting dates produce locale-independent calendar ordering values", () => {
  const russian = postingDateSortValue("Пятница, Июль 24, 2026, 14:31");
  const english = postingDateSortValue("Friday, July 24, 2026, 14:31");
  const later = postingDateSortValue("Friday, July 24, 2026, 14:32");

  assert.equal(russian, Date.UTC(2026, 6, 24, 14, 31));
  assert.equal(english, russian);
  assert.ok(later > russian);
});

test("posting dates reject invalid format and calendar components", () => {
  assert.equal(postingDateSortValue(null), null);
  assert.equal(postingDateSortValue("2026-07-24T14:31:00Z"), null);
  assert.equal(postingDateSortValue("Friday, Unknown 24, 2026, 14:31"), null);
  assert.equal(postingDateSortValue("Friday, February 30, 2026, 14:31"), null);
  assert.equal(postingDateSortValue("Friday, July 24, 2026, 24:00"), null);
  assert.equal(postingDateSortValue("Unknown 04"), null);
  assert.equal(postingDateSortValue("Сентябрь 31"), null);
  assert.equal(postingDateSortValue("Позавчера, 10:00"), null);
});

test("a card naming only a calendar day is ordered at the end of that day", () => {
  const reference = Date.parse("2026-09-04T20:00:00.000Z");
  const endOf = (year, month, day) =>
    Date.UTC(year, month, day, 23, 59, 59, 999);

  // Reading the day as midnight instead would retire a card up to a day early.
  assert.equal(
    postingDateSortValue("Сентябрь 04", reference),
    endOf(2026, 8, 4),
  );
  assert.equal(
    postingDateSortValue("Сентябрь 02", reference),
    endOf(2026, 8, 2),
  );
  assert.ok(
    postingDateSortValue("Сентябрь 04", reference) >
      postingDateSortValue("Сентябрь 03", reference),
  );

  // A clock time without a year still resolves to its day, so that a card
  // printed as "Сегодня" never orders behind same-day cards printed as a date.
  assert.equal(
    postingDateSortValue("Сегодня, 00:00", reference),
    postingDateSortValue("Сентябрь 04", reference),
  );
  assert.equal(
    postingDateSortValue("Вчера, 13:45", reference),
    endOf(2026, 8, 3),
  );
});

test("a day without a year belongs to the year it was read before", () => {
  const january = Date.parse("2027-01-05T10:00:00.000Z");

  assert.equal(
    postingDateSortValue("Декабрь 30", january),
    Date.UTC(2026, 11, 30, 23, 59, 59, 999),
  );
  assert.equal(
    postingDateSortValue("Январь 03", january),
    Date.UTC(2027, 0, 3, 23, 59, 59, 999),
  );
});

test("a day-granular posting date holds its delivery window for a full day", () => {
  const posted = "Сентябрь 03";
  const sameDay = Date.parse("2026-09-04T20:00:00.000Z");
  const twoDaysOn = Date.parse("2026-09-05T20:00:00.000Z");

  assert.equal(
    postedWithinSourceActivityWindow({ date: posted }, sameDay),
    true,
  );
  assert.equal(
    postedWithinSourceActivityWindow({ date: posted }, twoDaysOn),
    false,
  );
});

test("source activity falls back to first-seen time for unusable posting dates", () => {
  const reference = Date.parse("2026-07-24T12:00:00.000Z");
  const withoutDate = (firstSeenAt) => ({ date: "unparsable", firstSeenAt });

  assert.equal(
    postedWithinSourceActivityWindow(
      withoutDate("2026-07-24T11:00:00.000Z"),
      reference,
    ),
    true,
  );
  assert.equal(
    postedWithinSourceActivityWindow(
      withoutDate("2026-07-22T11:00:00.000Z"),
      reference,
    ),
    false,
  );
  // A record carrying neither a usable date nor a first-seen time is history.
  assert.equal(postedWithinSourceActivityWindow(undefined, reference), false);
});

test("a supplied posting date names the instant it was taken", () => {
  const reference = Date.parse("2026-09-05T22:15:00.000Z");

  assert.equal(
    formatPostingDate(reference),
    "Суббота, Сентябрь 05, 2026, 22:15",
  );
  // The supplied form is the one displayed shape that keeps a clock time, so it
  // round-trips to the minute rather than to the end of its day.
  assert.equal(
    postingDateSortValue(formatPostingDate(reference), reference),
    reference,
  );

  // Reading it later cannot move it: unlike a relative day, it names its year.
  assert.equal(
    postingDateSortValue(
      formatPostingDate(reference),
      Date.parse("2027-03-01T09:00:00.000Z"),
    ),
    reference,
  );

  // A printed same-day card still resolves to the end of its day, which is why
  // the crawler must not weigh a supplied date against the date watermark.
  assert.ok(
    postingDateSortValue(formatPostingDate(reference), reference) <
      postingDateSortValue("Сегодня, 18:57", reference),
  );

  assert.equal(formatPostingDate(Number.NaN), null);
});

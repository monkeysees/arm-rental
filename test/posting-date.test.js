import assert from "node:assert/strict";
import test from "node:test";

import { postingDateSortValue } from "../src/posting-date.js";
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

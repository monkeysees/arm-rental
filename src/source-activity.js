import { postingDateSortValue } from "./posting-date.js";

/**
 * How far back delivery still counts List.am activity as current.
 *
 * A filter change makes apartments that were once rejected match, and List.am
 * keeps renewing ads that were posted long ago. Without a bound, editing a
 * filter would release the whole rejected backlog at once, because the flags
 * that record past source activity never expire. Re-admission is therefore
 * limited to the last day of activity, and older history waits for its next
 * List.am update.
 */
export const SOURCE_ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Whether an ISO instant recorded by this installation is still current. */
export function withinSourceActivityWindow(timestamp, referenceValue) {
  const value = Date.parse(timestamp);
  return (
    Number.isFinite(value) && referenceValue - value < SOURCE_ACTIVITY_WINDOW_MS
  );
}

/**
 * Whether List.am posted the apartment inside the window.
 *
 * List.am prints a local calendar time carrying no zone, and
 * `postingDateSortValue` reads those components as UTC, so a card can look a
 * few hours younger or older than it is. A day-wide window absorbs that offset
 * instead of guessing the source's zone. Cards whose displayed date cannot be
 * parsed fall back to the moment this installation first saw them.
 */
export function postedWithinSourceActivityWindow(apartment, referenceValue) {
  const posted = postingDateSortValue(apartment?.date);
  if (posted === null) {
    return withinSourceActivityWindow(apartment?.firstSeenAt, referenceValue);
  }
  return referenceValue - posted < SOURCE_ACTIVITY_WINDOW_MS;
}

/**
 * Whether List.am touched the apartment inside the window.
 *
 * Private delivery makes one temporal promise: a recipient is only ever sent
 * what List.am posted or changed within the last day. Both halves matter,
 * because a renewed ad keeps an old displayed date while its data moves, and a
 * freshly posted ad has never been updated at all.
 */
export function withinSourceActivity(apartment, referenceValue) {
  return (
    postedWithinSourceActivityWindow(apartment, referenceValue) ||
    withinSourceActivityWindow(apartment?.updatedAt, referenceValue)
  );
}

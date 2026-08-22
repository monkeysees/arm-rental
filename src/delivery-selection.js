import { apartmentMatchesFilters } from "./filters.js";
import { withinSourceActivity } from "./source-activity.js";

/**
 * The apartments a monitoring answer decides.
 *
 * Starting monitoring, restarting it after a pause, and accepting a widened
 * filter all pose the same question: what of the history this installation
 * already holds should reach the user now. The answer covers exactly the
 * matches List.am touched inside the source-activity window, newest first, so
 * both answers are bounded to the current day rather than to whatever the
 * database happens to hold. Everything the recipient already declined stays
 * declined, and everything already delivered stays delivered.
 */
export function selectableHistory(
  apartmentOrder,
  apartments,
  recipient,
  filters,
  referenceValue,
) {
  return apartmentOrder.filter((itemId) => {
    if (recipient.notified[itemId] || recipient.skipped[itemId]) return false;
    const apartment = apartments[itemId];
    return (
      Boolean(apartment) &&
      apartmentMatchesFilters(apartment, filters) &&
      withinSourceActivity(apartment, referenceValue)
    );
  });
}

/**
 * The rejected history a filter edit could release.
 *
 * A filtered apartment only starts matching because the user widened a filter
 * or List.am changed the card. Delivery releases the second case on its own,
 * so this is the set the user is asked about: matches that were rejected under
 * the previous filters and are still current. It is a subset of the history a
 * start answer covers, which keeps one definition of "the last day of
 * matching history" behind both questions.
 */
export function releasableHistory(
  apartmentOrder,
  apartments,
  recipient,
  filters,
  referenceValue,
) {
  return selectableHistory(
    apartmentOrder,
    apartments,
    recipient,
    filters,
    referenceValue,
  ).filter((itemId) => Boolean(recipient.filtered[itemId]));
}

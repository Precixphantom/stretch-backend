// Calendar dates are `YYYY-MM-DD` strings, as in the frontend's lib/dates.ts.
// The arithmetic works in UTC, so it never shifts across time zones.
// For today's date, see today.js.

const DAY_MS = 86_400_000;

const monthFormatter = new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: 'UTC' });

function toUTC(date) {
  const [year, month, day] = date.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

export function addDays(date, days) {
  return new Date(toUTC(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole calendar days from `from` to `to`; positive when `to` is later. */
export function daysBetween(from, to) {
  return Math.round((toUTC(to) - toUTC(from)) / DAY_MS);
}

/** Every date from `from` to `to`, inclusive. */
export function eachDay(from, to) {
  const count = daysBetween(from, to);
  return Array.from({ length: Math.max(0, count + 1) }, (_, index) => addDays(from, index));
}

export function laterOf(a, b) {
  return a > b ? a : b;
}

/** `2026-11-06` → `November` */
export function monthName(date) {
  return monthFormatter.format(new Date(toUTC(date)));
}

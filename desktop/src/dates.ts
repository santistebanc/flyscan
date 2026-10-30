/**
 * When a date carries its year.
 *
 * "Jan 6" is unambiguous as long as it can only mean the nearest Jan 6, so the
 * year is printed only once a date is more than 365 days from today, either
 * way. Crossing New Year alone does not earn it: a trip next January reads
 * "Jan 6", not "Jan 6, 2027".
 */

const DAY_MS = 86_400_000;

/** Whether the calendar day of `iso` ("2027-01-06", or a timestamp) is over a year from `now`. */
export function yearMatters(iso: string, now: number = Date.now()): boolean {
  const day = Date.parse(`${(iso || "").slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(day)) return false;
  const today = new Date(now);
  const todayNoon = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate(), 12);
  return Math.abs(Math.round((day - todayNoon) / DAY_MS)) > 365;
}

/** Spread into date formatting options: `{ year: "numeric" }` only when the year matters. */
export const yearIfFar = (iso: string, now?: number): { year?: "numeric" } =>
  yearMatters(iso, now) ? { year: "numeric" } : {};

/** "just now", "5 minutes ago", "yesterday": how long ago a price was quoted or changed. */
const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const DAY = 86_400;
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * DAY], ["month", 30 * DAY], ["week", 7 * DAY], ["day", DAY], ["hour", 3600], ["minute", 60],
];

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return "";
  const seconds = (now - at) / 1000;
  for (const [unit, size] of UNITS) if (seconds >= size) return format.format(-Math.floor(seconds / size), unit);
  return "just now";
}

/** The exact time, for a tooltip under the relative one. */
export function fullTime(iso: string | null | undefined): string {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
}

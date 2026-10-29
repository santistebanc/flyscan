import type { FlightRow } from "./api";

export type Rating = { level: number; description: string };
type Metric = "price" | "duration";
const labels = ["Excellent", "Good", "Average", "Below average", "Poor"];
/** Upper bounds of levels 1–4 as a multiple of the best value; beyond the last is Poor.
 * Duration bands are wider: an extra hour matters less on a long journey. */
const cuts: Record<Metric, number[]> = { price: [1.1, 1.25, 1.5, 2], duration: [1.15, 1.35, 1.6, 2] };
const wording: Record<Metric, { best: string; above: string }> = {
  price: { best: "The cheapest", above: "above the cheapest" },
  duration: { best: "The shortest", above: "longer than the shortest" },
};

/** Each value against the list's best (lowest), as a ratio: "20% above the cheapest"
 * reads the same for any fare, and one extreme outlier cannot squash every other
 * value into a single band the way a min–max scale does. */
export function rateValues(values: (number | null | undefined)[], metric: Metric) {
  const valid = new Set(values.filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0));
  const best = Math.min(...valid);
  return new Map([...valid].map((value) => {
    const ratio = value / best;
    const level = cuts[metric].findIndex((cut) => ratio <= cut) + 1 || 5;
    const where = value === best ? wording[metric].best
      : `${Math.max(1, Math.round((ratio - 1) * 100))}% ${wording[metric].above}`;
    return [value, { level, description: `${labels[level - 1]} · ${where} in this list` } satisfies Rating] as const;
  }));
}

/** Connections are judged on their own, not against the list: a shorter wait is
 * not always better, since under an hour leaves little margin for a late arrival. */
export function rateConnection(minutes: number): Rating {
  if (minutes < 60) return { level: 3, description: "Tight · Under 1h, little margin if the first flight is late" };
  if (minutes <= 180) return { level: 1, description: "Excellent · 1–3h, time to connect without a long wait" };
  if (minutes <= 360) return { level: 3, description: "Average · 3–6h wait" };
  if (minutes <= 720) return { level: 4, description: "Below average · 6–12h wait" };
  return { level: 5, description: "Poor · Over 12h wait" };
}

/** Use the displayed elapsed duration, which already accounts for airport time zones. */
export function durationMinutes(text: string): number | null {
  const match = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?$/i.exec(text.trim());
  if (!match) return null;
  const value = Number(match[1] || 0) * 60 + Number(match[2] || 0);
  return value > 0 && Number.isFinite(value) ? value : null;
}

/** Compare the entire filtered list, including rows outside the virtual viewport. */
export function flightRatings(rows: FlightRow[]) {
  const outbound = rows.map((row) => durationMinutes(row.duration));
  const inbound = rows.map((row) => durationMinutes(row.return_duration));
  const prices = rateValues(rows.map((row) => row.best?.price_base), "price");
  const out = rateValues(outbound, "duration");
  const back = rateValues(inbound, "duration");
  return new Map(rows.map((row, index) => [row.trip_key, {
    price: prices.get(row.best?.price_base ?? NaN),
    outbound: out.get(outbound[index] ?? NaN),
    inbound: back.get(inbound[index] ?? NaN),
  }]));
}

import type { FlightRow } from "./api";

export type Rating = { level: number; description: string };
type Metric = "price" | "duration" | "layover";
const labels = ["Excellent", "Good", "Average", "Below average", "Poor"];
const descriptions = {
  price: ["Lowest prices", "Lower prices", "Mid-range prices", "Higher prices", "Highest prices"],
  duration: ["Shortest journeys", "Shorter journeys", "Mid-range duration", "Longer journeys", "Longest journeys"],
  layover: ["Shortest connections", "Shorter connections", "Mid-range connections", "Longer connections", "Longest connections"],
};

/** Five equal bands across the full list's minimum and maximum; lower is better. */
export function rateValues(values: (number | null | undefined)[], metric: Metric) {
  const valid = new Set(values.filter((value): value is number =>
    typeof value === "number" && Number.isFinite(value) && (value > 0 || (metric === "layover" && value === 0))));
  let min = Infinity, max = -Infinity;
  for (const value of valid) { min = Math.min(min, value); max = Math.max(max, value); }
  return new Map([...valid].map((value) => {
    const level = min === max ? 3 : Math.min(5, Math.floor((value - min) / (max - min) * 5) + 1);
    const description = min === max
      ? `No ${metric} difference to compare in this list`
      : `${labels[level - 1]} · ${descriptions[metric][level - 1]} in this list`;
    return [value, { level, description } satisfies Rating] as const;
  }));
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

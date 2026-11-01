/** The figures the Trip view leads with, and where each sits among the flights listed. */
import type { FlightRow, Leg } from "./api";
import { durationMinutes } from "./flightRatings";
import { partsOf } from "./flightTimeline";

export type StatKey = "price" | "duration" | "layover" | "stops";
/** EUR for price, minutes for duration and layover; null when the seller did not say. */
export type TripStats = Record<StatKey, number | null>;
export type StatRange = { min: number; max: number };
export type StatRanges = Record<StatKey, StatRange | null>;
export const STAT_KEYS: StatKey[] = ["price", "duration", "layover", "stops"];

/** A direction's waiting time, or null when its connections are not described. */
function legLayover(leg: Leg): number | null {
  if (leg.stops === 0) return 0;
  if (!leg.segments?.length) return null;
  const waits = partsOf(leg).filter((part) => part.kind === "layover");
  return waits.some((part) => part.minutes === null) ? null : waits.reduce((sum, part) => sum + part.minutes!, 0);
}

/** Both directions together, as the Shortest sort counts them; any unknown direction makes the total unknown. */
function total(values: (number | null)[]): number | null {
  return values.some((value) => value === null) ? null : values.reduce<number>((sum, value) => sum + value!, 0);
}

export function tripStats(row: FlightRow): TripStats {
  const legs = [row.outbound, row.inbound].filter((leg): leg is Leg => Boolean(leg));
  return {
    price: row.best?.price_base ?? null,
    duration: total(legs.map((leg) => durationMinutes(leg.duration ?? ""))),
    layover: total(legs.map(legLayover)),
    stops: total(legs.map((leg) => leg.stops ?? null)),
  };
}

/** The lowest and highest of each figure over the rows, ignoring the unknown. */
export function statRanges(rows: FlightRow[]): StatRanges {
  const ranges = Object.fromEntries(STAT_KEYS.map((key) => [key, null])) as StatRanges;
  for (const row of rows) {
    const stats = tripStats(row);
    for (const key of STAT_KEYS) {
      const value = stats[key];
      if (value === null || !Number.isFinite(value)) continue;
      const range = ranges[key];
      ranges[key] = range ? { min: Math.min(range.min, value), max: Math.max(range.max, value) } : { min: value, max: value };
    }
  }
  return ranges;
}

/** Where a value sits in its range, 0 at the best (lowest) to 1 at the worst. */
export function rangeShare(value: number, range: StatRange): number {
  return range.max > range.min ? (value - range.min) / (range.max - range.min) : 0;
}

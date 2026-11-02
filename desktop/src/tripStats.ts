/** The figures the Trip view leads with, and how they spread over the trips listed. */
import type { FlightRow, Leg } from "./api";
import { durationMinutes } from "./flightRatings";
import { partsOf } from "./flightTimeline";

export type StatKey = "price" | "duration" | "layover" | "stops";
/** EUR for price, minutes for duration and layover; null when the seller did not say. */
export type TripStats = Record<StatKey, number | null>;

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

export interface Bin { from: number; to: number; count: number }
/**
 * How one figure spreads over the trips: counts in equal bins from the lowest
 * value. Fares and times have long tails — one €9,000 fare would squash every
 * other into the first bar — so the bins stop at the 95th percentile and the
 * last one also holds everything above it (`overflow`). Stops are counted
 * per whole number instead.
 */
export interface Distribution { bins: Bin[]; min: number; max: number; overflow: boolean; discrete: boolean; sorted: number[] }
/** Where a trip's value falls: its bin, its place along the axis (0–1), and the share of trips worse than it. */
export interface Placement { bin: number; position: number; worse: number; best: boolean }

const BINS = 24;
export function distribution(values: (number | null)[], discrete = false): Distribution | null {
  const sorted = values.filter((value): value is number => value !== null && Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const low = sorted[0]!, high = sorted[sorted.length - 1]!;
  if (discrete) {
    const bins = Array.from({ length: Math.round(high - low) + 1 }, (_, i) => ({ from: low + i, to: low + i, count: 0 }));
    for (const value of sorted) bins[Math.round(value - low)]!.count++;
    return { bins, min: low, max: high, overflow: false, discrete, sorted };
  }
  const p95 = sorted[Math.floor(0.95 * (sorted.length - 1))]!;
  const top = p95 > low ? p95 : high;
  if (top === low) return { bins: [{ from: low, to: low, count: sorted.length }], min: low, max: low, overflow: false, discrete, sorted };
  const width = (top - low) / BINS;
  const bins = Array.from({ length: BINS }, (_, i) => ({ from: low + i * width, to: low + (i + 1) * width, count: 0 }));
  for (const value of sorted) bins[binOf(value, low, width)]!.count++;
  return { bins, min: low, max: top, overflow: high > top, discrete, sorted };
}
const binOf = (value: number, low: number, width: number) => Math.min(BINS - 1, Math.max(0, Math.floor((value - low) / width)));

export function placeIn(dist: Distribution, value: number): Placement {
  const { bins, min, max, sorted } = dist;
  const bin = bins.length === 1 ? 0 : dist.discrete
    ? Math.min(bins.length - 1, Math.max(0, Math.round(value - min)))
    : binOf(value, min, (max - min) / bins.length);
  // A whole number sits in the middle of its bar; anything else along the axis, the tail at its end.
  const position = dist.discrete || bins.length === 1 ? (bin + 0.5) / bins.length
    : Math.min(1, Math.max(0, (value - min) / (max - min)));
  // Trips with a higher value than this one, by binary search over the sorted values.
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid]! <= value) lo = mid + 1; else hi = mid; }
  return { bin, position, worse: (sorted.length - lo) / sorted.length, best: value <= sorted[0]! };
}

export type TripDistributions = Record<StatKey, Distribution | null>;
/** All four figures over a list of trips; stops by whole number. */
export function tripDistributions(rows: FlightRow[]): TripDistributions {
  const stats = rows.map(tripStats);
  const of = (key: StatKey) => stats.map((stat) => stat[key]);
  return { price: distribution(of("price")), duration: distribution(of("duration")),
    layover: distribution(of("layover")), stops: distribution(of("stops"), true) };
}

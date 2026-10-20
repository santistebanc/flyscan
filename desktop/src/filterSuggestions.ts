import type { FlightRow, Leg } from "./api";
import type { JourneyTiming } from "./flightTimeline";
import { durationMinutes } from "./flightRatings";
import { clockMinutes, knownStops, longestLayover, matchesFlight, type FlightLimits } from "./flightFilters";

export interface ConnectionFilterOptions { stops: number[]; layoverMinutes: number[] }

/** Evaluate each facet with its own cap removed, retaining all other limits.
 * This lets users widen a cap without offering choices that yield no flights.
 */
export function connectionFilterOptions(
  rows: FlightRow[], limits: FlightLimits, displayedPrice: (row: FlightRow) => number | null,
): ConnectionFilterOptions {
  const withoutStops = { ...limits, maxStops: null };
  const withoutLayovers = { ...limits, maxLayoverMinutes: null };
  const stops = new Set<number>();
  let shortestConnection = Infinity, hasConnections = false;
  for (const row of rows) {
    const price = displayedPrice(row);
    if (matchesFlight(row, withoutStops, price)) {
      const out = knownStops(row.outbound?.stops ?? row.stops), back = knownStops(row.inbound?.stops);
      if (out !== null || back !== null) stops.add(Math.max(out ?? 0, back ?? 0));
    }
    if (matchesFlight(row, withoutLayovers, price)) {
      const longest = Math.max(longestLayover(row.outbound), longestLayover(row.inbound));
      shortestConnection = Math.min(shortestConnection, longest);
      hasConnections ||= longest > 0;
    }
  }
  return { stops: [...stops].sort((a, b) => a - b),
    layoverMinutes: hasConnections ? [360, 480, 720, 960].filter((cap) => cap >= shortestConnection) : [] };
}

export interface NumericRange { min: number; max: number }
interface DirectionRanges { depart: NumericRange | null; arrive: NumericRange | null }
export interface FilterRanges {
  priceEur: NumericRange | null;
  durationMinutes: NumericRange | null;
  layoverMinutes: NumericRange | null;
  limits: { priceEur: number[]; durationMinutes: number[]; layoverMinutes: number[] };
  stops: number[];
  outbound: DirectionRanges;
  inbound: DirectionRanges;
}

/** One scan of all loaded flights, independent of sorting and local limits.
 * A per-direction cap must admit both legs, so each trip contributes its
 * longest direction, connection, and stop count rather than a shorter leg.
 */
export function filterRanges(rows: FlightRow[], timings?: ReadonlyMap<Leg, JourneyTiming | null>): FilterRanges {
  const empty = (): NumericRange => ({ min: Infinity, max: -Infinity });
  const price = empty(), duration = empty(), layover = empty();
  const outbound = { depart: empty(), arrive: empty() }, inbound = { depart: empty(), arrive: empty() };
  const stops = new Set<number>();
  const prices = new Map<number, number>(), durations = new Map<number, number>(), connections = new Map<number, number>();
  const count = (values: Map<number, number>, value: number) => {
    if (Number.isFinite(value)) values.set(value, (values.get(value) ?? 0) + 1);
  };
  const connectionLength = (leg: Leg | null): number => {
    if (!leg) return 0;
    const timing = timings?.get(leg);
    if (!timing?.detailed) return longestLayover(leg);
    let longest = 0;
    for (const { part } of timing.parts) {
      if (part.kind === "layover" && part.minutes !== null) longest = Math.max(longest, part.minutes);
    }
    return longest;
  };
  const add = (range: NumericRange, value: number | null | undefined) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      range.min = Math.min(range.min, value); range.max = Math.max(range.max, value);
    }
  };
  for (const row of rows) {
    if (row.best?.price_base != null && row.best.price_base > 0) {
      add(price, row.best.price_base);
      count(prices, row.best.price_base);
    }
    const longestDirection = Math.max(durationMinutes(row.duration || row.outbound?.duration || "") ?? 0,
      durationMinutes(row.return_duration || row.inbound?.duration || "") ?? 0);
    if (longestDirection > 0) { add(duration, longestDirection); count(durations, longestDirection); }
    const connection = Math.max(connectionLength(row.outbound ?? null), connectionLength(row.inbound));
    if (connection > 0) add(layover, connection);
    count(connections, connection);
    const outStops = knownStops(row.outbound?.stops ?? row.stops), backStops = knownStops(row.inbound?.stops);
    if (outStops !== null || backStops !== null) stops.add(Math.max(outStops ?? 0, backStops ?? 0));
    add(outbound.depart, clockMinutes(row.outbound?.departure || row.departure));
    add(outbound.arrive, clockMinutes(row.outbound?.arrival || row.arrival));
    if (row.inbound || row.return_date) {
      add(inbound.depart, clockMinutes(row.inbound?.departure || row.return_departure));
      add(inbound.arrive, clockMinutes(row.inbound?.arrival || row.return_arrival));
    }
  }
  const finish = (range: NumericRange): NumericRange | null => range.min <= range.max ? range : null;
  return {
    priceEur: finish(price), durationMinutes: finish(duration), layoverMinutes: finish(layover),
    limits: { priceEur: distributionLimits(prices), durationMinutes: distributionLimits(durations),
      layoverMinutes: distributionLimits(connections) },
    stops: [...stops].sort((a, b) => a - b),
    outbound: { depart: finish(outbound.depart), arrive: finish(outbound.arrive) },
    inbound: { depart: finish(inbound.depart), arrive: finish(inbound.arrive) },
  };
}

/** Aim for groups covering a quarter, half, and three quarters of the results.
 * Count tied values together. Never suggest a cap admitting just one flight,
 * or all flights (already covered by Any/No limit). Histograms are built in the
 * existing dataset scan and only distinct values need sorting.
 */
function distributionLimits(histogram: ReadonlyMap<number, number>): number[] {
  let total = 0;
  for (const count of histogram.values()) total += count;
  if (total < 3) return [];
  const targets = [...new Set([0.25, 0.5, 0.75].map((fraction) =>
    Math.min(total - 1, Math.max(2, Math.ceil(total * fraction)))))];
  const limits = new Set<number>();
  let seen = 0, target = 0;
  for (const [value, count] of [...histogram].sort(([a], [b]) => a - b)) {
    seen += count;
    while (target < targets.length && seen >= targets[target]!) {
      if (value > 0 && seen < total) limits.add(value);
      target++;
    }
    if (target === targets.length) break;
  }
  return [...limits];
}

/** Round caps upward so a readable label retains its intended result group.
 * Drop duplicate and all-results caps after rounding or currency conversion.
 */
export function roundLimitPresets(values: number[], max: number | null | undefined, step = 1): number[] {
  if (max == null || !Number.isFinite(max)) return [];
  const unit = Number.isFinite(step) && step > 0 ? step : 1;
  return [...new Set(values.map((value) => Math.ceil(value / unit) * unit)
    .filter((value) => Number.isFinite(value) && value > 0 && value < max))];
}

/** Preserve the actual extremes; round only the middle suggestion for readability. */
export function rangePresets(range: NumericRange | null, step = 1): number[] {
  if (!range) return [];
  const middle = Math.max(range.min, Math.min(range.max, Math.round((range.min + range.max) / 2 / step) * step));
  return [...new Set([range.min, middle, range.max])];
}

/** Match the editor's half-hour steps without excluding every actual flight.
 * Departure minimums round down; arrival maximums round up.
 */
export function timePresets(range: NumericRange | null, minimum: boolean): number[] {
  if (!range) return [];
  const snap = (n: number) => (minimum ? Math.floor(n / 30) : Math.ceil(n / 30)) * 30;
  return rangePresets({ min: snap(range.min), max: snap(range.max) }, 30);
}

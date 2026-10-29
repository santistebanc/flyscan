import type { FlightRow, Leg } from "./api";
import type { JourneyTiming } from "./flightTimeline";
import { durationMinutes } from "./flightRatings";
import { knownStops, longestLayover, matchesFlight, withoutLimit, type FlightLimits } from "./flightFilters";

export interface ConnectionChoices { stops: number[]; layoverMinutes: number[] }
/** Choices for a limit set on both directions at once, and for each on its own. */
export interface ConnectionFilterOptions extends ConnectionChoices { outbound: ConnectionChoices; inbound: ConnectionChoices }

type Scope = "both" | "outbound" | "inbound";
const SCOPES: Record<Scope, readonly ("outbound" | "inbound")[]> = { both: ["outbound", "inbound"], outbound: ["outbound"], inbound: ["inbound"] };

/** Evaluate each facet with its own cap removed, retaining all other limits.
 * This lets users widen a cap without offering choices that yield no flights.
 * A cap set on both directions must admit both legs, so a trip counts its
 * larger value there; a cap on one direction counts that leg alone.
 */
export function connectionFilterOptions(
  rows: FlightRow[], limits: FlightLimits, displayedPrice: (row: FlightRow) => number | null,
): ConnectionFilterOptions {
  const choices = (scope: Scope): ConnectionChoices => {
    const directions = SCOPES[scope];
    const withoutStops = withoutLimit(limits, "maxStops", directions);
    const withoutLayovers = withoutLimit(limits, "maxLayoverMinutes", directions);
    const stops = new Set<number>();
    let shortestConnection = Infinity, hasConnections = false;
    for (const row of rows) {
      const price = displayedPrice(row);
      if (matchesFlight(row, withoutStops, price)) {
        const counted = directions.map((d) => knownStops(d === "outbound" ? row.outbound?.stops ?? row.stops : row.inbound?.stops))
          .filter((value): value is number => value !== null);
        if (counted.length) stops.add(Math.max(...counted));
      }
      if (matchesFlight(row, withoutLayovers, price)) {
        const longest = Math.max(...directions.map((d) => longestLayover(d === "outbound" ? row.outbound : row.inbound)));
        shortestConnection = Math.min(shortestConnection, longest);
        hasConnections ||= longest > 0;
      }
    }
    return { stops: [...stops].sort((a, b) => a - b),
      layoverMinutes: hasConnections ? [360, 480, 720, 960].filter((cap) => cap >= shortestConnection) : [] };
  };
  return { ...choices("both"), outbound: choices("outbound"), inbound: choices("inbound") };
}

export interface NumericRange { min: number; max: number }
/** Journey times of one direction alone, for a duration cap set on it by itself. */
export interface DurationSuggestions { durationMinutes: NumericRange | null; limits: number[] }
export interface FilterRanges {
  priceEur: NumericRange | null;
  durationMinutes: NumericRange | null;
  layoverMinutes: NumericRange | null;
  limits: { priceEur: number[]; durationMinutes: number[]; layoverMinutes: number[] };
  stops: number[];
  outbound: DurationSuggestions;
  inbound: DurationSuggestions;
}

/** One scan of all loaded flights, independent of sorting and local limits.
 * A per-direction cap must admit both legs, so each trip contributes its
 * longest direction, connection, and stop count rather than a shorter leg.
 */
export function filterRanges(rows: FlightRow[], timings?: ReadonlyMap<Leg, JourneyTiming | null>): FilterRanges {
  const empty = (): NumericRange => ({ min: Infinity, max: -Infinity });
  const price = empty(), duration = empty(), layover = empty();
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
  const each = { outbound: { range: empty(), counts: new Map<number, number>() },
    inbound: { range: empty(), counts: new Map<number, number>() } };
  for (const row of rows) {
    if (row.best?.price_base != null && row.best.price_base > 0) {
      add(price, row.best.price_base);
      count(prices, row.best.price_base);
    }
    const outboundMinutes = durationMinutes(row.duration || row.outbound?.duration || "") ?? 0;
    const inboundMinutes = durationMinutes(row.return_duration || row.inbound?.duration || "") ?? 0;
    for (const [direction, minutes] of [["outbound", outboundMinutes], ["inbound", inboundMinutes]] as const) {
      if (minutes > 0) { add(each[direction].range, minutes); count(each[direction].counts, minutes); }
    }
    const longestDirection = Math.max(outboundMinutes, inboundMinutes);
    if (longestDirection > 0) { add(duration, longestDirection); count(durations, longestDirection); }
    const connection = Math.max(connectionLength(row.outbound ?? null), connectionLength(row.inbound));
    if (connection > 0) add(layover, connection);
    count(connections, connection);
    const outStops = knownStops(row.outbound?.stops ?? row.stops), backStops = knownStops(row.inbound?.stops);
    if (outStops !== null || backStops !== null) stops.add(Math.max(outStops ?? 0, backStops ?? 0));
  }
  const finish = (range: NumericRange): NumericRange | null => range.min <= range.max ? range : null;
  return {
    priceEur: finish(price), durationMinutes: finish(duration), layoverMinutes: finish(layover),
    limits: { priceEur: distributionLimits(prices), durationMinutes: distributionLimits(durations),
      layoverMinutes: distributionLimits(connections) },
    stops: [...stops].sort((a, b) => a - b),
    outbound: { durationMinutes: finish(each.outbound.range), limits: distributionLimits(each.outbound.counts) },
    inbound: { durationMinutes: finish(each.inbound.range), limits: distributionLimits(each.inbound.counts) },
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

import type { FlightRow, Leg } from "./api";
import { durationMinutes } from "./flightRatings";
import { dayOffset, partsOf } from "./flightTimeline";

/** Minutes from local midnight. 1440 means the end of the day, after 23:59. */
export interface TimeWindow { from: number; to: number }
/** Only depart.from (earliest) and arrive.to (latest) constrain a direction.
 * arrive.to counts from midnight of the direction's departure day, so it can
 * fall on the next day or the one after; ANY_ARRIVAL means no limit.
 * Keep the stored window shape so older saved preferences can be normalized.
 */
export interface DirectionTimes { depart: TimeWindow; arrive: TimeWindow }

/** Everything one direction of a trip is held to. */
export interface DirectionLimits extends DirectionTimes {
  /** 0 means nonstop only. */
  maxStops: number | null;
  maxDurationMinutes: number | null;
  maxLayoverMinutes: number | null;
}

/** The filters that can differ between outbound and return. */
export type DirectionalFilter = "stops" | "duration" | "layovers" | "times";
export const DIRECTIONAL_FIELDS: Record<DirectionalFilter, readonly (keyof DirectionLimits)[]> = {
  stops: ["maxStops"], duration: ["maxDurationMinutes"], layovers: ["maxLayoverMinutes"], times: ["depart", "arrive"],
};

/**
 * Limits applied to the flights already on screen. Nothing here is sent to a
 * source. Price is stored in EUR, the unit the database uses, so switching the
 * display currency keeps the same cap.
 *
 * Each direction carries its own limits, and matching never looks further. A
 * filter that is not `separate` is edited for both directions at once, so its
 * return limits always equal the outbound ones.
 */
export interface ListFilters {
  maxPriceEur: number | null;
  excludeRepeatedAirports: boolean;
  outbound: DirectionLimits;
  inbound: DirectionLimits;
  separate: Record<DirectionalFilter, boolean>;
}

/** The same limits with the price cap already converted into display currency. */
export interface FlightLimits {
  maxPrice: number | null;
  excludeRepeatedAirports: boolean;
  outbound: DirectionLimits;
  inbound: DirectionLimits;
}

/** Latest arrival with no limit: past the last choice, 23:30 two days after departure. */
export const ANY_ARRIVAL = 3 * 1440;
const openDirection = (): DirectionLimits => ({
  depart: { from: 0, to: 1440 }, arrive: { from: 0, to: ANY_ARRIVAL },
  maxStops: null, maxDurationMinutes: null, maxLayoverMinutes: null,
});
const together = (): Record<DirectionalFilter, boolean> => ({ stops: false, duration: false, layovers: false, times: false });

export const OPEN_FILTERS: ListFilters = {
  maxPriceEur: null,
  excludeRepeatedAirports: false,
  outbound: openDirection(),
  inbound: openDirection(),
  separate: together(),
};

/**
 * 3: arrive.to counts from the departure day, and no limit moved from 1440 to ANY_ARRIVAL.
 * 4: stops, duration and layover limits moved into each direction.
 */
export const FILTERS_VERSION = 4;
const defaultDirection = (): DirectionLimits => ({ ...openDirection(), maxLayoverMinutes: 12 * 60 });
export const DEFAULT_FILTERS: ListFilters = {
  ...OPEN_FILTERS, excludeRepeatedAirports: true, outbound: defaultDirection(), inbound: defaultDirection(),
};

const directionActive = (limits: DirectionLimits) => limits.maxStops !== null || limits.maxDurationMinutes !== null
  || limits.maxLayoverMinutes !== null || limits.depart.from > 0 || limits.arrive.to < ANY_ARRIVAL;
const directionChanged = (limits: DirectionLimits, defaults: DirectionLimits) => limits.maxStops !== defaults.maxStops
  || limits.maxDurationMinutes !== defaults.maxDurationMinutes || limits.maxLayoverMinutes !== defaults.maxLayoverMinutes
  || limits.depart.from !== defaults.depart.from || limits.arrive.to !== defaults.arrive.to;

export function filtersActive(filters: ListFilters): boolean {
  return filters.maxPriceEur !== null || filters.excludeRepeatedAirports
    || directionActive(filters.outbound) || directionActive(filters.inbound);
}

/** Presentation and Reset compare against defaults, including relaxed limits. */
export function filtersChanged(filters: ListFilters): boolean {
  return filters.maxPriceEur !== DEFAULT_FILTERS.maxPriceEur
    || filters.excludeRepeatedAirports !== DEFAULT_FILTERS.excludeRepeatedAirports
    || directionChanged(filters.outbound, DEFAULT_FILTERS.outbound)
    || directionChanged(filters.inbound, DEFAULT_FILTERS.inbound);
}

/** Which directions an edit reaches: the one named when the filter is separate, else both. */
export function setDirectionLimits(filters: ListFilters, filter: DirectionalFilter,
  direction: "outbound" | "inbound", patch: Partial<DirectionLimits>): ListFilters {
  if (!filters.separate[filter]) {
    return { ...filters, outbound: { ...filters.outbound, ...patch }, inbound: { ...filters.inbound, ...patch } };
  }
  return { ...filters, [direction]: { ...filters[direction], ...patch } };
}

/** Joining the directions again gives the return the outbound limits, so nothing stays set unseen. */
export function setSeparate(filters: ListFilters, filter: DirectionalFilter, separate: boolean): ListFilters {
  const next = { ...filters, separate: { ...filters.separate, [filter]: separate } };
  if (separate) return next;
  const copied = Object.fromEntries(DIRECTIONAL_FIELDS[filter].map((field) => [field, filters.outbound[field]]));
  return { ...next, inbound: { ...filters.inbound, ...copied } };
}

/** The same limits with one filter lifted in both directions. */
export function withoutLimit(limits: FlightLimits, field: "maxStops" | "maxDurationMinutes" | "maxLayoverMinutes",
  directions: readonly ("outbound" | "inbound")[] = ["outbound", "inbound"]): FlightLimits {
  const next = { ...limits };
  for (const direction of directions) next[direction] = { ...limits[direction], [field]: null };
  return next;
}

export function clockMinutes(iso: string): number | null {
  const match = /T(\d{2}):(\d{2})/.exec(iso || "");
  if (!match) return null;
  const hour = Number(match[1]), minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/** Local airport time of day, which is what the row itself prints. */
function departsInTime(iso: string, earliest: number): boolean {
  if (earliest <= 0) return true;
  const minute = clockMinutes(iso);
  return minute !== null && minute >= earliest;
}

/** Local arrival time plus the days since departure, the "+1" the row prints. */
function arrivesInTime(departure: string, arrival: string, latest: number): boolean {
  if (latest >= ANY_ARRIVAL) return true;
  const minute = clockMinutes(arrival);
  return minute !== null && dayOffset(departure, arrival) * 1440 + minute <= latest;
}

export function longestLayover(leg: Leg | null): number {
  if (!leg) return 0;
  let longest = 0;
  for (const part of partsOf(leg)) {
    if (part.kind === "layover" && part.minutes !== null) longest = Math.max(longest, part.minutes);
  }
  return longest;
}

/** Adjacent arrival/departure at a connection is one visit. Airport changes
 * contribute both airports; each direction is checked independently.
 */
export function revisitsAirport(leg: Leg | null): boolean {
  const seen = new Set<string>();
  let previous = "";
  for (const segment of leg?.segments ?? []) {
    for (const value of [segment.origin, segment.destination]) {
      const airport = value?.trim().toUpperCase();
      if (!airport || airport === previous) continue;
      if (seen.has(airport)) return true;
      seen.add(airport);
      previous = airport;
    }
  }
  return false;
}

/** One direction of a row, as the limits read it; `null` when the trip has no such direction. */
interface DirectionFacts { leg: Leg | null; duration: string; stops: number | null | undefined; departure: string; arrival: string }
export function directionFacts(row: FlightRow, direction: "outbound" | "inbound"): DirectionFacts | null {
  if (direction === "outbound") {
    return { leg: row.outbound ?? null, duration: row.duration || "", stops: row.outbound?.stops ?? row.stops,
      departure: row.outbound?.departure || row.departure, arrival: row.outbound?.arrival || row.arrival };
  }
  if (!row.inbound && !row.return_date && !row.return_duration) return null;
  return { leg: row.inbound ?? null, duration: row.return_duration || row.inbound?.duration || "", stops: row.inbound?.stops,
    departure: row.inbound?.departure || row.return_departure, arrival: row.inbound?.arrival || row.return_arrival };
}

function directionFits(facts: DirectionFacts, limits: DirectionLimits): boolean {
  if (limits.maxDurationMinutes !== null) {
    const minutes = durationMinutes(facts.duration);
    if (minutes !== null && minutes > limits.maxDurationMinutes) return false;
  }
  if (limits.maxStops !== null) {
    const stops = knownStops(facts.stops);
    if (stops !== null && stops > limits.maxStops) return false;
  }
  if (limits.maxLayoverMinutes !== null && longestLayover(facts.leg) > limits.maxLayoverMinutes) return false;
  return departsInTime(facts.departure, limits.depart.from)
    && arrivesInTime(facts.departure, facts.arrival, limits.arrive.to);
}

/**
 * A row stays when every set limit holds. Each direction is held to its own
 * limits, so either an outbound or a return that runs long, stops too often,
 * or waits too long at one connection is enough to hide the trip.
 * A missing duration or an unmeasured connection is not treated as too long.
 * A narrowed time window does exclude a flight whose local clock is unknown.
 */
export function matchesFlight(row: FlightRow, limits: FlightLimits, displayedPrice: number | null): boolean {
  if (limits.excludeRepeatedAirports && (revisitsAirport(row.outbound) || revisitsAirport(row.inbound))) return false;
  if (limits.maxPrice !== null && (displayedPrice === null || displayedPrice > limits.maxPrice)) return false;
  const outbound = directionFacts(row, "outbound")!, inbound = directionFacts(row, "inbound");
  return directionFits(outbound, limits.outbound) && (inbound === null || directionFits(inbound, limits.inbound));
}

export function knownStops(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function wholeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function boundOf(value: unknown, key: "from" | "to", fallback: number, max: number): number {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const part = raw[key];
  const number = typeof part === "number" && Number.isFinite(part) ? part : fallback;
  return Math.min(max, Math.max(0, Math.round(number / 30) * 30));
}

const versionOf = (raw: Record<string, unknown>) => typeof raw.version === "number" ? raw.version : 0;

/** Older versions saved an unrestricted default on every load. Apply the new
 * default once, while preserving numeric limits and later No limit choices:
 * version 2 introduced that default, so a null saved since then is a choice.
 */
function layoverLimit(value: unknown, version: number): number | null {
  return version >= 2 && value === null ? null : positive(value) ?? 12 * 60;
}

/** `shared` holds the limits versions before 4 kept once for both directions. */
function directionOf(value: unknown, version: number, shared: Record<string, unknown>): DirectionLimits {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const limits = version >= 4 ? raw : shared;
  const arrive = boundOf(raw.arrive, "to", ANY_ARRIVAL, ANY_ARRIVAL);
  return {
    depart: { from: boundOf(raw.depart, "from", 0, 1440), to: 1440 },
    // Before version 3, 1440 was no limit; a limit below it is kept, now on the departure day.
    arrive: { from: 0, to: version >= 3 || arrive < 1440 ? arrive : ANY_ARRIVAL },
    maxStops: wholeNumber(limits.maxStops),
    maxDurationMinutes: positive(limits.maxDurationMinutes),
    maxLayoverMinutes: layoverLimit(limits.maxLayoverMinutes, version),
  };
}

const sameFields = (a: DirectionLimits, b: DirectionLimits, filter: DirectionalFilter) =>
  DIRECTIONAL_FIELDS[filter].every((field) => JSON.stringify(a[field]) === JSON.stringify(b[field]));

export function sanitizeFilters(value: unknown): ListFilters {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const version = versionOf(raw);
  const outbound = directionOf(raw.outbound, version, raw), inbound = directionOf(raw.inbound, version, raw);
  const stored = raw.separate && typeof raw.separate === "object" ? raw.separate as Record<string, unknown> : {};
  // A filter edited together has equal limits by construction, so unequal ones
  // are separate: that also covers times, which were per direction before version 4.
  const separate = Object.fromEntries((Object.keys(DIRECTIONAL_FIELDS) as DirectionalFilter[]).map((filter) =>
    [filter, stored[filter] === true || !sameFields(outbound, inbound, filter)])) as Record<DirectionalFilter, boolean>;
  return {
    maxPriceEur: positive(raw.maxPriceEur),
    excludeRepeatedAirports: typeof raw.excludeRepeatedAirports === "boolean"
      ? raw.excludeRepeatedAirports : DEFAULT_FILTERS.excludeRepeatedAirports,
    outbound, inbound, separate,
  };
}

export function formatClock(minutes: number): string {
  if (minutes >= 1440) return "24:00";
  const hour = Math.floor(minutes / 60), minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** An arrival limit as the row prints times: "06:00 +1" on the day after departure. */
export function formatArrival(minutes: number): string {
  const days = Math.floor(minutes / 1440);
  return days ? `${formatClock(minutes % 1440)} +${days}` : formatClock(minutes);
}

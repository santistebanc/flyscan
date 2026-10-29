import type { FlightRow, Leg } from "./api";
import { durationMinutes } from "./flightRatings";
import { partsOf } from "./flightTimeline";

/** Minutes from local midnight. 1440 means the end of the day, after 23:59. */
export interface TimeWindow { from: number; to: number }
/** Only depart.from (earliest) and arrive.to (latest) constrain a direction.
 * Keep the stored window shape so older saved preferences can be normalized.
 */
export interface DirectionTimes { depart: TimeWindow; arrive: TimeWindow }

/**
 * Limits applied to the flights already on screen. Nothing here is sent to a
 * source. Price is stored in EUR, the unit the database uses, so switching the
 * display currency keeps the same cap.
 */
export interface ListFilters {
  maxPriceEur: number | null;
  maxDurationMinutes: number | null;
  maxLayoverMinutes: number | null;
  /** 0 means nonstop only. */
  maxStops: number | null;
  excludeRepeatedAirports: boolean;
  outbound: DirectionTimes;
  inbound: DirectionTimes;
}

/** The same limits with the price cap already converted into display currency. */
export interface FlightLimits {
  maxPrice: number | null;
  maxDurationMinutes: number | null;
  maxLayoverMinutes: number | null;
  maxStops: number | null;
  excludeRepeatedAirports: boolean;
  outbound: DirectionTimes;
  inbound: DirectionTimes;
}

const FULL_DAY: TimeWindow = { from: 0, to: 1440 };
const openDirection = (): DirectionTimes => ({
  depart: { ...FULL_DAY }, arrive: { ...FULL_DAY },
});

export const OPEN_FILTERS: ListFilters = {
  maxPriceEur: null,
  maxDurationMinutes: null,
  maxLayoverMinutes: null,
  maxStops: null,
  excludeRepeatedAirports: false,
  outbound: openDirection(),
  inbound: openDirection(),
};

export const FILTERS_VERSION = 2;
export const DEFAULT_FILTERS: ListFilters = {
  ...OPEN_FILTERS, maxLayoverMinutes: 12 * 60, excludeRepeatedAirports: true,
};

export function filtersActive(filters: ListFilters): boolean {
  return filters.maxPriceEur !== null
    || filters.maxDurationMinutes !== null
    || filters.maxLayoverMinutes !== null
    || filters.maxStops !== null
    || filters.excludeRepeatedAirports
    || filters.outbound.depart.from > 0 || filters.outbound.arrive.to < 1440
    || filters.inbound.depart.from > 0 || filters.inbound.arrive.to < 1440;
}

/** Presentation and Reset compare against defaults, including relaxed limits. */
export function filtersChanged(filters: ListFilters): boolean {
  return filters.maxPriceEur !== DEFAULT_FILTERS.maxPriceEur
    || filters.maxDurationMinutes !== DEFAULT_FILTERS.maxDurationMinutes
    || filters.maxLayoverMinutes !== DEFAULT_FILTERS.maxLayoverMinutes
    || filters.maxStops !== DEFAULT_FILTERS.maxStops
    || filters.excludeRepeatedAirports !== DEFAULT_FILTERS.excludeRepeatedAirports
    || filters.outbound.depart.from > 0 || filters.outbound.arrive.to < 1440
    || filters.inbound.depart.from > 0 || filters.inbound.arrive.to < 1440;
}

export function clockMinutes(iso: string): number | null {
  const match = /T(\d{2}):(\d{2})/.exec(iso || "");
  if (!match) return null;
  const hour = Number(match[1]), minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/** Local airport time of day, which is what the row itself prints. */
function fits(iso: string, bound: number, minimum: boolean): boolean {
  if (minimum ? bound <= 0 : bound >= 1440) return true;
  const minute = clockMinutes(iso);
  return minute !== null && (minimum ? minute >= bound : minute <= bound);
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

/**
 * A row stays when every set limit holds.
 * Duration and stops are per direction, so either an outbound or a return that
 * runs long, or stops too often, is enough to hide the trip. Layover is the
 * longest single connection.
 * A missing duration or an unmeasured connection is not treated as too long.
 * A narrowed time window does exclude a flight whose local clock is unknown.
 */
export function matchesFlight(row: FlightRow, limits: FlightLimits, displayedPrice: number | null): boolean {
  if (limits.excludeRepeatedAirports && (revisitsAirport(row.outbound) || revisitsAirport(row.inbound))) return false;
  if (limits.maxPrice !== null && (displayedPrice === null || displayedPrice > limits.maxPrice)) return false;
  if (limits.maxDurationMinutes !== null) {
    const outbound = durationMinutes(row.duration || "");
    const inbound = durationMinutes(row.return_duration || row.inbound?.duration || "");
    if (outbound !== null && outbound > limits.maxDurationMinutes) return false;
    if ((row.inbound || row.return_duration) && inbound !== null && inbound > limits.maxDurationMinutes) return false;
  }
  if (limits.maxStops !== null) {
    const outboundStops = knownStops(row.outbound?.stops ?? row.stops);
    const inboundStops = knownStops(row.inbound?.stops);
    if (outboundStops !== null && outboundStops > limits.maxStops) return false;
    if (row.inbound && inboundStops !== null && inboundStops > limits.maxStops) return false;
  }
  if (limits.maxLayoverMinutes !== null) {
    const longest = Math.max(longestLayover(row.outbound), longestLayover(row.inbound));
    if (longest > limits.maxLayoverMinutes) return false;
  }
  const outboundDepart = row.outbound?.departure || row.departure;
  const outboundArrive = row.outbound?.arrival || row.arrival;
  if (!fits(outboundDepart, limits.outbound.depart.from, true) || !fits(outboundArrive, limits.outbound.arrive.to, false)) return false;
  if (row.inbound || row.return_date) {
    const returnDepart = row.inbound?.departure || row.return_departure;
    const returnArrive = row.inbound?.arrival || row.return_arrival;
    if (!fits(returnDepart, limits.inbound.depart.from, true) || !fits(returnArrive, limits.inbound.arrive.to, false)) return false;
  }
  return true;
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

function boundOf(value: unknown, key: "from" | "to", fallback: number): number {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const part = raw[key];
  const number = typeof part === "number" && Number.isFinite(part) ? part : fallback;
  return Math.min(1440, Math.max(0, Math.round(number / 30) * 30));
}

function directionOf(value: unknown): DirectionTimes {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    depart: { from: boundOf(raw.depart, "from", 0), to: 1440 },
    arrive: { from: 0, to: boundOf(raw.arrive, "to", 1440) },
  };
}

export function sanitizeFilters(value: unknown): ListFilters {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    maxPriceEur: positive(raw.maxPriceEur),
    maxDurationMinutes: positive(raw.maxDurationMinutes),
    // Older versions saved an unrestricted default on every load. Apply the new
    // default once, while preserving numeric limits and future No limit choices.
    maxLayoverMinutes: raw.version === FILTERS_VERSION && raw.maxLayoverMinutes === null
      ? null : positive(raw.maxLayoverMinutes) ?? DEFAULT_FILTERS.maxLayoverMinutes,
    maxStops: wholeNumber(raw.maxStops),
    excludeRepeatedAirports: typeof raw.excludeRepeatedAirports === "boolean"
      ? raw.excludeRepeatedAirports : DEFAULT_FILTERS.excludeRepeatedAirports,
    outbound: directionOf(raw.outbound),
    inbound: directionOf(raw.inbound),
  };
}

export function formatClock(minutes: number): string {
  if (minutes >= 1440) return "24:00";
  const hour = Math.floor(minutes / 60), minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

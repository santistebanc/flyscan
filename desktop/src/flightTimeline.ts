import type { FlightRow, Leg, Segment } from "./api";
import { durationMinutes } from "./flightRatings";

export const clock = (iso: string) => iso?.slice(11, 16) || "–";
export function dayOffset(from: string, to: string) {
  const a = wallStamp(from), b = wallStamp(to);
  return a === null || b === null ? 0 : Math.round((Math.floor(b / 1440) - Math.floor(a / 1440)));
}
export function elapsed(minutes: number | null) {
  if (minutes === null) return "Duration unavailable";
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return h ? `${h}h${m ? ` ${m}m` : ""}` : `${m}m`;
}
// Most appealing first, since airlineColors hands these out in order to the most
// frequent carriers; neighbours contrast so the top airlines never look alike.
const palette = ["#83baff", "#f28b82", "#72d3ba", "#ab9cff", "#e8b378", "#ec9bbd", "#a5d672", "#d892e8", "#d3d17e"];
/** Carrier identity colors, independent of price/duration quality colors.
 * `colors` comes from airlineColors; a carrier it doesn't cover falls back to a hash. */
export function airlineColor(code: string, colors?: ReadonlyMap<string, string>) {
  if (!code) return "#98a9c0";
  const assigned = colors?.get(code);
  if (assigned) return assigned;
  let hash = 0;
  for (const c of code) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length]!;
}
/** A distinct color for each carrier in these results, the most frequent first.
 * Hashing alone puts unrelated airlines on the same color; once the palette runs
 * out, the rarest carriers share colors through the hash. */
export function airlineColors(rows: FlightRow[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const row of rows) for (const leg of [row.outbound, row.inbound]) for (const segment of leg?.segments ?? [])
    if (segment.carrier) counts.set(segment.carrier, (counts.get(segment.carrier) ?? 0) + 1);
  const ranked = [...counts].sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
  return new Map(ranked.slice(0, palette.length).map(([code], i) => [code, palette[i]!]));
}

const isoPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i;
/** Airport wall time, independent of the viewer's timezone and DST. */
function wallStamp(iso: string): number | null {
  const match = isoPattern.exec(iso || "");
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number);
  if (hour! > 23 || minute! > 59) return null;
  const stamp = Date.UTC(year!, month! - 1, day!, hour!, minute!);
  const date = new Date(stamp);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month! - 1 || date.getUTCDate() !== day) return null;
  return stamp / 60000;
}
function departureMinute(iso: string) {
  const wall = wallStamp(iso);
  return wall === null ? null : ((wall % 1440) + 1440) % 1440;
}
function layoverMinutes(before: Segment, after: Segment): number | null {
  if (before.destination !== after.origin) return null;
  const a = wallStamp(before.arrival), b = wallStamp(after.departure);
  if (a === null || b === null) return null;
  const aOffset = isoPattern.exec(before.arrival)?.[6], bOffset = isoPattern.exec(after.departure)?.[6];
  // A lone explicit offset cannot be compared safely with a local timestamp.
  if (Boolean(aOffset) !== Boolean(bOffset)) return null;
  const minutes = aOffset && bOffset
    ? (Date.parse(after.departure) - Date.parse(before.arrival)) / 60000 : b - a;
  return Number.isFinite(minutes) && minutes >= 0 ? Math.round(minutes) : null;
}

export type TimelinePart = { kind: "flight"; segment: Segment; minutes: number | null; detailed: boolean }
  | { kind: "layover"; before: Segment; after: Segment; minutes: number | null; transfer: boolean; fromJourneyDuration?: boolean };
export type PositionedPart = { part: TimelinePart; start: number; end: number };
export interface JourneyTiming {
  start: number;
  /** End from the reported journey duration; detailed parts can disagree. */
  end: number;
  detailed: boolean;
  /** Reported total minus the sum of known segment and layover durations. */
  durationDifference: number;
  parts: PositionedPart[];
}
/** `arrivalShift`: minutes the destination clock runs ahead of the departure clock. */
export interface TimelineScale { min: number; max: number; airports: string[]; arrivalShift?: number }
export type TimelineMode = "days" | "shared";
export const TIMELINE_MODE_KEY = "flight-scraper.timeline-mode";
export function normalizeTimelineMode(value: unknown): TimelineMode {
  return value === "shared" ? "shared" : "days";
}
const DAY = 1440, DAY_START = 5 * 60;
/** Whole-day ranges from 05:00 to 05:00: the last 05:00 at or before departure on
 * the departure clock, to the first 05:00 at or after arrival on the destination
 * clock, because the axis reads each airport's clock beyond the journey.
 * A row's range depends only on its own timing, so streaming, sorting and
 * filtering other flights cannot change its scale. Keep detailed arrivals
 * in range even when the source's reported total is shorter.
 */
export function timelineScaleFor(timing: JourneyTiming | null | undefined, shared: TimelineScale | null,
  mode: TimelineMode): TimelineScale | null {
  if (!timing) return null;
  if (mode === "shared" && !shared) return null;
  const end = Math.max(timing.end, timing.parts[timing.parts.length - 1]?.end ?? timing.end);
  const min = mode === "shared" ? shared!.min : timing.start;
  const max = mode === "shared" ? shared!.max : end;
  const start = Math.floor((min - DAY_START) / DAY) * DAY + DAY_START;
  // A shared scale spans many destinations, so it has no single arrival clock.
  const shift = mode === "shared" ? 0 : arrivalShift(timing);
  // At least one whole day by the clocks, even when a westbound arrival reads earlier.
  const finish = Math.max(start + DAY, Math.ceil((max + shift - DAY_START) / DAY) * DAY + DAY_START);
  return { min: start, max: finish - shift,
    airports: shared?.airports ?? [], ...(shift ? { arrivalShift: shift } : {}) };
}
/** Destination clock minus departure clock at the same moment, from the airport timestamps. */
function arrivalShift(timing: JourneyTiming): number {
  const first = timing.parts[0], last = timing.parts[timing.parts.length - 1];
  if (first?.part.kind !== "flight" || last?.part.kind !== "flight") return 0;
  const departed = wallStamp(first.part.segment.departure), arrived = wallStamp(last.part.segment.arrival);
  return departed === null || arrived === null ? 0 : (arrived - departed) - (last.end - first.start);
}
export function timelineScaleLabel(scale: TimelineScale, mode: TimelineMode): string {
  if (mode === "shared") return "Shared scale";
  return `${scaleClock(scale.min)} – ${scaleClock(scale.max + (scale.arrivalShift ?? 0))}`;
}
export interface FlightTimelines {
  outbound: TimelineScale | null;
  inbound: TimelineScale | null;
  journeys: Map<Leg, JourneyTiming | null>;
}
function summaryPart(leg: Leg): TimelinePart {
  return { kind: "flight", detailed: false, minutes: durationMinutes(leg.duration), segment: {
    origin: leg.origin_airport, destination: leg.destination_airport,
    departure: leg.departure, arrival: leg.arrival, duration: leg.duration,
    carrier: "", carrier_name: leg.airlines, flight_number: leg.flight_numbers,
  } };
}
export function partsOf(leg: Leg): TimelinePart[] {
  if (!leg.segments?.length) return [summaryPart(leg)];
  const parts = leg.segments.flatMap((segment, i): TimelinePart[] => {
    const flight: TimelinePart = { kind: "flight", segment, minutes: durationMinutes(segment.duration), detailed: true };
    const before = leg.segments[i - 1];
    return before ? [{ kind: "layover", before, after: segment,
      minutes: layoverMinutes(before, segment), transfer: before.destination !== segment.origin }, flight] : [flight];
  });
  // Different airports can have different time zones. If the airport change
  // is the sole unknown interval, its elapsed connection time is determined by
  // the source's total minus every known flight and same-airport wait. This
  // includes waiting and ground travel; it is not a driving-time estimate.
  const unknown = parts.filter((part) => part.minutes === null);
  const gap = unknown[0];
  const total = durationMinutes(leg.duration ?? "");
  if (unknown.length === 1 && gap?.kind === "layover" && gap.transfer && total !== null) {
    const remaining = total - parts.reduce((sum, part) => sum + (part.minutes ?? 0), 0);
    if (remaining >= 0) {
      gap.minutes = remaining;
      gap.fromJourneyDuration = true;
    }
  }
  return parts;
}

/** Anchor local departure on day zero, then advance with elapsed travel time.
 * Destination-local arrival clocks must never be subtracted from origin clocks.
 * Missing segment times need a summary; a conflicting total keeps the known
 * segments visible with an explicit discrepancy instead of calling them missing.
 */
export function journeyTiming(leg: Leg): JourneyTiming | null {
  const start = departureMinute(leg.departure);
  if (start === null) return null;
  const parts = partsOf(leg);
  const complete = parts.every((p) => p.minutes !== null);
  const sum = parts.reduce((n, p) => n + (p.minutes ?? 0), 0);
  const reportedDuration = durationMinutes(leg.duration);
  const duration = reportedDuration ?? (complete && sum > 0 ? sum : null);
  if (duration === null) return null;
  const detailed = complete && parts.every((p) => p.kind !== "flight" || p.detailed);
  const drawn = detailed ? parts : [summaryPart(leg)];
  let cursor = start;
  return { start, end: start + duration, detailed,
    durationDifference: detailed && reportedDuration !== null ? reportedDuration - sum : 0,
    parts: drawn.map((part) => {
    const from = cursor;
    cursor += detailed ? part.minutes! : duration;
    return { part, start: from, end: cursor };
  }) };
}

/** One pass over the entire filtered data, including virtualized/offscreen rows.
 * Call in useMemo keyed by results, never by sort order or favorite state.
 */
export function flightTimelines(rows: FlightRow[], cached?: ReadonlyMap<Leg, JourneyTiming | null>): FlightTimelines {
  const journeys = new Map<Leg, JourneyTiming | null>();
  const bounds = { outbound: { min: Infinity, max: -Infinity, airports: new Set<string>() },
    inbound: { min: Infinity, max: -Infinity, airports: new Set<string>() } };
  for (const row of rows) {
    for (const direction of ["outbound", "inbound"] as const) {
      const leg = row[direction];
      if (!leg) continue;
      const timing = journeys.has(leg) ? journeys.get(leg)!
        : cached?.has(leg) ? cached.get(leg)! : journeyTiming(leg);
      journeys.set(leg, timing);
      if (!timing) continue;
      const b = bounds[direction];
      b.min = Math.min(b.min, timing.start);
      // Keep both reported and detailed arrivals in range when source data conflicts.
      b.max = Math.max(b.max, timing.end, timing.parts[timing.parts.length - 1]?.end ?? timing.end);
      if (leg.origin_airport) b.airports.add(leg.origin_airport);
    }
  }
  const scale = (b: typeof bounds.outbound): TimelineScale | null =>
    b.min < b.max ? { min: b.min, max: b.max, airports: [...b.airports].sort() } : null;
  return { outbound: scale(bounds.outbound), inbound: scale(bounds.inbound), journeys };
}
/** Timeline positions where the traveller's local clock reads 00:00, with the day that begins.
 * Each part runs from one local wall time to another (departure to arrival
 * for a flight, arrival to next departure for a wait); the clock is
 * interpolated linearly in between, so a flight crossing time zones reaches
 * midnight part-way through as its clock shifts. A clock that stands still or
 * runs backwards, as on some westbound flights, passes no midnight.
 * With a shared scale, empty space continues the origin clock before departure
 * and the destination clock after arrival.
 */
export interface Midnight { at: number; label: string }
const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export interface LocalClockSpan { from: number; to: number; start: number; end: number }
/** Airport-local clocks mapped onto elapsed positions, including empty range space.
 * In-flight clocks interpolate between airport timestamps, not geographic zone borders.
 */
export function localClockSpans(timing: JourneyTiming, scale?: Pick<TimelineScale, "min" | "max">): LocalClockSpan[] {
  const spans: LocalClockSpan[] = [];
  const append = (from: number | null, to: number | null, start: number, end: number) => {
    if (from !== null && to !== null && end > start) spans.push({ from, to, start, end });
  };
  const fromWall = (part: TimelinePart) => wallStamp(part.kind === "flight" ? part.segment.departure : part.before.arrival);
  const toWall = (part: TimelinePart) => wallStamp(part.kind === "flight" ? part.segment.arrival : part.after.departure);
  const range = scale && Number.isFinite(scale.min) && Number.isFinite(scale.max) && scale.max > scale.min ? scale : undefined;
  const first = timing.parts[0], last = timing.parts[timing.parts.length - 1];
  // Outside the journey the local clock continues at its endpoint airport.
  // Anchor to the actual local departure/arrival, then advance by elapsed
  // minutes; destination clocks must not be treated as origin-clock times.
  if (range && first && range.min < first.start) {
    const wall = fromWall(first.part);
    if (wall !== null) append(wall + range.min - first.start, wall, range.min, first.start);
  }
  for (const { part, start, end } of timing.parts) {
    append(fromWall(part), toWall(part), start, end);
  }
  if (range && last && range.max > last.end) {
    const wall = toWall(last.part);
    if (wall !== null) append(wall, wall + range.max - last.end, last.end, range.max);
  }
  return spans;
}
export function localMidnights(timing: JourneyTiming, scale?: Pick<TimelineScale, "min" | "max">): Midnight[] {
  const marks = localClockSpans(timing, scale).flatMap(({ from, to, start, end }) => {
    const found: Midnight[] = [];
    if (to <= from) return found;
    for (let midnight = Math.floor(from / 1440) * 1440 + 1440; midnight <= to; midnight += 1440) {
      const day = new Date(midnight * 60000);
      found.push({ at: start + (midnight - from) / (to - from) * (end - start),
        label: `${monthNames[day.getUTCMonth()]} ${day.getUTCDate()}` });
    }
    return found;
  });
  return scale ? marks.filter(({ at }) => at > scale.min && at <= scale.max) : marks;
}
/** A wait whose local clock passes 00:00, by the rule `localMidnights` draws. */
export function isOvernight(part: TimelinePart): boolean {
  if (part.kind !== "layover") return false;
  const from = wallStamp(part.before.arrival), to = wallStamp(part.after.departure);
  return from !== null && to !== null && Math.floor(to / 1440) > Math.floor(from / 1440);
}
export function timingNote(timing: JourneyTiming): string | undefined {
  if (!timing.durationDifference) return undefined;
  const detailedDuration = timing.parts[timing.parts.length - 1]!.end - timing.start;
  return `Source timing differs by ${elapsed(Math.abs(timing.durationDifference))}: reported total ${elapsed(timing.end - timing.start)}, flight and layover details ${elapsed(detailedDuration)}. Segment positions use the detailed durations.`;
}
export function percent(minute: number, scale: TimelineScale) {
  return (minute - scale.min) / (scale.max - scale.min) * 100;
}
export function scaleClock(minute: number) {
  const day = Math.floor(minute / 1440), within = ((minute % 1440) + 1440) % 1440;
  const h = Math.floor(within / 60), m = Math.round(within % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}${day ? ` ${day > 0 ? "+" : ""}${day}` : ""}`;
}
export function partLabel(part: TimelinePart) {
  if (part.kind === "flight") {
    const s = part.segment;
    return `${part.detailed ? "Flight" : "Journey"} ${s.origin} to ${s.destination}, ${s.carrier_name || s.carrier || "Airline unavailable"}${s.flight_number ? ` ${s.flight_number}` : ""}, ${s.duration || "duration unavailable"}${part.detailed ? "" : ", segment times unavailable"}`;
  }
  return `${part.transfer ? `Airport transfer ${part.before.destination} to ${part.after.origin}` : `Layover in ${part.before.destination}`}, ${elapsed(part.minutes)}`;
}

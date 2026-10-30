import type { FlightRow, Leg, Segment } from "./api";
import { durationMinutes } from "./flightRatings";
import { yearIfFar } from "./dates";

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
const palette = ["#83baff", "#f28b82", "#72d3ba", "#ab9cff", "#e8b378", "#ec9bbd", "#a5d672", "#d892e8", "#d3d17e"];
/** Carrier identity colors, independent of price/duration quality colors.
 * A hash of the code, so an airline has the same color in every search. */
export function airlineColor(code: string) {
  if (!code) return "#98a9c0";
  let hash = 0;
  for (const c of code) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length]!;
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
/** The local wall clock where a part starts and where it ends. */
const fromWall = (part: TimelinePart) => wallStamp(part.kind === "flight" ? part.segment.departure : part.before.arrival);
const toWall = (part: TimelinePart) => wallStamp(part.kind === "flight" ? part.segment.arrival : part.after.departure);
export interface LocalClockSpan { from: number; to: number; start: number; end: number }
/** Airport-local clocks mapped onto elapsed positions, including empty range space.
 * In-flight clocks interpolate between airport timestamps, not geographic zone borders.
 */
export function localClockSpans(timing: JourneyTiming, scale?: Pick<TimelineScale, "min" | "max">): LocalClockSpan[] {
  const spans: LocalClockSpan[] = [];
  const append = (from: number | null, to: number | null, start: number, end: number) => {
    if (from !== null && to !== null && end > start) spans.push({ from, to, start, end });
  };
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
/** `side`: before the earliest departure, or after the latest arrival. */
export interface FilteredSpan { start: number; end: number; side: "before" | "after" }
/**
 * Where a row's timeline falls outside the time filters, which is how they
 * judge a flight: before the earliest departure on the departure's local
 * clock, and after the latest arrival on the destination's clock.
 * Both are minutes from local midnight on the departure day, so a latest
 * arrival past 1440 lands on a later day; null means no limit.
 */
export function filteredOutSpans(timing: JourneyTiming, scale: Pick<TimelineScale, "min" | "max">,
  earliestDeparture: number | null, latestArrival: number | null): FilteredSpan[] {
  const spans: FilteredSpan[] = [];
  const first = timing.parts[0], last = timing.parts[timing.parts.length - 1];
  const departed = first ? fromWall(first.part) : null;
  if (departed === null) return spans;
  const departureDay = Math.floor(departed / DAY) * DAY;
  if (earliestDeparture !== null) {
    const at = Math.min(first!.start + departureDay + earliestDeparture - departed, scale.max);
    if (at > scale.min) spans.push({ start: scale.min, end: at, side: "before" });
  }
  const arrived = last ? toWall(last.part) : null;
  if (latestArrival !== null && arrived !== null) {
    const at = Math.max(last!.end + departureDay + latestArrival - arrived, scale.min);
    if (at < scale.max) spans.push({ start: at, end: scale.max, side: "after" });
  }
  return spans;
}
export interface HourMark { at: number; hour: number }
/** Pixels six hours need before all three marks show: below it they crowd the strip. */
const QUARTER_DAY_ROOM = 100;
/** Pixels twelve hours need for noon alone. */
const HALF_DAY_ROOM = 60;
/** Room the label needs after its tick: closer to the end it would spill out of the timeline. */
const HOUR_LABEL_ROOM = 34;
/**
 * 06:00, 12:00 and 18:00 on the same local clocks as `localMidnights`. All three
 * when six hours of timeline are roomy, only noon when twelve hours are, else none.
 */
export function localHourMarks(timing: JourneyTiming, scale: Pick<TimelineScale, "min" | "max">, pxPerMinute: number): HourMark[] {
  const hours = pxPerMinute * 360 >= QUARTER_DAY_ROOM ? [6, 12, 18] : pxPerMinute * 720 >= HALF_DAY_ROOM ? [12] : [];
  if (!hours.length) return [];
  return localClockSpans(timing, scale).flatMap(({ from, to, start, end }) => {
    const found: HourMark[] = [];
    if (to <= from) return found;
    for (let clock = Math.floor(from / 360) * 360 + 360; clock <= to; clock += 360) {
      const hour = (clock % DAY) / 60;
      if (hours.includes(hour)) found.push({ at: start + (clock - from) / (to - from) * (end - start), hour });
    }
    return found;
  }).filter(({ at }) => at > scale.min && (scale.max - at) * pxPerMinute >= HOUR_LABEL_ROOM);
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
/** "Mon, Dec 21": the airport's own calendar day, whatever the viewer's timezone. */
export function wallDay(iso: string) {
  const stamp = wallStamp(iso);
  return stamp === null ? "" : new Date(stamp * 60000)
    .toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", ...yearIfFar(iso), timeZone: "UTC" });
}
const later = (from: string, to: string) => { const days = dayOffset(from, to); return days > 0 ? ` (+${days})` : ""; };
/** A timeline bar's tooltip: what it is, then when, one fact per line. */
export function partLabel(part: TimelinePart) {
  if (part.kind === "flight") {
    const s = part.segment;
    const day = wallDay(s.departure);
    return [
      `${part.detailed ? "Flight" : "Journey"} ${s.origin} to ${s.destination}, ${s.carrier_name || s.carrier || "Airline unavailable"}${s.flight_number ? ` ${s.flight_number}` : ""}`,
      day && `Departs ${day}, ${clock(s.departure)} · arrives ${clock(s.arrival)}${later(s.departure, s.arrival)}`,
      `${s.duration || "Duration unavailable"}${part.detailed ? "" : ", segment times unavailable"}`,
    ].filter(Boolean).join("\n");
  }
  const { before, after } = part;
  return [
    `${part.transfer ? `Airport transfer ${before.destination} to ${after.origin}` : `Layover in ${before.destination}`}, ${elapsed(part.minutes)}`,
    wallDay(before.arrival) && `Arrives ${clock(before.arrival)} · departs ${clock(after.departure)}${later(before.arrival, after.departure)}`,
  ].filter(Boolean).join("\n");
}

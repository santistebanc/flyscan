/**
 * Flights and prices typed in by hand: the drafts behind the form, turning
 * them into what the sidecar stores, and finding stored flights they describe.
 *
 * Framework-free so it can be tested on its own. There is no airport time-zone
 * table, so clock times alone give a flight's duration wrong by the zone
 * difference; the form asks for the flight time and only guesses it from them.
 */

import type { FlightRow, Leg, Offer, Segment } from "./api";

export const MANUAL_SOURCE = "manual";
export const MANUAL_LABEL = "Added by you";

/** One flight as the person types it. Dates and times are local to each airport. */
export interface FlightDraft {
  flight_number: string;
  origin: string;
  destination: string;
  /** "2026-12-21" — the day it leaves. */
  date: string;
  /** "16:40" */
  departs: string;
  arrives: string;
  /** Days between leaving and landing, or null to work it out from the clock. */
  arrivesAfter: number | null;
  /** As typed: "2h 05m", "125", "2:05". Empty to use the guess. */
  duration: string;
}

export const emptyDraft = (date = ""): FlightDraft => ({
  flight_number: "", origin: "", destination: "", date, departs: "", arrives: "", arrivesAfter: null, duration: "",
});

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const pad = (n: number) => String(n).padStart(2, "0");
const minutesOf = (time: string) => {
  const match = TIME.exec(time.trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};
const addDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const normalTime = (time: string) => {
  const minutes = minutesOf(time);
  return minutes === null ? "" : `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
};

/** "2h 05m", "2h", "45m", "2:05" or a bare number of minutes. */
export function parseDuration(text: string): number | null {
  const value = text.trim().toLowerCase();
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value) || null;
  const clock = /^(\d+):([0-5]\d)$/.exec(value);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]) || null;
  const parts = /^(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?$/.exec(value);
  if (!parts || (!parts[1] && !parts[2])) return null;
  return Number(parts[1] || 0) * 60 + Number(parts[2] || 0) || null;
}

/** Days from leaving to landing: as pasted or stored, else worked out from the times. */
export function arrivalOffset(draft: FlightDraft): number {
  if (draft.arrivesAfter !== null) return draft.arrivesAfter;
  const leave = minutesOf(draft.departs), land = minutesOf(draft.arrives);
  if (leave === null || land === null) return 0;
  // With a flight time, the landing day is where leaving plus flying puts the
  // landing clock, to the nearest day: zone differences stay under twelve hours.
  const flying = parseDuration(draft.duration);
  if (flying !== null) return Math.max(0, Math.round((leave + flying - land) / 1440));
  return land < leave ? 1 : 0;
}

export const departureStamp = (draft: FlightDraft) =>
  draft.date && minutesOf(draft.departs) !== null ? `${draft.date}T${normalTime(draft.departs)}` : "";

export function arrivalStamp(draft: FlightDraft) {
  if (!draft.date || minutesOf(draft.arrives) === null) return "";
  return `${addDays(draft.date, arrivalOffset(draft))}T${normalTime(draft.arrives)}`;
}

/** The clock difference, which is the flight time only within one time zone. */
export function clockMinutes(draft: FlightDraft): number | null {
  const leave = departureStamp(draft), land = arrivalStamp(draft);
  if (!leave || !land) return null;
  const minutes = (Date.parse(`${land}:00Z`) - Date.parse(`${leave}:00Z`)) / 60_000;
  return minutes > 0 ? minutes : null;
}

/**
 * A line pasted from a booking page: "FR146 BER 16:40 → STN 17:45". The
 * flight number is optional; the arrow can be anything that is not a letter.
 */
export function parseFlightLine(text: string): Partial<FlightDraft> | null {
  const match = /^\s*(?:([A-Z0-9]{2}\s?\d{1,4}[A-Z]?)\s+)?([A-Z]{3})\s+(\d{1,2}:\d{2})[^A-Z0-9]+([A-Z]{3})\s+(\d{1,2}:\d{2})(?:\s*\+(\d))?\s*$/i
    .exec(text);
  if (!match) return null;
  return {
    ...(match[1] ? { flight_number: match[1].replace(/\s+/g, "").toUpperCase() } : {}),
    origin: match[2]!.toUpperCase(), departs: normalTime(match[3]!),
    destination: match[4]!.toUpperCase(), arrives: normalTime(match[5]!),
    ...(match[6] ? { arrivesAfter: Number(match[6]) } : {}),
  };
}

/** What the sidecar is sent for one flight, or the reason it cannot be sent yet. */
export function draftProblem(draft: FlightDraft, label: string): string | null {
  if (!/^[A-Z]{3}$/i.test(draft.origin.trim())) return `${label}: enter the three-letter code it leaves from.`;
  if (!/^[A-Z]{3}$/i.test(draft.destination.trim())) return `${label}: enter the three-letter code it lands at.`;
  if (!draft.date) return `${label}: enter the day it leaves.`;
  if (!departureStamp(draft)) return `${label}: enter when it leaves, like 16:40.`;
  if (!arrivalStamp(draft)) return `${label}: enter when it lands, like 17:45.`;
  if (draft.duration.trim() && parseDuration(draft.duration) === null) return `${label}: write the flight time like 2h 05m.`;
  if (!draft.duration.trim() && clockMinutes(draft) === null) return `${label}: it lands before it leaves. Enter the flight time.`;
  return null;
}

export function segmentPayload(draft: FlightDraft, carrierNames: ReadonlyMap<string, string> = new Map()) {
  const number = draft.flight_number.replace(/\s+/g, "").toUpperCase();
  return {
    flight_number: number,
    carrier_name: carrierNames.get(number.slice(0, 2)) ?? "",
    origin: draft.origin.trim().toUpperCase(),
    destination: draft.destination.trim().toUpperCase(),
    departure: departureStamp(draft),
    arrival: arrivalStamp(draft),
    duration_minutes: parseDuration(draft.duration) ?? clockMinutes(draft),
  };
}

/** Airline names already seen in the list, by IATA code, so a typed FR146 reads "Ryanair". */
export function carrierNames(rows: readonly FlightRow[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const row of rows) {
    for (const leg of [row.outbound, row.inbound]) {
      for (const segment of leg?.segments ?? []) {
        const code = segment.carrier || segment.flight_number.slice(0, 2);
        if (code && segment.carrier_name && segment.carrier_name !== code && !names.has(code)) {
          names.set(code.toUpperCase(), segment.carrier_name);
        }
      }
    }
  }
  return names;
}

const prettyMinutes = (minutes: number) => `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`;

/** One stored flight as a draft, to fill the form with. */
export function segmentDraft(segment: Segment): FlightDraft {
  const date = segment.departure.slice(0, 10), landed = segment.arrival.slice(0, 10);
  const after = date && landed ? Math.round((Date.parse(`${landed}T12:00:00Z`) - Date.parse(`${date}T12:00:00Z`)) / 86_400_000) : 0;
  const minutes = parseDuration(segment.duration || "");
  return {
    flight_number: segment.flight_number, origin: segment.origin, destination: segment.destination,
    date, departs: segment.departure.slice(11, 16), arrives: segment.arrival.slice(11, 16),
    arrivesAfter: after, duration: minutes ? prettyMinutes(minutes) : "",
  };
}

/** A stored leg as drafts, to start from when editing or adjusting a flight. */
export function legDrafts(leg: Leg | null): FlightDraft[] {
  if (!leg) return [];
  const segments: Segment[] = leg.segments?.length ? leg.segments : [{
    carrier: "", carrier_name: leg.airlines, flight_number: leg.flight_numbers.split(",")[0] ?? "",
    origin: leg.origin_airport, destination: leg.destination_airport,
    departure: leg.departure, arrival: leg.arrival, duration: leg.duration,
  }];
  return segments.map(segmentDraft);
}

/**
 * The drafts as a leg the timeline can draw. Flight times as given, or as the
 * clock guesses them; connections from the clock, which is right for them.
 */
export function draftLeg(drafts: FlightDraft[], carriers: ReadonlyMap<string, string> = new Map()): Leg | null {
  const usable = drafts.filter((draft) => draftProblem(draft, "") === null);
  if (!usable.length) return null;
  let total = 0;
  const segments: Segment[] = usable.map((draft, index) => {
    const sent = segmentPayload(draft, carriers);
    const minutes = sent.duration_minutes ?? 0;
    const before = usable[index - 1];
    if (before) total += Math.max(0, (Date.parse(`${sent.departure}:00Z`) - Date.parse(`${arrivalStamp(before)}:00Z`)) / 60_000);
    total += minutes;
    return { carrier: sent.flight_number.slice(0, 2), carrier_name: sent.carrier_name || sent.flight_number.slice(0, 2),
      flight_number: sent.flight_number, origin: sent.origin, destination: sent.destination,
      departure: sent.departure, arrival: sent.arrival, duration: minutes ? prettyMinutes(minutes) : "" };
  });
  const airlines = [...new Set(segments.map((segment) => segment.carrier_name).filter(Boolean))];
  return {
    origin_airport: segments[0]!.origin, destination_airport: segments.at(-1)!.destination,
    departure: segments[0]!.departure, arrival: segments.at(-1)!.arrival, duration: prettyMinutes(total),
    stops: segments.length - 1, airlines: airlines.join(", "),
    flight_numbers: segments.map((segment) => segment.flight_number).filter(Boolean).join(","), segments,
  };
}

// -- finding stored flights a draft describes ---------------------------------

export type Direction = "outbound" | "inbound";
export type DraftField = "flight_number" | "origin" | "destination" | "date" | "departs" | "arrives" | "duration";

const squash = (text: string) => text.replace(/\s+/g, "").toUpperCase();
/** Worth filtering on: something other than the date, which alone matches a whole day. */
export const typed = (draft: FlightDraft) =>
  Boolean(draft.flight_number.trim() || airportCode(draft.origin) || airportCode(draft.destination) || draft.departs || draft.arrives);
/** An airport only counts once it is a code; "Lon" on its way to "LHR" filters nothing. */
const airportCode = (text: string) => /^[A-Z]{3}$/i.test(text.trim()) ? text.trim().toUpperCase() : "";
/** The number without its airline: EC7336 and U27336 are one easyJet flight. */
const digits = (number: string) =>
  // A two-character airline code can hold a digit (U2), so it goes first.
  /(\d+)[A-Z]?$/.exec(squash(number).replace(/^[A-Z0-9]{2}(?=\d)/, ""))?.[1]?.replace(/^0+/, "") ?? "";
/** Matches while it is still being typed: "FR1" and "146" both find FR146. */
function numberFits(stored: string, typing: string): boolean {
  const have = squash(stored), want = squash(typing);
  if (have.startsWith(want)) return true;
  if (/^\d+$/.test(want)) return digits(have).startsWith(want.replace(/^0+/, ""));
  return digits(want) !== "" && digits(have) === digits(want);
}

function fits(segment: Segment, draft: FlightDraft, skip?: DraftField): boolean {
  const origin = airportCode(draft.origin), destination = airportCode(draft.destination);
  if (skip !== "flight_number" && draft.flight_number.trim() && !numberFits(segment.flight_number, draft.flight_number)) return false;
  if (skip !== "origin" && origin && segment.origin.toUpperCase() !== origin) return false;
  if (skip !== "destination" && destination && segment.destination.toUpperCase() !== destination) return false;
  if (skip !== "date" && draft.date && segment.departure.slice(0, 10) !== draft.date) return false;
  if (skip !== "departs" && draft.departs && segment.departure.slice(11, 16) !== normalTime(draft.departs)) return false;
  if (skip !== "arrives" && draft.arrives && segment.arrival.slice(11, 16) !== normalTime(draft.arrives)) return false;
  return true;
}

const segmentsOf = (leg: Leg | null | undefined) => leg?.segments ?? [];
/** The flights already added for a direction are the start of this leg. */
const startsWith = (leg: Leg | null | undefined, drafts: FlightDraft[]) =>
  drafts.length <= segmentsOf(leg).length && drafts.every((draft, index) => fits(segmentsOf(leg)[index]!, draft));
const cheapest = (a: FlightRow, b: FlightRow) => (a.best?.price_base ?? Infinity) - (b.best?.price_base ?? Infinity);

/** What is being built: the flights added so far each way, and the one in the form. */
export interface Building {
  outbound: FlightDraft[];
  inbound: FlightDraft[];
  roundTrip: boolean;
  direction: Direction;
  form: FlightDraft;
}

interface Candidate { segment: Segment; row: FlightRow; index: number }

/** Stored flights that could be the next one in the direction being built. */
function candidates(rows: readonly FlightRow[], building: Building): Candidate[] {
  const added = building[building.direction];
  const found: Candidate[] = [];
  for (const row of rows) {
    const leg = row[building.direction];
    if (!startsWith(leg, added)) continue;
    segmentsOf(leg).forEach((segment, index) => {
      if (index >= added.length) found.push({ segment, row, index });
    });
  }
  return found;
}

/**
 * Stored itineraries that fit everything so far: both directions' added
 * flights from the start, and the form at any later flight, so a typed
 * number finds the trips that use it anywhere.
 */
export function itinerarySuggestions(rows: readonly FlightRow[], building: Building, limit = 40): FlightRow[] {
  const other: Direction = building.direction === "outbound" ? "inbound" : "outbound";
  const added = building[building.direction];
  return rows.filter((row) => {
    if (Boolean(row.inbound) !== building.roundTrip) return false;
    if (!startsWith(row[other], building.roundTrip || other === "outbound" ? building[other] : [])) return false;
    const leg = row[building.direction];
    if (!startsWith(leg, added)) return false;
    return !typed(building.form) && !building.form.date
      || segmentsOf(leg).some((segment, index) => index >= added.length && fits(segment, building.form));
  }).sort(cheapest).slice(0, limit);
}

export interface LegSuggestion {
  key: string;
  segment: Segment;
  /** Itineraries that fly it, cheapest first. */
  rows: FlightRow[];
  /** It comes straight after the flights already added, not later in a trip. */
  next: boolean;
}

export const segmentKey = (segment: Segment) =>
  [squash(segment.flight_number), segment.origin, segment.destination, segment.departure.slice(0, 16), segment.arrival.slice(0, 16)].join("|");

/** Single flights that fit the form, each with the itineraries that include it. */
export function legSuggestions(rows: readonly FlightRow[], building: Building, limit = 40): LegSuggestion[] {
  const added = building[building.direction].length;
  const legs = new Map<string, LegSuggestion>();
  for (const { segment, row, index } of candidates(rows, building)) {
    if (!fits(segment, building.form)) continue;
    const key = segmentKey(segment);
    const leg = legs.get(key) ?? { key, segment, rows: [], next: false };
    if (!leg.rows.includes(row)) leg.rows.push(row);
    leg.next ||= index === added;
    legs.set(key, leg);
  }
  return [...legs.values()]
    .map((leg) => ({ ...leg, rows: leg.rows.sort(cheapest) }))
    .sort((a, b) => Number(b.next) - Number(a.next) || a.segment.departure.localeCompare(b.segment.departure))
    .slice(0, limit);
}

export interface FieldOption { value: string; hint: string; count: number }

/**
 * The likeliest values for one field: what the stored flights that fit every
 * *other* field say, most common first.
 */
export function fieldOptions(rows: readonly FlightRow[], building: Building, field: DraftField, limit = 6): FieldOption[] {
  const counts = new Map<string, FieldOption>();
  for (const { segment } of candidates(rows, building)) {
    if (!fits(segment, building.form, field)) continue;
    const [value, hint] = field === "flight_number" ? [squash(segment.flight_number), segment.carrier_name]
      : field === "origin" ? [segment.origin, `to ${segment.destination}`]
      : field === "destination" ? [segment.destination, `from ${segment.origin}`]
      : field === "date" ? [segment.departure.slice(0, 10), ""]
      : field === "departs" ? [segment.departure.slice(11, 16), `${squash(segment.flight_number)} ${segment.origin}`]
      : field === "arrives" ? [segment.arrival.slice(11, 16), `${squash(segment.flight_number)} ${segment.destination}`]
      : [segment.duration ? prettyMinutes(parseDuration(segment.duration) ?? 0) : "", squash(segment.flight_number)];
    if (!value) continue;
    const option = counts.get(value) ?? { value, hint: hint ?? "", count: 0 };
    option.count += 1;
    counts.set(value, option);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)).slice(0, limit);
}

/**
 * The day a flight leaves, which nobody has to type: the trip's date for the
 * first flight each way; for a connection, the day the flight before lands,
 * or the next when its clock time is earlier than that landing.
 */
export function departureDay(before: FlightDraft | undefined, departs: string, tripDate: string): string {
  if (!before) return tripDate;
  const landed = arrivalStamp(before);
  if (!landed) return before.date || tripDate;
  const leave = minutesOf(departs), land = minutesOf(landed.slice(11, 16));
  return leave !== null && land !== null && leave < land ? addDays(landed.slice(0, 10), 1) : landed.slice(0, 10);
}

/** One direction's flights, each on the day it follows from the trip's date and the flight before. */
export function datedLegs(drafts: FlightDraft[], tripDate: string): FlightDraft[] {
  const out: FlightDraft[] = [];
  for (const draft of drafts) out.push({ ...draft, date: departureDay(out[out.length - 1], draft.departs, tripDate) });
  return out;
}

/** The form for the next flight: from where the last one landed, on the day it landed. */
export function nextDraft(added: FlightDraft[], fallback: Partial<FlightDraft> = {}): FlightDraft {
  const last = added[added.length - 1];
  if (!last) return { ...emptyDraft(), ...fallback };
  return { ...emptyDraft(arrivalStamp(last).slice(0, 10) || last.date), origin: last.destination };
}

// -- showing an entry ---------------------------------------------------------

export const isManual = (offer: Pick<Offer, "source">) => offer.source === MANUAL_SOURCE;

/** "3 days ago", "today": when a hand-entered price was added. */
export function addedAgo(iso: string | undefined, now = Date.now()): string {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return "";
  const days = Math.floor((now - at) / 86_400_000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "a month ago" : `${months} months ago`;
}

/** True when nobody but the person sells this flight, so its details are theirs to change. */
export const onlyManual = (row: FlightRow) => row.offers.length > 0 && row.offers.every(isManual);

import { createHash } from "node:crypto";

import type { Cabin } from "../../shared/contracts.js";
export type { Cabin } from "../../shared/contracts.js";
export const cabins: Cabin[] = [
  "economy",
  "premiumeconomy",
  "business",
  "first",
];
export interface Query {
  origin: string;
  destination: string;
  depart: string;
  ret: string | null;
  adults: number;
  children: number;
  infants: number;
  cabin: Cabin;
  currency: string;
}
export interface Segment {
  carrier: string;
  carrier_name: string;
  flight_number: string;
  origin: string;
  destination: string;
  departure: string;
  arrival: string;
  duration_minutes: number | null;
  operating_carrier: string;
  operating_carrier_name: string;
  operating_flight_number: string;
}
export interface Leg {
  origin_airport: string;
  destination_airport: string;
  departure: string;
  arrival: string;
  duration_minutes: number | null;
  stops: number | null;
  airlines: string;
  flight_numbers: string;
  segments: Segment[];
}
export interface Itinerary {
  query: Query;
  outbound: Leg;
  inbound: Leg | null;
}
export interface Offer {
  itinerary: Itinerary;
  source: string;
  price: number;
  currency: string;
  agent: string;
  deeplink: string;
  source_id: string;
  price_eur: number | null;
  seen_at: string;
}
export interface SourceResult {
  source: string;
  offers: Offer[];
  error: string;
  elapsed: number;
  url: string;
  found?: number;
}
export type Progress = (event: string, data: Record<string, unknown>) => void;
export const now = () =>
  new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
/** Preserve Python's two-decimal, ties-to-even rounding for stored prices. */
export function roundMoney(value: number): number {
  const scaled = value * 100;
  return Number.isInteger(value * 8) && Math.abs(scaled % 1) === 0.5
    ? (Math.round(scaled / 2) * 2) / 100
    : Number(value.toFixed(2));
}
export function segment(data: Partial<Segment> = {}): Segment {
  return {
    carrier: "",
    carrier_name: "",
    flight_number: "",
    origin: "",
    destination: "",
    departure: "",
    arrival: "",
    duration_minutes: null,
    operating_carrier: "",
    operating_carrier_name: "",
    operating_flight_number: "",
    ...data,
  };
}
export function leg(data: Partial<Leg> = {}): Leg {
  return {
    origin_airport: "",
    destination_airport: "",
    departure: "",
    arrival: "",
    duration_minutes: null,
    stops: null,
    airlines: "",
    flight_numbers: "",
    segments: [],
    ...data,
  };
}
export function offer(
  data: Pick<Offer, "itinerary" | "source" | "price" | "currency"> &
    Partial<Offer>,
): Offer {
  return {
    agent: "",
    deeplink: "",
    source_id: "",
    price_eur: null,
    seen_at: now(),
    ...data,
  };
}
export function query(
  data: Partial<Query> & Pick<Query, "origin" | "destination" | "depart">,
): Query {
  const q: Query = {
    origin: data.origin,
    destination: data.destination,
    depart: data.depart,
    ret: data.ret ?? null,
    adults: data.adults ?? 1,
    children: data.children ?? 0,
    infants: data.infants ?? 0,
    cabin: data.cabin ?? "economy",
    currency: data.currency ?? "EUR",
  };
  q.origin = q.origin.trim().toUpperCase();
  q.destination = q.destination.trim().toUpperCase();
  q.currency = q.currency.trim().toUpperCase();
  if (!cabins.includes(q.cabin))
    throw new Error(
      `cabin must be one of ${cabins.join(", ")}, got '${q.cabin}'`,
    );
  if (
    ![q.adults, q.children, q.infants].every(Number.isInteger) ||
    q.adults < 1 ||
    q.children < 0 ||
    q.infants < 0
  )
    throw new Error("invalid passenger counts");
  q.depart = isoDate(q.depart);
  if (q.ret) q.ret = isoDate(q.ret);
  if (q.ret && q.ret < q.depart)
    throw new Error("return date is before the departure date");
  return q;
}
export function isoDate(value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
  )
    throw new Error(`invalid date: ${value}`);
  return value;
}
export function addDays(day: string, count: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + count * 86400000)
    .toISOString()
    .slice(0, 10);
}
export function parseDate(value: string): string {
  const v = value.trim();
  const today = new Date();
  const local = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  if (v.toLowerCase() === "today") return local;
  if (v.toLowerCase() === "tomorrow") return addDays(local, 1);
  if (/^\+\d+$/.test(v)) return addDays(local, Number(v));
  let m = v.match(/^(\d{4})[-/](\d{2})[-/](\d{2})$/);
  if (m) return isoDate(`${m[1]}-${m[2]}-${m[3]}`);
  m = v.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
  if (m) return isoDate(`${m[3]}-${m[2]}-${m[1]}`);
  throw new Error(`could not read '${v}' as a date (try YYYY-MM-DD or +14)`);
}
export function dateRange(start: string, end = start): string[] {
  isoDate(start);
  isoDate(end);
  if (end < start) throw new Error("end date is before start date");
  const dates: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) dates.push(d);
  return dates;
}
export function tripPairs(
  start: string,
  end?: string | null,
  ret?: string | null,
  retEnd?: string | null,
): [string, string | null][] {
  return dateRange(start, end || start).flatMap<[string, string | null]>((d) =>
    ret
      ? dateRange(ret, retEnd || ret)
          .filter((r) => r >= d)
          .map((r) => [d, r] as [string, string | null])
      : [[d, null]],
  );
}
export const sha1 = (value: string) =>
  createHash("sha1").update(value).digest("hex");
export const stableJSON = (obj: Record<string, unknown>) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
export const queryKey = (source: string, q: Query) =>
  sha1(stableJSON({ source, ...q }));
const minute = (v: string) => (v ? v.slice(0, 16) : "?");
export function tripKey(i: Itinerary): string {
  const q = i.query,
    o = i.outbound,
    b = i.inbound;
  const parts = [
    q.depart,
    q.origin,
    q.destination,
    o.origin_airport,
    o.destination_airport,
    minute(o.departure),
    minute(o.arrival),
    String(o.stops ?? "?"),
  ];
  if (q.ret) parts.push(q.ret);
  if (b)
    parts.push(minute(b.departure), minute(b.arrival), String(b.stops ?? "?"));
  for (const [direction, l] of [
    ["outbound", o],
    ["inbound", b],
  ] as const)
    if (l && l.segments.length > 1) {
      parts.push(direction);
      for (const s of l.segments)
        parts.push(
          s.origin,
          s.destination,
          minute(s.departure),
          minute(s.arrival),
        );
    }
  return sha1(parts.join("|"));
}
export function parseDuration(text: string): number | null {
  if (!text) return null;
  const compact = text.trim().match(/^(\d+)\s*h(?:r)?\s+(\d+)\s*$/i);
  if (compact) return +compact[1] * 60 + +compact[2];
  const m = text
    .trim()
    .match(/(?:(\d+)\s*d)?\s*(?:(\d+)\s*h(?:r|ours?)?)?\s*(?:(\d+)\s*m)?/i);
  const n = m ? +(m[1] || 0) * 1440 + +(m[2] || 0) * 60 + +(m[3] || 0) : 0;
  return n || null;
}
export const prettyDuration = (minutes: number | null) =>
  minutes === null
    ? ""
    : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
export function legDuration(departure: string, arrival: string): number | null {
  const stamp = (s: string) =>
    Date.parse(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(s)
        ? s + "Z"
        : s,
    );
  const d = stamp(departure),
    a = stamp(arrival);
  return Number.isFinite(d) && Number.isFinite(a)
    ? Math.floor((a - d) / 60000)
    : null;
}
export function belongsTo(
  job: Record<string, any>,
  selection: Record<string, any> | null,
): boolean {
  if (!selection) return false;
  if (
    job.route?.toUpperCase() !==
    `${String(selection.origin || "").trim()}-${String(selection.destination || "").trim()}`.toUpperCase()
  )
    return false;
  if (
    !selection.start ||
    job.depart < selection.start ||
    job.depart > (selection.end || selection.start)
  )
    return false;
  if (
    selection.ret
      ? !job.ret ||
        job.ret < selection.ret ||
        job.ret > (selection.ret_end || selection.ret)
      : !!job.ret
  )
    return false;
  const defaults: Record<string, unknown> = {
    adults: 1,
    children: 0,
    infants: 0,
    cabin: "economy",
    currency: "EUR",
  };
  return ["adults", "children", "infants", "cabin", "currency"].every((k) => {
    const normalize = (v: unknown) =>
      ["adults", "children", "infants"].includes(k)
        ? Number(v || defaults[k])
        : k === "currency"
          ? String(v || defaults[k]).toUpperCase()
          : v || defaults[k];
    return normalize(job[k]) === normalize(selection[k]);
  });
}

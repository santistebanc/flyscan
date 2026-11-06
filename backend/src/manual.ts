import {
  leg,
  legDuration,
  query,
  segment,
  type Itinerary,
  type Leg,
  type Query,
  type Segment,
} from "./models.js";
import type { Data } from "./support.js";
export function manualQuery(p: Data): Query {
  if (!p.origin || !p.destination)
    throw new Error("the search's origin and destination are required");
  return query({
    origin: String(p.origin),
    destination: String(p.destination),
    depart: String(p.depart || "").slice(0, 10),
    ret: p.ret ? String(p.ret).slice(0, 10) : null,
    adults: Number(p.adults || 1),
    children: Number(p.children || 0),
    infants: Number(p.infants || 0),
    cabin: p.cabin || "economy",
  });
}
function stamp(value: unknown, label: string): string {
  const v = String(value || "").trim();
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ||
    !Number.isFinite(Date.parse(v))
  )
    throw new Error(`${label} needs a date and time`);
  return v.slice(0, 16);
}
function manualSegment(d: Data, label: string): Segment {
  if (!d || typeof d !== "object")
    throw new Error(`${label} must be a flight object`);
  const number = String(d.flight_number || "")
      .replace(/\s/g, "")
      .toUpperCase(),
    origin = String(d.origin || "")
      .trim()
      .toUpperCase(),
    destination = String(d.destination || "")
      .trim()
      .toUpperCase();
  if (!/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(destination))
    throw new Error(`${label}: the airports need three-letter codes`);
  const departure = stamp(d.departure, label + ": the departure"),
    arrival = stamp(d.arrival, label + ": the arrival"),
    minutes =
      d.duration_minutes == null || d.duration_minutes === ""
        ? legDuration(departure, arrival)
        : Number(d.duration_minutes);
  if (!Number.isFinite(minutes) || minutes! <= 0)
    throw new Error(
      `${label}: the arrival is before the departure; enter the flight time`,
    );
  const carrier = number.match(/^([A-Z0-9]{2})\s*(\d{1,4}[A-Z]?)$/)?.[1] || "";
  return segment({
    carrier,
    carrier_name: String(d.carrier_name || "").trim() || carrier,
    flight_number: number,
    origin,
    destination,
    departure,
    arrival,
    duration_minutes: minutes,
  });
}
function manualLeg(segments: Segment[]): Leg {
  let duration = 0;
  segments.forEach((s, i) => {
    duration += s.duration_minutes || 0;
    if (i) {
      const wait = legDuration(segments[i - 1].arrival, s.departure);
      if (wait === null || wait < 0)
        throw new Error(`flight ${i + 1} leaves before flight ${i} lands`);
      duration += wait;
    }
  });
  return leg({
    origin_airport: segments[0].origin,
    destination_airport: segments.at(-1)!.destination,
    departure: segments[0].departure,
    arrival: segments.at(-1)!.arrival,
    duration_minutes: duration,
    stops: segments.length - 1,
    airlines: [
      ...new Set(segments.map((s) => s.carrier_name).filter(Boolean)),
    ].join(", "),
    flight_numbers: segments
      .map((s) => s.flight_number)
      .filter(Boolean)
      .join(","),
    segments,
  });
}
export function manualItinerary(p: Data): Itinerary {
  if (!Array.isArray(p.outbound) || !p.outbound.length)
    throw new Error("the outbound needs at least one flight");
  if (p.inbound && !Array.isArray(p.inbound))
    throw new Error("the return must be a list of flights");
  const out = manualLeg(
      p.outbound.map((s: Data, i: number) =>
        manualSegment(s, `Outbound flight ${i + 1}`),
      ),
    ),
    back = p.inbound?.length
      ? manualLeg(
          p.inbound.map((s: Data, i: number) =>
            manualSegment(s, `Return flight ${i + 1}`),
          ),
        )
      : null;
  return {
    query: manualQuery({
      ...p,
      depart: out.departure.slice(0, 10),
      ret: back?.departure.slice(0, 10),
    }),
    outbound: out,
    inbound: back,
  };
}

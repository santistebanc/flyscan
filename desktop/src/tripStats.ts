/** The figures the Trip view leads with. */
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

import { rateConnection, type Rating } from "./flightRatings";
import { partsOf, type FlightTimelines } from "./flightTimeline";

/** Ratings for every connection length in the filtered results, both directions. */
export function connectionRatings(timelines: FlightTimelines) {
  const values = [...timelines.journeys].flatMap(([leg, timing]) =>
    (timing?.detailed ? timing.parts.map(({ part }) => part) : partsOf(leg))
      .flatMap((part) => part.kind === "layover" ? [part.minutes] : []));
  return new Map(values.filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0)
    .map((value) => [value, rateConnection(value)] as [number, Rating]));
}

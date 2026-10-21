import { rateValues } from "./flightRatings";
import { partsOf, type FlightTimelines } from "./flightTimeline";

/** Compare connections across both directions of all filtered results. */
export function connectionRatings(timelines: FlightTimelines) {
  const values = [...timelines.journeys].flatMap(([leg, timing]) =>
    (timing?.detailed ? timing.parts.map(({ part }) => part) : partsOf(leg))
      .flatMap((part) => part.kind === "layover" ? [part.minutes] : []));
  return rateValues(values, "layover");
}

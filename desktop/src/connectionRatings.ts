import type { FlightRow } from "./api";
import { rateConnection, type Rating } from "./flightRatings";
import { partsOf, type FlightTimelines } from "./flightTimeline";

export interface ConnectionRatings {
  outbound: ReadonlyMap<number, Rating>;
  inbound: ReadonlyMap<number, Rating>;
}

/** Fixed connection bands, collected separately for each direction. */
export function connectionRatings(rows: FlightRow[], timelines: FlightTimelines): ConnectionRatings {
  const rate = (direction: "outbound" | "inbound") => {
    const values = rows.flatMap((row) => {
      const leg = row[direction];
      if (!leg) return [];
      const timing = timelines.journeys.get(leg);
      return (timing?.detailed ? timing.parts.map(({ part }) => part) : partsOf(leg))
        .flatMap((part) => part.kind === "layover" && part.minutes !== null
          && Number.isFinite(part.minutes) && part.minutes >= 0 ? [part.minutes] : []);
    });
    return new Map(values.map((minutes) => [minutes, rateConnection(minutes)]));
  };
  return { outbound: rate("outbound"), inbound: rate("inbound") };
}

import type { FlightRow } from "./api";
import { durationMinutes } from "./flightRatings";

export type SortKey = "best" | "price" | "depart" | "duration";
export const DEFAULT_SORT: SortKey = "best";
export const SORT_LABELS: Record<SortKey, string> = {
  best: "Best",
  price: "Cheapest",
  depart: "Departure",
  duration: "Shortest",
};

const priceOf = (row: FlightRow) => row.best?.price_base ?? Infinity;

function travelMinutes(row: FlightRow): number | null {
  const outbound = durationMinutes(row.duration || "");
  if (outbound === null) return null;
  if (!row.return_date && !row.inbound) return outbound;
  const inbound = durationMinutes(row.return_duration || "");
  return inbound === null ? null : outbound + inbound;
}

/** Reorder the full filtered dataset without querying sources or mutating rows. */
export function sortFlightRows(rows: FlightRow[], key: SortKey): FlightRow[] {
  if (key === "best") {
    // Price × elapsed travel time gives price and time equal proportional
    // weight. Include both directions and layovers, using source durations
    // rather than subtracting local airport clocks. No min/max scan is needed;
    // outliers and currency conversion cannot change existing relative ranks.
    const ranked = rows.map((row) => {
      const price = priceOf(row);
      const duration = travelMinutes(row);
      return { row, price, duration: duration ?? Infinity,
        score: Number.isFinite(price) && price > 0 && duration !== null ? price * duration : Infinity };
    });
    ranked.sort((a, b) => a.score - b.score || a.price - b.price || a.duration - b.duration
      || a.row.trip_key.localeCompare(b.row.trip_key));
    return ranked.map(({ row }) => row);
  }

  const by = (rank: (row: FlightRow) => number) =>
    [...rows].sort((a, b) => rank(a) - rank(b) || priceOf(a) - priceOf(b));
  switch (key) {
    case "depart":
      return by((row) => Date.parse(row.departure) || Date.parse(`${row.depart_date}T00:00`));
    case "duration":
      return by((row) => durationMinutes(row.duration || "") ?? Infinity);
    default:
      return by(priceOf);
  }
}

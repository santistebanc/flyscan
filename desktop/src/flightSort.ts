import type { FlightRow } from "./api";
import { durationMinutes } from "./flightRatings";

export type SortKey = "best" | "price"
  | "depart" | "arrive" | "return-depart" | "return-arrive"
  | "duration" | "duration-outbound" | "duration-return";
export const DEFAULT_SORT: SortKey = "best";

/**
 * The sort buttons. Best and Cheapest rank the whole trip; Departure and
 * Shortest each open a menu of variants, whose label the button takes while
 * that variant is chosen. Return variants only exist for a round trip.
 */
export interface SortGroup { label: string; keys: readonly SortKey[] }
export const SORT_GROUPS: readonly SortGroup[] = [
  { label: "Best", keys: ["best"] },
  { label: "Cheapest", keys: ["price"] },
  { label: "Departure", keys: ["depart", "arrive", "return-depart", "return-arrive"] },
  { label: "Shortest", keys: ["duration", "duration-outbound", "duration-return"] },
];
/** In a variant menu. */
export const SORT_OPTION_LABELS: Record<SortKey, string> = {
  best: "Best", price: "Cheapest",
  depart: "Outbound departure", arrive: "Outbound arrival", "return-depart": "Return departure", "return-arrive": "Return arrival",
  duration: "Total trip", "duration-outbound": "Outbound", "duration-return": "Return",
};
/** On the button while that variant is the sort. */
export const SORT_BUTTON_LABELS: Record<SortKey, string> = {
  best: "Best", price: "Cheapest",
  depart: "Departure", arrive: "Arrival", "return-depart": "Return departure", "return-arrive": "Return arrival",
  duration: "Shortest", "duration-outbound": "Shortest outbound", "duration-return": "Shortest return",
};
const ONE_WAY_KEYS: readonly SortKey[] = ["best", "price", "depart", "arrive", "duration"];
/** The variants a search offers: on a one-way, only those about the outbound. */
export function sortKeysFor(roundTrip: boolean, keys: readonly SortKey[]): SortKey[] {
  return keys.filter((key) => roundTrip || ONE_WAY_KEYS.includes(key));
}
/** A return variant on a one-way search falls back to its outbound counterpart. */
export function effectiveSort(key: SortKey, roundTrip: boolean): SortKey {
  if (roundTrip) return key;
  return key === "return-depart" ? "depart" : key === "return-arrive" ? "arrive" : key === "duration-return" || key === "duration-outbound" ? "duration" : key;
}

const priceOf = (row: FlightRow) => row.best?.price_base ?? Infinity;
const outboundMinutes = (row: FlightRow) => durationMinutes(row.duration || row.outbound?.duration || "");
const returnMinutes = (row: FlightRow) => durationMinutes(row.return_duration || row.inbound?.duration || "");
const isRoundTrip = (row: FlightRow) => Boolean(row.return_date || row.inbound);

function travelMinutes(row: FlightRow): number | null {
  const outbound = outboundMinutes(row);
  if (outbound === null) return null;
  if (!isRoundTrip(row)) return outbound;
  const inbound = returnMinutes(row);
  return inbound === null ? null : outbound + inbound;
}

/** Ascending, with Infinity (unknown) equal to itself rather than NaN. */
const compare = (a: number, b: number) => a === b ? 0 : a < b ? -1 : 1;

/** Local wall times compare as written: the same airports' clocks, whatever the viewer's timezone. */
const wallTime = (iso: string | undefined) => (iso && Date.parse(`${iso.slice(0, 16)}Z`)) || Infinity;

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

  // Unknown values sort last, and equal ones by price.
  const by = (rank: (row: FlightRow) => number | null) => rows.map((row) => ({ row, rank: rank(row) ?? Infinity }))
    .sort((a, b) => compare(a.rank, b.rank) || compare(priceOf(a.row), priceOf(b.row)))
    .map(({ row }) => row);
  switch (key) {
    case "depart":
      return by((row) => wallTime(row.outbound?.departure || row.departure || `${row.depart_date}T00:00`));
    case "arrive":
      return by((row) => wallTime(row.outbound?.arrival || row.arrival));
    case "return-depart":
      return by((row) => wallTime(row.inbound?.departure || row.return_departure));
    case "return-arrive":
      return by((row) => wallTime(row.inbound?.arrival || row.return_arrival));
    case "duration":
      return by(travelMinutes);
    case "duration-outbound":
      return by(outboundMinutes);
    case "duration-return":
      return by(returnMinutes);
    default:
      return by(priceOf);
  }
}

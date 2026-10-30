import type { FlightRow, Leg } from "./api";
import { effectiveSort, sortFlightRows, type SortKey } from "./flightSort";

/**
 * Picking a round trip one direction at a time: first a flight one way, then
 * one of the flights it was sold with the other way.
 *
 * Sellers only price whole round trips, so a flight in one direction has no
 * price of its own. Every row here summarizes the pairs it belongs to, and
 * the second step can only offer pairs that were actually quoted together;
 * nothing is ever priced by combining two directions.
 */

export type PairView = "pairs" | "outbound-first" | "return-first";
export type Direction = "outbound" | "inbound";

export const PAIR_VIEW_KEY = "flight-scraper:pair-view";
export const PAIR_VIEW_LABELS: Record<PairView, string> = {
  pairs: "All pairs", "outbound-first": "Outbound first", "return-first": "Return first",
};
const ORDER: readonly PairView[] = ["pairs", "outbound-first", "return-first"];

/** A stored value back to a view, anything unknown to All pairs. */
export function normalizePairView(value: unknown): PairView {
  return ORDER.includes(value as PairView) ? value as PairView : "pairs";
}

/** The view after this one, wrapping from Return first back to All pairs. */
export function nextPairView(view: PairView): PairView {
  return ORDER[(ORDER.indexOf(view) + 1) % ORDER.length]!;
}

/** The direction picked first in a stepped view; All pairs has none. */
export function firstDirection(view: PairView): Direction | null {
  return view === "outbound-first" ? "outbound" : view === "return-first" ? "inbound" : null;
}

export const otherDirection = (direction: Direction): Direction => direction === "outbound" ? "inbound" : "outbound";

/** One flight in one direction on one date, and every listed pair that flies it. */
export interface PickGroup {
  key: string;
  direction: Direction;
  /** Null for a return the seller did not describe; `date` is then all it shares. */
  leg: Leg | null;
  date: string;
  /** In list order: the first is the pair that placed this flight where it is. */
  pairs: FlightRow[];
  /** A pair that flies it, kept even when the filters leave none in `pairs`. */
  example: FlightRow;
  low: number | null;
  high: number | null;
}

/** The day a pair flies in one direction: the searched return date even when the return was not described. */
export const directionDate = (row: FlightRow, direction: Direction) => direction === "outbound" ? row.depart_date
  : row.return_date || row.inbound?.departure.slice(0, 10) || "";

/**
 * Which flight a pair flies in one direction. The date is part of it, so the
 * same flight on another day of a flexible search is another choice. Pairs
 * whose return was not described share one key per return date. Sources
 * write the same flight differently ("20:00:00" or "20:00", "FR 2527"), so
 * times count to the minute and flight numbers without spacing or case.
 */
export function legKey(row: FlightRow, direction: Direction): string {
  const leg = row[direction];
  const date = directionDate(row, direction);
  if (!leg) return `${direction}|${date}|undetailed`;
  return [direction, date, leg.flight_numbers.replace(/\s+/g, "").toUpperCase(), leg.origin_airport,
    leg.departure.slice(0, 16), leg.destination_airport, leg.arrival.slice(0, 16)].join("|");
}

/**
 * The sort a step uses. Each step lists one direction, so the choice is one a
 * one-way search offers, read as being about that direction.
 */
export function stepSort(key: SortKey, direction: Direction): SortKey {
  const oneWay = effectiveSort(key, false);
  if (oneWay === "duration") return direction === "outbound" ? "duration-outbound" : "duration-return";
  if (direction === "outbound") return oneWay;
  return oneWay === "depart" ? "return-depart" : oneWay === "arrive" ? "return-arrive" : oneWay;
}

const priceOf = (row: FlightRow) => row.best?.price_base ?? null;

/**
 * The first step's list: one entry per flight in `direction`, ordered by where
 * its best pair lands under the step's sort, with the price range of its pairs.
 * Leaves rows untouched.
 */
export function pickGroups(rows: FlightRow[], direction: Direction, sort: SortKey): PickGroup[] {
  const groups = new Map<string, PickGroup>();
  for (const row of sortFlightRows(rows, stepSort(sort, direction))) {
    const key = legKey(row, direction);
    let group = groups.get(key);
    if (!group) {
      group = { key, direction, leg: row[direction], date: directionDate(row, direction), pairs: [], example: row, low: null, high: null };
      groups.set(key, group);
    }
    group.pairs.push(row);
    const price = priceOf(row);
    if (price !== null) {
      group.low = group.low === null ? price : Math.min(group.low, price);
      group.high = group.high === null ? price : Math.max(group.high, price);
    }
  }
  return [...groups.values()];
}

/** The second step's list: the pairs that fly the picked flight, sorted for the other direction. */
export function pairsOf(rows: FlightRow[], picked: string, direction: Direction, sort: SortKey): FlightRow[] {
  return sortFlightRows(rows.filter((row) => legKey(row, direction) === picked), stepSort(sort, otherDirection(direction)));
}

/**
 * The pinned flight, summarized from the pairs the filters leave it. When they
 * leave none, it is still described from every pair, so it stays pinned; null
 * only when no pair flies it at all any more.
 */
export function pickedGroup(shown: FlightRow[], every: FlightRow[], picked: string, direction: Direction): PickGroup | null {
  const [group] = pickGroups(shown.filter((row) => legKey(row, direction) === picked), direction, "price");
  if (group) return group;
  const example = every.find((row) => legKey(row, direction) === picked);
  return example ? { key: picked, direction, leg: example[direction], date: directionDate(example, direction),
    pairs: [], example, low: null, high: null } : null;
}

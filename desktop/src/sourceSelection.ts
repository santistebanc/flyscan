/**
 * Which sources Fetch asks, and whose prices the list shows.
 *
 * Stored as the sources turned **off**, so a source the sidecar adds later is
 * asked by default rather than silently left out.
 */

import type { FlightRow } from "./api";

export const SOURCES_KEY = "flight-scraper:disabled-sources";

/** The stored list, kept only if it is a list of names. */
export function sanitizeDisabled(raw: unknown): string[] {
  return Array.isArray(raw) ? [...new Set(raw.filter((name): name is string => typeof name === "string"))] : [];
}

/** The sources to ask, in the sidecar's order. Never empty while any exist. */
export function chosenSources<T extends string>(known: readonly T[], disabled: readonly string[]): T[] {
  const chosen = known.filter((name) => !disabled.includes(name));
  return chosen.length ? chosen : [...known];
}

/**
 * What a search sends: nothing while every source is chosen, so the sidecar's
 * default applies and the search joins identical ones started elsewhere.
 */
export function requestedSources<T extends string>(known: readonly T[], disabled: readonly string[]): T[] | undefined {
  const chosen = chosenSources(known, disabled);
  return chosen.length && chosen.length < known.length ? chosen : undefined;
}

/** Turn one source on or off, refusing to turn off the last one. */
export function toggleSource(known: readonly string[], disabled: readonly string[], name: string): string[] {
  if (disabled.includes(name)) return disabled.filter((other) => other !== name);
  const remaining = known.filter((other) => other !== name && !disabled.includes(other));
  return remaining.length ? [...disabled, name] : [...disabled];
}

/**
 * The flights as the chosen sources quote them. Other sources' offers are left
 * out, so a flight only they sold disappears and the best price and spread
 * are worked out again from what remains. Without a choice, rows pass through.
 */
export function rowsFromSources(rows: FlightRow[], chosen?: readonly string[]): FlightRow[] {
  if (!chosen) return rows;
  return rows.flatMap((row) => {
    if (row.offers.every((offer) => chosen.includes(offer.source))) return [row];
    const offers = row.offers.filter((offer) => chosen.includes(offer.source))
      .sort((a, b) => (a.price_base ?? Infinity) - (b.price_base ?? Infinity));
    if (!offers.length) return [];
    const prices = offers.map((offer) => offer.price_base).filter((value): value is number => value !== null);
    const sources = [...new Set(offers.map((offer) => offer.source))];
    return [{ ...row, offers, best: offers[0]!, sources, source_count: sources.length,
      spread: prices.length > 1 ? Math.round((Math.max(...prices) - Math.min(...prices)) * 100) / 100 : null }];
  });
}

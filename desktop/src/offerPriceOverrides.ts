import type { FlightRow, Offer } from "./api";

export const PRICE_OVERRIDES_KEY = "flight-scraper.offer-prices-v1";
export type PriceOverrides = Record<string, number>;
export function offerPriceKey(scope: string, trip: string, offer: Pick<Offer, "source" | "agent">) {
  return JSON.stringify([scope, trip, offer.source, (offer.agent || "").trim().toLowerCase()]);
}
export function sanitizePriceOverrides(raw: unknown): PriceOverrides {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter(([key, value]) => key.startsWith("[") && key.length < 1000
    && typeof value === "number" && Number.isFinite(value) && value > 0));
}
/** Reapply corrections to each fresh source response; never overwrite its quote. */
export function applyPriceOverrides(rows: FlightRow[], scope: string, overrides: PriceOverrides): FlightRow[] {
  return rows.map((row) => {
    let changed = false;
    const offers = row.offers.map((offer) => {
      const value = overrides[offerPriceKey(scope, row.trip_key, offer)];
      if (value === undefined) return offer;
      changed = true;
      return { ...offer, original_price_base: offer.price_base, price_base: value, manual_price: true };
    });
    if (!changed) return row;
    offers.sort((a, b) => (a.price_base ?? Infinity) - (b.price_base ?? Infinity));
    const prices = offers.map((offer) => offer.price_base).filter((value): value is number => value !== null);
    return { ...row, offers, best: offers[0]!, spread: prices.length > 1 ? Math.round((Math.max(...prices) - Math.min(...prices)) * 100) / 100 : null };
  });
}

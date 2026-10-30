import type { FlightRow, Offer } from "./api";

export const PRICE_OVERRIDES_KEY = "flyscan.offer-prices-v2";
/** Version 1 stored a bare price with no record of the quote it corrected. */
export const LEGACY_PRICE_OVERRIDES_KEY = "flyscan.offer-prices-v1";
/** A correction, when it was made, and when the quote it corrected was seen. */
export interface PriceCorrection { price: number; at: string; quoteSeenAt: string | null }
export type PriceOverrides = Record<string, PriceCorrection>;
export function offerPriceKey(scope: string, trip: string, offer: Pick<Offer, "source" | "agent">) {
  return JSON.stringify([scope, trip, offer.source, (offer.agent || "").trim().toLowerCase()]);
}
export function correctionFor(offer: Pick<Offer, "seen_at">, price: number, at = new Date().toISOString()): PriceCorrection {
  return { price, at, quoteSeenAt: offer.seen_at || null };
}
const validPrice = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const validTime = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
export function sanitizePriceOverrides(raw: unknown): PriceOverrides {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const clean: PriceOverrides = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!key.startsWith("[") || key.length >= 1000 || !value || typeof value !== "object") continue;
    const { price, at, quoteSeenAt } = value as Record<string, unknown>;
    if (!validPrice(price) || !validTime(at)) continue;
    clean[key] = { price, at, quoteSeenAt: validTime(quoteSeenAt) ? quoteSeenAt : null };
  }
  return clean;
}
/** Version 1 corrections carry no quote date, so they arrive set aside. */
export function upgradeLegacyOverrides(raw: unknown, at = new Date().toISOString()): PriceOverrides {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return sanitizePriceOverrides(Object.fromEntries(Object.entries(raw)
    .map(([key, price]) => [key, { price, at, quoteSeenAt: null }])));
}
/** A quote seen after the one a correction was made against outranks it. */
function outranked(correction: PriceCorrection, offer: Offer) {
  if (correction.quoteSeenAt === null) return true;
  return !!offer.seen_at && Date.parse(offer.seen_at) > Date.parse(correction.quoteSeenAt);
}
/**
 * Apply each correction until the source quotes again. The fresher source
 * price then wins and the correction rides along as `stale_price_base`, for
 * the person to reapply or replace.
 */
export function applyPriceOverrides(rows: FlightRow[], scope: string, overrides: PriceOverrides): FlightRow[] {
  return rows.map((row) => {
    let changed = false;
    const offers = row.offers.map((offer) => {
      const correction = overrides[offerPriceKey(scope, row.trip_key, offer)];
      if (correction === undefined) return offer;
      changed = true;
      if (outranked(correction, offer)) return { ...offer, stale_price_base: correction.price, corrected_at: correction.at };
      return { ...offer, original_price_base: offer.price_base, price_base: correction.price, manual_price: true, corrected_at: correction.at };
    });
    if (!changed) return row;
    offers.sort((a, b) => (a.price_base ?? Infinity) - (b.price_base ?? Infinity));
    const prices = offers.map((offer) => offer.price_base).filter((value): value is number => value !== null);
    return { ...row, offers, best: offers[0]!, spread: prices.length > 1 ? Math.round((Math.max(...prices) - Math.min(...prices)) * 100) / 100 : null };
  });
}

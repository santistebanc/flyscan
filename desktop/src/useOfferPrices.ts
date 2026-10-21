import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FlightRow, Offer } from "./api";
import { applyPriceOverrides, offerPriceKey, PRICE_OVERRIDES_KEY, sanitizePriceOverrides } from "./offerPriceOverrides";

function read() {
  try { return sanitizePriceOverrides(JSON.parse(localStorage.getItem(PRICE_OVERRIDES_KEY) || "{}")); }
  catch { return {}; }
}
export function useOfferPrices(rawRows: FlightRow[], scope: string) {
  const [overrides, setOverrides] = useState(read);
  const current = useRef(overrides);
  current.current = overrides;
  useEffect(() => {
    const changed = (event: StorageEvent) => { if (event.key === PRICE_OVERRIDES_KEY) setOverrides(read()); };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  const correctPrice = useCallback((trip: string, offer: Offer, value: number | null) => {
    if (value !== null && (!Number.isFinite(value) || value <= 0)) throw new Error("Enter a price greater than zero.");
    const next = { ...current.current };
    const key = offerPriceKey(scope, trip, offer);
    if (value === null) delete next[key];
    else {
      const rounded = Math.round(value * 100) / 100;
      if (rounded <= 0) throw new Error("Enter a price of at least €0.01.");
      next[key] = rounded;
    }
    try { localStorage.setItem(PRICE_OVERRIDES_KEY, JSON.stringify(next)); }
    catch { throw new Error("The price could not be saved. Check available app storage and try again."); }
    current.current = next;
    setOverrides(next);
  }, [scope]);
  const rows = useMemo(() => applyPriceOverrides(rawRows, scope, overrides), [rawRows, scope, overrides]);
  return { rows, correctPrice };
}

/**
 * Display currency, and the formatting that depends on it.
 *
 * Everything crossing the API is EUR — the one currency the database stores.
 * Choosing a different currency here is a view setting: it re-renders what is
 * already on screen and never re-scrapes or rewrites anything.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { FlightScraperApi } from "./api";

const SYMBOLS: Record<string, string> = {
  EUR: "€", USD: "$", GBP: "£", CHF: "CHF", PLN: "zł",
  SEK: "kr", NOK: "kr", DKK: "kr", CZK: "Kč",
};

export const CURRENCIES = Object.keys(SYMBOLS);

interface CurrencyValue {
  currency: string;
  setCurrency: (next: string) => void;
  /** An EUR amount, formatted in the display currency. Never has decimals. */
  money: (eur: number | null | undefined) => string;
  /** What a seller quoted, shown only when it differs from the display currency. */
  nativeMoney: (amount: number | null, currency: string) => string;
  /** The amount as it will actually be shown, for "is this worth showing" checks. */
  roundedIn: (eur: number | null | undefined) => number;
}

const Ctx = createContext<CurrencyValue | null>(null);

export function CurrencyProvider(
  { api, children }: { api: FlightScraperApi | null; children: ReactNode },
) {
  const [currency, setStored] = useState(
    () => localStorage.getItem("displayCurrency") ?? "EUR",
  );
  const [rates, setRates] = useState<Record<string, number>>({ EUR: 1 });

  const setCurrency = useCallback((next: string) => {
    localStorage.setItem("displayCurrency", next);
    setStored(next);
  }, []);

  // Fetched once. Switching currency never refetches — it re-renders.
  useEffect(() => {
    if (!api) return;
    let live = true;
    api.rates("EUR").then((table) => {
      if (!live) return;
      setRates({ EUR: 1, ...table.rates });
    }).catch(() => { /* prices simply stay in EUR */ });
    return () => { live = false; };
  }, [api]);

  const value = useMemo<CurrencyValue>(() => {
    const rate = rates[currency] ?? 1;
    const symbol = SYMBOLS[currency] ?? currency;
    // Prices never carry decimals — a rounded figure is what people compare.
    const label = (amount: number, unit: string) =>
      unit.length === 1 ? `${unit}${amount.toFixed(0)}` : `${amount.toFixed(0)} ${unit}`;

    return {
      currency,
      setCurrency,
      money: (eur) => (eur === null || eur === undefined ? "" : label(eur * rate, symbol)),
      nativeMoney: (amount, quoted) =>
        amount === null || quoted === currency
          ? ""
          : label(amount, SYMBOLS[quoted] ?? quoted),
      roundedIn: (eur) =>
        eur === null || eur === undefined ? 0 : Math.round(eur * rate),
    };
  }, [currency, rates, setCurrency]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCurrency(): CurrencyValue {
  const value = useContext(Ctx);
  if (!value) throw new Error("useCurrency outside CurrencyProvider");
  return value;
}

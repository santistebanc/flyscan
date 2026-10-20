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
import { currencyOptions, displayCurrency, formatCurrencyAmount, validRates, type CurrencyOption } from "./currencyOptions";

const SYMBOLS: Record<string, string> = {
  EUR: "€", USD: "$", GBP: "£", CHF: "CHF", PLN: "zł",
  SEK: "kr", NOK: "kr", DKK: "kr", CZK: "Kč",
};

export const CURRENCIES = Object.keys(SYMBOLS);

interface CurrencyValue {
  currency: string;
  setCurrency: (next: string) => void;
  currencies: CurrencyOption[];
  loadingRates: boolean;
  rateProvider: string;
  ratesUpdatedAt: string;
  /** An EUR amount, formatted in the display currency. Never has decimals. */
  money: (eur: number | null | undefined) => string;
  /** What a seller quoted, shown only when it differs from the display currency. */
  nativeMoney: (amount: number | null, currency: string) => string;
  /** The amount as it will actually be shown, for "is this worth showing" checks. */
  roundedIn: (eur: number | null | undefined) => number;
  /** A display-currency amount back into the stored EUR price. */
  toEur: (amount: number) => number;
}

const Ctx = createContext<CurrencyValue | null>(null);

export function CurrencyProvider(
  { api, children }: { api: FlightScraperApi | null; children: ReactNode },
) {
  const [currency, setStored] = useState(
    () => { try { return localStorage.getItem("displayCurrency") ?? "EUR"; } catch { return "EUR"; } },
  );
  const [rates, setRates] = useState<Record<string, number>>({ EUR: 1 });
  const [loadingRates, setLoadingRates] = useState(true);
  const [rateProvider, setRateProvider] = useState("");
  const [ratesUpdatedAt, setRatesUpdatedAt] = useState("");
  const currencies = useMemo(() => currencyOptions(rates), [rates]);

  const setCurrency = useCallback((next: string) => {
    const selected = displayCurrency(rates, next);
    if (selected.currency !== next.trim().toUpperCase()) return;
    try { localStorage.setItem("displayCurrency", selected.currency); } catch { /* unavailable storage */ }
    setStored(selected.currency);
  }, [rates]);

  // Switching currency only re-renders. The local API caches provider rates
  // for a day; retry startup failures and refresh long-lived windows hourly.
  useEffect(() => {
    if (!api) return;
    let live = true, fetching = false, lastRead = 0, timer = 0;
    const read = async () => {
      if (!live || fetching) return;
      window.clearTimeout(timer);
      fetching = true;
      lastRead = Date.now();
      let retry = false;
      try {
        const table = await api.rates("EUR");
        if (!live) return;
        const next = validRates(table.rates);
        setRates(next);
        setRateProvider(table.provider);
        setRatesUpdatedAt(table.fetched_at);
        retry = Object.keys(next).length === 1;
      } catch { retry = true; } // keep the last known rates, or EUR before the first success
      finally {
        fetching = false;
        if (live) {
          setLoadingRates(false);
          timer = window.setTimeout(read, retry ? 5000 : 3_600_000);
        }
      }
    };
    const resume = () => { if (Date.now() - lastRead > 300_000) void read(); };
    window.addEventListener("focus", resume);
    void read();
    return () => { live = false; window.clearTimeout(timer); window.removeEventListener("focus", resume); };
  }, [api]);

  const value = useMemo<CurrencyValue>(() => {
    const { currency: selected, rate } = displayCurrency(rates, currency);
    const formatter = new Intl.NumberFormat("en", { style: "currency", currency: selected,
      minimumFractionDigits: 0, maximumFractionDigits: 0 });

    return {
      currency: selected,
      setCurrency,
      currencies, loadingRates, rateProvider, ratesUpdatedAt,
      money: (eur) => (eur === null || eur === undefined ? "" : formatter.format(eur * rate)),
      nativeMoney: (amount, quoted) =>
        amount === null || quoted === selected
          ? ""
          : formatCurrencyAmount(amount, quoted),
      roundedIn: (eur) =>
        eur === null || eur === undefined ? 0 : Math.round(eur * rate),
      toEur: (amount) => amount / rate,
    };
  }, [currency, rates, setCurrency, currencies, loadingRates, rateProvider, ratesUpdatedAt]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCurrency(): CurrencyValue {
  const value = useContext(Ctx);
  if (!value) throw new Error("useCurrency outside CurrencyProvider");
  return value;
}

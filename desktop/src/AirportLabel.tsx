import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { FlightScraperApi } from "./api";

const KEY = "flight-scraper.airport-cities";
const noop = (_code: string) => {};
const Context = createContext<{ cities: Record<string, string>; ensure: (code: string) => void }>({ cities: {}, ensure: noop });
function readCities(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}");
    return Object.fromEntries(Object.entries(raw).filter(([code, city]) => /^[A-Z]{3}$/.test(code)
      && typeof city === "string" && city.length > 0 && city.length < 160)) as Record<string, string>;
  } catch { return {}; }
}
export function AirportNamesProvider({ api, children }: { api: FlightScraperApi | null; children: ReactNode }) {
  const [cities, setCities] = useState(readCities);
  const current = useRef(cities);
  current.current = cities;
  const loader = useMemo(() => {
    const pending = new Set<string>(), queue: string[] = [];
    let active = 0, disposed = false;
    const drain = () => {
      while (api && !disposed && active < 3 && queue.length) {
        const code = queue.shift()!;
        active++;
        void api.places(code).then((places) => {
          const match = places.find((place) => place.code === code);
          const city = match?.city || (match?.kind === "city" ? match.name.replace(/ \(all airports\)$/, "") : "");
          if (city && city !== code && !disposed) setCities((old) => ({ ...old, [code]: city }));
        }).catch(() => { pending.delete(code); }).finally(() => { active--; drain(); });
      }
    };
    return { ensure: (code: string) => {
      if (!api || !/^[A-Z]{3}$/.test(code) || current.current[code] || pending.has(code)) return;
      pending.add(code); queue.push(code); drain();
    }, activate: () => { disposed = false; drain(); }, dispose: () => { disposed = true; } };
  }, [api]);
  useEffect(() => { loader.activate(); return () => loader.dispose(); }, [loader]);
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(cities)); } catch { /* Keep resolved names in memory. */ } }, [cities]);
  const ensure = useCallback((code: string) => loader.ensure(code), [loader]);
  return <Context.Provider value={{ cities, ensure }}>{children}</Context.Provider>;
}
export function AirportLabel({ code }: { code: string }) {
  const { cities, ensure } = useContext(Context);
  const airport = code.trim().toUpperCase();
  useEffect(() => { ensure(airport); }, [airport, ensure]);
  return <span className="airport-label" title={cities[airport] ? `${airport} · ${cities[airport]}` : airport}>
    <strong>{airport}</strong>{cities[airport] && <> <span className="airport-city">{cities[airport]}</span></>}
  </span>;
}

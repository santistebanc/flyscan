import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from "react";
import type { FlyscanApi } from "./api";

const noop = (_code: string) => {};
const EMPTY: Record<string, string> = {};
const empty = () => EMPTY;
const subscribe = () => () => {};
const Context = createContext<{ cities: Record<string, string>; countries: Record<string, string>;
  ensure: (code: string, withCountry?: boolean) => (() => void) | void }>({ cities: EMPTY, countries: EMPTY, ensure: noop });
export function AirportNamesProvider({ api, children }: { api: FlyscanApi | null; children: ReactNode }) {
  const cache = api?.airportCities;
  const cities = useSyncExternalStore(cache?.subscribe ?? subscribe, cache?.snapshot ?? empty, empty);
  const countries = useSyncExternalStore(cache?.subscribe ?? subscribe, cache?.countrySnapshot ?? empty, empty);
  useEffect(() => {
    if (!cache) return;
    cache.start();
    window.addEventListener("focus", cache.refresh);
    window.addEventListener("online", cache.refresh);
    return () => {
      window.removeEventListener("focus", cache.refresh);
      window.removeEventListener("online", cache.refresh);
      cache.stop();
    };
  }, [cache]);
  return <Context.Provider value={{ cities, countries, ensure: cache?.ensure ?? noop }}>{children}</Context.Provider>;
}
function useAirportLocation(code: string, withCountry = false) {
  const { cities, countries, ensure } = useContext(Context);
  const airport = code.trim().toUpperCase();
  useEffect(() => {
    if (/^[A-Z]{3}$/.test(airport)) return ensure(airport, withCountry);
  }, [airport, ensure, withCountry]);
  return { city: cities[airport] || "", country: countries[airport] || "" };
}
export function useAirportCity(code: string): string {
  return useAirportLocation(code).city;
}
export function AirportLabel({ code, showCity = true, showCountry = false }: { code: string; showCity?: boolean; showCountry?: boolean }) {
  const airport = code.trim().toUpperCase();
  const { city, country } = useAirportLocation(airport, showCountry);
  const location = [city, showCountry ? country : ""].filter(Boolean).join(", ");
  return <span className="airport-label" title={location ? `${airport} · ${location}` : airport}>
    <strong>{airport}</strong>{showCity && location && <> <span className="airport-city">{location}</span></>}
  </span>;
}

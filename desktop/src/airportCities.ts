import type { PlaceSuggestion } from "./api";

export const AIRPORT_CITIES_KEY = "flight-scraper.airport-cities-v2";
const LEGACY_KEY = "flight-scraper.airport-cities";
const DAY = 86_400_000, NAME_TTL = 180 * DAY, MISS_TTL = 10 * 60_000, MAX_ENTRIES = 2048;
type Entry = { city: string | null; checkedAt: number; country?: string; countryCheckedAt?: number };
const codeOf = (code: string) => code.trim().toUpperCase();
const validCode = (code: string) => /^[A-Z]{3}$/.test(code);
const countryOf = (value: unknown) => typeof value === "string" && value.trim().length < 160 ? value.trim() : "";
function cityOf(place: PlaceSuggestion) {
  const value = place.city || (place.kind === "city" ? place.name.replace(/ \(all airports\)$/, "") : "");
  return typeof value === "string" && value.trim().length < 160 && value.trim().toUpperCase() !== codeOf(place.code)
    ? value.trim() : "";
}

/** One city cache for labels and autocomplete, with a demand-driven lookup queue. */
export class AirportCities {
  private entries = new Map<string, Entry>();
  private cities: Record<string, string> = {};
  private countries: Record<string, string> = {};
  private listeners = new Set<() => void>();
  private wanted = new Map<string, number>();
  private countryWanted = new Map<string, number>();
  private pending = new Set<string>();
  private failures = new Map<string, { attempts: number; retryAt: number }>();
  private queue: string[] = [];
  private active = 0;
  private running = false;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private writeTimer?: ReturnType<typeof setTimeout>;

  constructor(private lookup: (code: string) => Promise<PlaceSuggestion[]>) {
    try {
      const saved = localStorage.getItem(AIRPORT_CITIES_KEY);
      const raw = JSON.parse(saved || localStorage.getItem(LEGACY_KEY) || "{}");
      for (const [code, value] of Object.entries(raw)) {
        const item = typeof value === "string" ? { city: value, checkedAt: 0 } : value as Entry;
        if (!validCode(code) || !item || !Number.isFinite(item.checkedAt) || item.checkedAt < 0) continue;
        const city = typeof item.city === "string" ? cityOf({ code, city: item.city } as PlaceSuggestion) : "";
        const country = countryOf(item.country);
        // A miss may come from an older running server without city metadata.
        // Keep misses in memory only, so reloading after a server update retries them.
        if (!city && !country) continue;
        this.entries.set(code, { city: city || null, country, checkedAt: Math.min(item.checkedAt, Date.now()),
          countryCheckedAt: Number.isFinite(item.countryCheckedAt) ? Math.max(0, Math.min(item.countryCheckedAt!, Date.now())) : 0 });
      }
      this.prune();
      this.cities = Object.fromEntries([...this.entries].flatMap(([code, entry]) => entry.city ? [[code, entry.city]] : []));
      this.countries = Object.fromEntries([...this.entries].flatMap(([code, entry]) => entry.country ? [[code, entry.country]] : []));
    } catch { /* Missing or damaged storage must not prevent a lookup. */ }
  }
  snapshot = () => this.cities;
  countrySnapshot = () => this.countries;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private due(code: string) {
    const entry = this.entries.get(code), failure = this.failures.get(code);
    let due = entry ? entry.checkedAt + (entry.city ? NAME_TTL : MISS_TTL) : 0;
    // Existing city-only caches need enrichment only where countries are shown.
    if (this.countryWanted.has(code) && !entry?.country) due = Math.min(due, (entry?.countryCheckedAt ?? 0) + MISS_TTL);
    return Math.max(due, failure?.retryAt ?? 0);
  }
  private prune() {
    if (this.entries.size <= MAX_ENTRIES) return;
    const keep = [...this.entries].sort((a, b) => Number(this.wanted.has(b[0])) - Number(this.wanted.has(a[0]))
      || b[1].checkedAt - a[1].checkedAt).slice(0, MAX_ENTRIES);
    this.entries = new Map(keep);
  }
  private changed() {
    this.prune();
    const next = Object.fromEntries([...this.entries].flatMap(([code, entry]) => entry.city ? [[code, entry.city]] : []));
    const countries = Object.fromEntries([...this.entries].flatMap(([code, entry]) => entry.country ? [[code, entry.country]] : []));
    const citiesChanged = Object.keys(next).length !== Object.keys(this.cities).length || Object.keys(next).some((code) => next[code] !== this.cities[code]);
    const countriesChanged = Object.keys(countries).length !== Object.keys(this.countries).length || Object.keys(countries).some((code) => countries[code] !== this.countries[code]);
    if (citiesChanged || countriesChanged) {
      this.cities = next;
      this.countries = countries;
      this.listeners.forEach((listener) => listener());
    }
    // Batch an autocomplete response and a burst of airport lookups into one write.
    if (this.writeTimer === undefined) this.writeTimer = setTimeout(() => this.flush(), 250);
  }
  private flush() {
    clearTimeout(this.writeTimer); this.writeTimer = undefined;
    try { localStorage.setItem(AIRPORT_CITIES_KEY, JSON.stringify(Object.fromEntries([...this.entries].filter(([, entry]) => entry.city || entry.country)))); }
    catch { /* Continue with the in-memory cache when storage is unavailable. */ }
  }
  remember = (places: PlaceSuggestion[]) => {
    let changed = false;
    const now = Date.now();
    for (const place of places) {
      const code = codeOf(place.code), resolvedCity = cityOf(place), resolvedCountry = countryOf(place.country);
      if (!validCode(code) || (!resolvedCity && !resolvedCountry)) continue;
      const previous = this.entries.get(code);
      const city = resolvedCity || previous?.city || null, country = resolvedCountry || previous?.country || "";
      if (previous?.city === city && previous?.country === country && now - previous.checkedAt < 5 * 60_000) continue;
      this.entries.set(code, { city, country, checkedAt: now,
        countryCheckedAt: typeof place.country === "string" ? now : previous?.countryCheckedAt });
      this.failures.delete(code); changed = true;
    }
    if (changed) { this.changed(); this.schedule(); }
  };
  /** Effects release demand on unmount, so offscreen failures do not keep retrying. */
  ensure = (raw: string, withCountry = false) => {
    const code = codeOf(raw);
    if (!validCode(code)) return;
    this.wanted.set(code, (this.wanted.get(code) ?? 0) + 1);
    if (withCountry) this.countryWanted.set(code, (this.countryWanted.get(code) ?? 0) + 1);
    this.refresh();
    return () => {
      const count = (this.wanted.get(code) ?? 1) - 1;
      if (count) this.wanted.set(code, count); else this.wanted.delete(code);
      if (withCountry) {
        const remaining = (this.countryWanted.get(code) ?? 1) - 1;
        if (remaining) this.countryWanted.set(code, remaining); else this.countryWanted.delete(code);
      }
      this.schedule();
    };
  };
  start = () => { this.running = true; this.refresh(); };
  stop = () => {
    this.running = false; clearTimeout(this.retryTimer); this.retryTimer = undefined;
    if (this.writeTimer !== undefined) this.flush();
  };
  refresh = () => {
    if (!this.running) return;
    for (const code of this.wanted.keys()) {
      if (!this.pending.has(code) && this.due(code) <= Date.now()) { this.pending.add(code); this.queue.push(code); }
    }
    this.drain(); this.schedule();
  };
  private drain() {
    while (this.running && this.active < 3 && this.queue.length) {
      const code = this.queue.shift()!;
      if (!this.wanted.has(code) || this.due(code) > Date.now()) { this.pending.delete(code); continue; }
      this.active++;
      void this.lookup(code).then((places) => {
        this.remember(places);
        // A successful response with no city is briefly cached, not a permanent miss.
        if (!this.entries.has(code) || this.due(code) <= Date.now()) {
          const previous = this.entries.get(code);
          this.entries.set(code, { ...previous, city: previous?.city ?? null, checkedAt: Date.now(), countryCheckedAt: Date.now() });
          this.changed();
        }
        this.failures.delete(code);
      }).catch(() => {
        const attempts = (this.failures.get(code)?.attempts ?? 0) + 1;
        this.failures.set(code, { attempts, retryAt: Date.now() + Math.min(60_000 * 2 ** (attempts - 1), 15 * 60_000) });
      }).finally(() => { this.active--; this.pending.delete(code); this.drain(); this.schedule(); });
    }
  }
  private schedule() {
    clearTimeout(this.retryTimer); this.retryTimer = undefined;
    if (!this.running) return;
    const due = [...this.wanted.keys()].filter((code) => !this.pending.has(code)).map((code) => this.due(code));
    if (due.length) this.retryTimer = setTimeout(this.refresh, Math.max(1, Math.min(2_147_483_647, Math.min(...due) - Date.now())));
  }
}

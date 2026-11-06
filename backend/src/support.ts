import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { now, roundMoney } from "./models.js";
import { type Transport } from "./transport.js";
export type Data = Record<string, any>;
export function readJSON(path: string, fallback: any = {}): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}
export function atomicJSON(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = path + "." + randomUUID() + ".tmp";
  try {
    writeFileSync(temp, JSON.stringify(data, null, 1), { mode: 0o600 });
    renameSync(temp, path);
  } finally {
    try {
      unlinkSync(temp);
    } catch {}
  }
}
export class ErrorLog {
  constructor(
    public path = process.env.FLYSCAN_ERROR_DIR
      ? process.env.FLYSCAN_ERROR_DIR + "/errors.jsonl"
      : ".errors/errors.jsonl",
  ) {}
  entries(): Data[] {
    try {
      return readFileSync(this.path, "utf8")
        .split("\n")
        .flatMap((s) => {
          try {
            return [JSON.parse(s)];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
    }
  }
  record(where: string, error: unknown, context: Data = {}): string {
    const id = randomUUID().replaceAll("-", "").slice(0, 12);
    try {
      const entry = {
        id,
        at: now(),
        where,
        kind: error instanceof Error ? error.name : "error",
        message: error instanceof Error ? error.message : String(error),
        context,
        ...(error instanceof Error
          ? { traceback: error.stack?.slice(0, 8000) }
          : {}),
      };
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(
        this.path,
        [...this.entries().slice(-499), entry]
          .map((e) => JSON.stringify(e))
          .join("\n") + "\n",
        { mode: 0o600 },
      );
    } catch {}
    return id;
  }
  recent(limit = 20, where = ""): Data[] {
    return this.entries()
      .filter((e) => e.where?.startsWith(where))
      .reverse()
      .slice(0, limit);
  }
  summary(): Data[] {
    const groups = new Map<string, Data>();
    for (const e of this.entries()) {
      const key = JSON.stringify([e.where, e.kind, e.message.slice(0, 80)]);
      let g = groups.get(key);
      if (!g) {
        g = {
          where: e.where,
          kind: e.kind,
          message: e.message.slice(0, 80),
          count: 0,
          first: e.at,
          last: e.at,
        };
        groups.set(key, g);
      }
      g.count++;
      g.last = e.at;
    }
    return [...groups.values()].sort((a, b) => b.count - a.count);
  }
  clear(): number {
    const count = this.entries().length;
    try {
      unlinkSync(this.path);
    } catch {}
    return count;
  }
}
export class RateTable {
  constructor(
    public base: string,
    public rates: Record<string, number>,
    public fetched_at = now(),
    public provider = "none",
  ) {
    this.base = base.toUpperCase();
    this.rates[this.base] = 1;
  }
  convert(amount: number | null, currency: string): number | null {
    if (amount === null) return null;
    const rate = this.rates[currency.toUpperCase() || this.base];
    return rate && Number.isFinite(rate) ? roundMoney(amount / rate) : null;
  }
  get stale(): boolean {
    return (
      !Number.isFinite(Date.parse(this.fetched_at)) ||
      Date.now() - Date.parse(this.fetched_at) > 86400000
    );
  }
}
export class Rates {
  private pending = new Map<string, Promise<RateTable>>();
  private memory = new Map<string, RateTable>();
  constructor(
    private transport: Transport,
    private path = ".fx_cache.json",
  ) {}
  async get(base = "EUR", refresh = false): Promise<RateTable> {
    base = base.toUpperCase();
    const memory = this.memory.get(base);
    if (memory && !memory.stale && !refresh) return memory;
    let pending = this.pending.get(base);
    if (!pending) {
      pending = this.load(base, refresh);
      this.pending.set(base, pending);
    }
    try {
      return await pending;
    } finally {
      this.pending.delete(base);
    }
  }
  private async load(base: string, refresh: boolean): Promise<RateTable> {
    const blob = readJSON(this.path),
      cached = blob[base],
      fallback =
        this.memory.get(base) ||
        (cached
          ? new RateTable(
              cached.base,
              cached.rates,
              cached.fetched_at,
              cached.provider,
            )
          : null);
    if (fallback && !fallback.stale && !refresh) {
      this.memory.set(base, fallback);
      return fallback;
    }
    if (process.env.FLYSCAN_OFFLINE !== "1")
      for (const [name, url] of [
        ["open.er-api.com", `https://open.er-api.com/v6/latest/${base}`],
        ["frankfurter", `https://api.frankfurter.dev/v1/latest?base=${base}`],
      ]) {
        let session;
        try {
          session = await this.transport.open();
          const r = await session.request("GET", url, { timeout: 20 }),
            rates = r.json()?.rates;
          if (r.status === 200 && rates && Object.keys(rates).length) {
            const table = new RateTable(base, rates, now(), name);
            this.memory.set(base, table);
            try {
              atomicJSON(this.path, { ...readJSON(this.path), [base]: table });
            } catch {}
            return table;
          }
        } catch {
        } finally {
          await session?.close();
        }
      }
    const table = fallback || new RateTable(base, {});
    this.memory.set(base, table);
    return table;
  }
}
export interface Place {
  code: string;
  name: string;
  country: string;
  kind: string;
  detail: string;
  city: string;
}
export class Places {
  constructor(
    private transport: Transport,
    private path = ".places_cache.json",
  ) {}
  async search(term: string, limit = 8): Promise<Place[]> {
    term = term.trim();
    if (!term) return [];
    const session = await this.transport.open();
    try {
      const params = new URLSearchParams([
        ["types[]", "city"],
        ["types[]", "airport"],
        ["term", term],
        ["locale", "en"],
      ]);
      const r = await session.request(
        "GET",
        "https://autocomplete.apistp.com/places2?" + params,
        { timeout: 25 },
      );
      if (r.status !== 200)
        throw new Error(`place lookup returned HTTP ${r.status}`);
      const payload = r.json(),
        seen = new Set<string>(),
        out: Place[] = [];
      for (const e of (payload || []).slice(0, limit * 2)) {
        const code = (e.code || "").trim().toUpperCase();
        if (!code || seen.has(code)) continue;
        seen.add(code);
        const kind = e.type || "";
        out.push({
          code,
          name: (e.name || code) + (kind === "city" ? " (all airports)" : ""),
          country: e.country_name || "",
          kind,
          detail: e.main_airport_name || e.city_name || "",
          city: e.city_name || (kind === "city" ? e.name : "") || "",
        });
        if (out.length >= limit) break;
      }
      return out;
    } finally {
      await session.close();
    }
  }
  async resolve(term: string, prefer = "city"): Promise<Place> {
    term = term.trim();
    if (!term) throw new Error("empty place query");
    if (/^[A-Za-z]{3}$/.test(term))
      return {
        code: term.toUpperCase(),
        name: term.toUpperCase(),
        country: "",
        kind: "code",
        detail: "",
        city: "",
      };
    const cache = readJSON(this.path),
      key = prefer + "|" + term.toLowerCase();
    if (cache[key]) return cache[key];
    const found = await this.search(term);
    if (!found.length) throw new Error(`no place matched '${term}'`);
    const chosen =
      (prefer === "city" ? found.find((p) => p.kind === "city") : null) ||
      found[0];
    try {
      atomicJSON(this.path, { ...cache, [key]: chosen });
    } catch {}
    return chosen;
  }
}

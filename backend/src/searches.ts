import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  Leg as PublicLeg,
  FlightRow,
  Offer as PublicOffer,
  SourceName,
} from "../../shared/contracts.js";
import {
  cabins,
  now,
  parseDate,
  prettyDuration,
  query,
  sha1,
  stableJSON,
  tripKey,
  tripPairs,
  type Leg,
  type Offer,
} from "./models.js";
import { Scheduler } from "./scheduler.js";
import { allowedSources, webMode } from "./sources.js";
import { Places, type Data, type RateTable } from "./support.js";
export function publicLeg(l: Leg): PublicLeg {
  return {
    origin_airport: l.origin_airport,
    destination_airport: l.destination_airport,
    departure: l.departure,
    arrival: l.arrival,
    duration: prettyDuration(l.duration_minutes),
    stops: l.stops,
    airlines: l.airlines,
    flight_numbers: l.flight_numbers,
    segments: l.segments.map((s) => ({
      carrier: s.carrier,
      carrier_name: s.carrier_name || s.carrier,
      flight_number: s.flight_number,
      operating_carrier_name: s.operating_carrier_name || s.operating_carrier,
      operating_flight_number: s.operating_flight_number,
      origin: s.origin,
      destination: s.destination,
      departure: s.departure,
      arrival: s.arrival,
      duration: prettyDuration(s.duration_minutes),
    })),
  };
}
export function mergedRows(offers: Offer[], rates: RateTable): FlightRow[] {
  const grouped = new Map<string, Offer[]>();
  for (const o of offers) {
    if (o.price_eur === null) o.price_eur = rates.convert(o.price, o.currency);
    const key = tripKey(o.itinerary);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(o);
  }
  return [...grouped.entries()]
    .map(([key, list]) => {
      list.sort(
        (a, b) => (a.price_eur ?? Infinity) - (b.price_eur ?? Infinity),
      );
      const best = list[0],
        i = best.itinerary,
        q = i.query,
        out = i.outbound,
        back = i.inbound,
        prices = list
          .map((o) => o.price_eur)
          .filter((p): p is number => p !== null),
        sources = [...new Set(list.map((o) => o.source as SourceName))],
        rows = list.map<PublicOffer>((o) => ({
          source: o.source as SourceName,
          agent: o.agent,
          price: o.price,
          currency: o.currency,
          price_base: o.price_eur,
          deeplink: o.deeplink,
          seen_at: o.seen_at,
        }));
      return {
        trip_key: key,
        depart_date: q.depart,
        route: out.origin_airport + "-" + out.destination_airport,
        departure: out.departure,
        arrival: out.arrival,
        duration: prettyDuration(out.duration_minutes),
        stops: out.stops,
        airlines: out.airlines,
        flight_numbers: out.flight_numbers,
        return_date: q.ret || "",
        return_departure: back?.departure || "",
        return_arrival: back?.arrival || "",
        return_duration: back ? prettyDuration(back.duration_minutes) : "",
        outbound: publicLeg(out),
        inbound: back ? publicLeg(back) : null,
        best: rows[0],
        sources,
        source_count: sources.length,
        spread:
          prices.length > 1
            ? Math.round((Math.max(...prices) - Math.min(...prices)) * 100) /
              100
            : null,
        offers: rows,
      };
    })
    .sort(
      (a, b) =>
        (a.best.price_base ?? Infinity) - (b.best.price_base ?? Infinity),
    );
}
export function parseParams(form: Data, scheduler: Scheduler): Data {
  if (!form || typeof form !== "object" || Array.isArray(form))
    throw new Error("a JSON object is required");
  const sources = form.sources?.length ? form.sources : allowedSources();
  if (!Array.isArray(sources) || sources.some((s) => typeof s !== "string"))
    throw new Error("sources must be a list of names");
  if (sources.some((s) => !allowedSources().includes(s)))
    throw new Error("unknown or disabled source");
  const number = (key: string, fallback: number, min: number) => {
    const n = Number(form[key] ?? fallback);
    if (
      !Number.isFinite(n) ||
      n < min ||
      ([
        "workers",
        "retries",
        "timeout",
        "adults",
        "children",
        "infants",
      ].includes(key) &&
        !Number.isInteger(n))
    )
      throw new Error(`invalid ${key}`);
    return n;
  };
  const params: Data = {
    origin: String(form.origin || "").trim(),
    destination: String(form.destination || "").trim(),
    start: parseDate(String(form.start || "")),
    end: form.end ? parseDate(form.end) : null,
    ret: form.ret ? parseDate(form.ret) : null,
    ret_end: form.ret_end ? parseDate(form.ret_end) : null,
    adults: number("adults", 1, 1),
    children: number("children", 0, 0),
    infants: number("infants", 0, 0),
    cabin: form.cabin || "economy",
    currency: String(form.currency || "EUR").toUpperCase(),
    base_currency: String(form.base_currency || "EUR").toUpperCase(),
    sources: [...new Set(sources)],
    prefer: form.prefer || "city",
    timeout: number("timeout", 60, 0.001),
    retries: number("retries", 2, 1),
    workers: number("workers", scheduler.maxWorkers, 1),
    cache_hours: number("cache_hours", scheduler.ttl, 0),
    refresh: !!form.refresh,
    db:
      form.db === undefined
        ? scheduler.store?.path || null
        : form.db
          ? resolve(form.db)
          : null,
  };
  if (!params.origin || !params.destination)
    throw new Error("origin and destination are both required");
  if (!cabins.includes(params.cabin)) throw new Error("invalid cabin");
  if (
    !/^[A-Z]{3}$/.test(params.currency) ||
    !/^[A-Z]{3}$/.test(params.base_currency)
  )
    throw new Error("currency must be a three-letter code");
  if (
    (params.db ? resolve(params.db) : null) !==
    (scheduler.store ? resolve(scheduler.store.path) : null)
  )
    throw new Error(
      "database conflicts with the configured process ledger; start a separate server with --db",
    );
  if (params.workers !== scheduler.maxWorkers)
    throw new Error(
      "max_workers conflicts with the configured process settings",
    );
  if (params.end && params.end < params.start)
    throw new Error("end date is before start date");
  if (params.ret_end && !params.ret)
    throw new Error("a return range needs a first return date");
  if (params.ret_end && params.ret_end < params.ret)
    throw new Error("last return date is before the first");
  if (webMode()) {
    if (
      (Date.parse(params.end || params.start) - Date.parse(params.start)) /
        86400000 >
        30 ||
      (params.ret &&
        (Date.parse(params.ret_end || params.ret) - Date.parse(params.ret)) /
          86400000 >
          30)
    )
      throw new Error("hosted searches support at most 31 dates");
    Object.assign(params, {
      refresh: false,
      cache_hours: scheduler.ttl,
      retries: 1,
      timeout: 60,
    });
  }
  const trips = tripPairs(params.start, params.end, params.ret, params.ret_end);
  if (!trips.length)
    throw new Error("every return date is before every departure date");
  if (webMode() && trips.length > 31)
    throw new Error("hosted searches support at most 31 trips");
  return params;
}
export class EventLog {
  private events: Data[] = [];
  private listeners = new Set<(event: Data | null) => void>();
  private closed = false;
  lastSeq = 0;
  constructor(private limit = 5000) {
    if (limit < 1) throw new Error("event retention must be positive");
  }
  append(event: Data): Data {
    if (this.closed) return event;
    const stamped = structuredClone({
      ...event,
      seq: ++this.lastSeq,
      at: now(),
    });
    this.events.push(stamped);
    if (this.events.length > this.limit)
      this.events.splice(0, this.events.length - this.limit);
    for (const listener of this.listeners) listener(structuredClone(stamped));
    return structuredClone(stamped);
  }
  snapshot(after = 0): Data[] {
    return structuredClone(this.events.filter((e) => e.seq > after));
  }
  subscribe(after: number, listener: (event: Data | null) => void): () => void {
    this.listeners.add(listener);
    for (const event of this.snapshot(after)) listener(event);
    if (this.closed) listener(null);
    return () => this.listeners.delete(listener);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.listeners) listener(null);
    this.listeners.clear();
  }
}
export class Search {
  readonly id = randomUUID().replaceAll("-", "");
  readonly log = new EventLog();
  readonly created = now();
  finished: string | null = null;
  status = "queued";
  cancelled = false;
  error = "";
  private days = new Map<string, Data>();
  private totals: Data = {};
  private csv: string | null = null;
  private json: string | null = null;
  constructor(
    public readonly params: Data,
    public readonly fingerprint: string,
    private scheduler: Scheduler,
    private places: Places,
  ) {}
  get done(): boolean {
    return ["done", "failed", "cancelled"].includes(this.status);
  }
  summary(): Data {
    const { db, ...publicParams } = this.params;
    return structuredClone({
      search_id: this.id,
      status: this.status,
      params: publicParams,
      created_at: this.created,
      finished_at: this.finished,
      error: this.error,
      last_seq: this.log.lastSeq,
      days_done: this.days.size,
      ...this.totals,
      csv: this.csv,
      json: this.json,
    });
  }
  results(): Data[] {
    return structuredClone([...this.days.values()]);
  }
  emit(event: string, data: Data = {}): void {
    this.log.append({ event, ...data });
  }
  cancel(): boolean {
    if (this.done) return false;
    this.cancelled = true;
    this.scheduler.cancelOwner(this.id);
    return true;
  }
  async run(): Promise<void> {
    if (this.done || this.status === "running") return;
    this.status = "running";
    try {
      if (!this.cancelled) await this.execute();
    } catch (e) {
      this.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      this.scheduler.errors.record("search", e, {
        search: this.id,
        ...this.params,
      });
      this.emit("error", { message: this.error });
      this.totals.errors = (this.totals.errors || 0) + 1;
    } finally {
      this.status = this.cancelled
        ? "cancelled"
        : this.error
          ? "failed"
          : "done";
      this.finished = now();
      this.emit("done", {
        total: this.totals.offers || 0,
        itineraries: this.totals.itineraries || 0,
        errors: this.totals.errors || 0,
        csv: this.csv,
        json: this.json,
        cancelled: this.cancelled,
      });
      this.log.close();
      this.scheduler.cancelOwner(this.id);
    }
  }
  private async execute(): Promise<void> {
    const p = this.params,
      [origin, destination] = await Promise.all([
        this.places.resolve(p.origin, p.prefer),
        this.places.resolve(p.destination, p.prefer),
      ]);
    if (this.cancelled) return;
    this.emit("resolved", {
      origin: origin.name,
      destination: destination.name,
      origin_code: origin.code,
      destination_code: destination.code,
    });
    const trips = tripPairs(p.start, p.end, p.ret, p.ret_end);
    this.emit("start", {
      days: trips.length,
      sources: p.sources,
      jobs: trips.length * p.sources.length,
    });
    const rates = await this.scheduler.rates.get("EUR");
    if (this.cancelled) return;
    let completed = 0;
    const allOffers: Offer[] = [];
    await Promise.all(
      trips.map(async ([day, ret]) => {
        if (this.cancelled) return;
        const q = query({
            origin: origin.code,
            destination: destination.code,
            depart: day,
            ret,
            adults: p.adults,
            children: p.children,
            infants: p.infants,
            cabin: p.cabin,
            currency: p.currency,
          }),
          key = `${day}/${ret || ""}`,
          offers: Offer[] = [],
          errors: Data = {},
          started = Date.now();
        let sourcesDone = 0;
        this.emit("day_start", { day, ret, sources: p.sources });
        await Promise.all(
          p.sources.map(async (name: string) => {
            if (this.cancelled) return;
            const source = this.scheduler.source(name);
            source.timeout = p.timeout;
            const submission = this.scheduler.submit(source, q, {
              owner: this.id,
              retries: p.retries,
              refresh: p.refresh,
              ttl: p.cache_hours,
              progress: (event, data) => {
                if (this.cancelled || this.done) return;
                this.emit(
                  event,
                  event === "source_retry"
                    ? { ...data, message: data.error }
                    : data,
                );
              },
            });
            const result = await submission.result;
            if (this.cancelled) return;
            sourcesDone++;
            offers.push(...result.offers);
            if (result.error) errors[name] = result.error;
            const stored = this.scheduler.storedOffers(q),
              combined = stored ?? offers,
              rows = mergedRows(combined, rates);
            this.days.set(key, {
              trip: key,
              day,
              ret,
              offers: combined.length,
              itineraries: rows.length,
              errors: { ...errors },
              rows,
              complete: false,
            });
            this.emit("day_partial", {
              day,
              ret,
              offers: combined.length,
              itineraries: rows.length,
              sources_done: sourcesDone,
              sources_total: p.sources.length,
              shown: rows.length,
              rows,
            });
          }),
        );
        if (this.cancelled) return;
        const combined = this.scheduler.storedOffers(q) ?? offers,
          rows = mergedRows(combined, rates);
        allOffers.push(...combined);
        completed++;
        this.days.set(key, {
          trip: key,
          day,
          ret,
          offers: combined.length,
          itineraries: rows.length,
          errors,
          rows,
          complete: true,
        });
        this.totals = {
          offers: allOffers.length,
          itineraries: [...this.days.values()].reduce(
            (n, d) => n + d.itineraries,
            0,
          ),
          errors: [...this.days.values()].reduce(
            (n, d) => n + Object.keys(d.errors).length,
            0,
          ),
        };
        this.emit("day_done", {
          day,
          ret,
          index: completed,
          total: trips.length,
          offers: combined.length,
          itineraries: rows.length,
          elapsed: Math.round((Date.now() - started) / 100) / 10,
          errors,
          shown: rows.length,
          rows,
        });
      }),
    );
    if (allOffers.length && !this.cancelled && !webMode()) {
      const stem =
        p.output ||
        `${qSafe(origin.code)}-${qSafe(destination.code)}-${now().replace(/[^0-9]/g, "")}-${this.id.slice(0, 6)}`;
      const paths = writeExports(allOffers, stem);
      this.csv = paths.csv;
      this.json = paths.json;
    }
  }
}
const qSafe = (s: string) => s.replace(/[^a-z0-9-]/gi, "_");
export function writeExports(
  offers: Offer[],
  stem: string,
  directory = "out",
): Data {
  mkdirSync(directory, { recursive: true });
  const rows = offers.map((o) => ({
    depart_date: o.itinerary.query.depart,
    origin_airport: o.itinerary.outbound.origin_airport,
    destination_airport: o.itinerary.outbound.destination_airport,
    departure: o.itinerary.outbound.departure,
    arrival: o.itinerary.outbound.arrival,
    duration_minutes: o.itinerary.outbound.duration_minutes,
    stops: o.itinerary.outbound.stops,
    airlines: o.itinerary.outbound.airlines,
    flight_numbers: o.itinerary.outbound.flight_numbers,
    source: o.source,
    agent: o.agent,
    price: o.price,
    currency: o.currency,
    price_base: o.price_eur,
    base_currency: "EUR",
    deeplink: o.deeplink,
    trip_key: tripKey(o.itinerary),
  }));
  const csv = qSafe(stem) + ".csv",
    json = qSafe(stem) + ".json";
  writeFileSync(join(directory, json), JSON.stringify(rows, null, 2) + "\n");
  const columns = Object.keys(rows[0] || {}),
    quote = (v: unknown) => '"' + String(v ?? "").replaceAll('"', '""') + '"';
  writeFileSync(
    join(directory, csv),
    "\uFEFF" +
      [
        columns.map(quote).join(","),
        ...rows.map((r) => columns.map((c) => quote((r as any)[c])).join(",")),
      ].join("\r\n") +
      "\r\n",
  );
  return { csv, json };
}
export class Searches {
  private jobs = new Map<string, Search>();
  private fingerprints = new Map<string, string>();
  constructor(
    private scheduler: Scheduler,
    private places: Places,
  ) {}
  start(params: Data, force = false): { job: Search; joined: boolean } {
    this.reap();
    const { sources, ...rest } = params,
      fingerprint = sha1(stableJSON({ ...rest, sources: [...sources].sort() }));
    const existing = this.jobs.get(this.fingerprints.get(fingerprint) || "");
    if (existing && !existing.done && !existing.cancelled && !force)
      return { job: existing, joined: true };
    const job = new Search(
      structuredClone(params),
      fingerprint,
      this.scheduler,
      this.places,
    );
    this.jobs.set(job.id, job);
    this.fingerprints.set(fingerprint, job.id);
    setImmediate(() => void job.run());
    return { job, joined: false };
  }
  get(id: string): Search | undefined {
    this.reap();
    return this.jobs.get(id);
  }
  list(limit = 25): Data[] {
    this.reap();
    return [...this.jobs.values()]
      .reverse()
      .slice(0, limit)
      .map((j) => j.summary());
  }
  private reap(): void {
    for (const [id, j] of this.jobs)
      if (j.finished && Date.now() - Date.parse(j.finished) > 3600000) {
        this.jobs.delete(id);
        if (this.fingerprints.get(j.fingerprint) === id)
          this.fingerprints.delete(j.fingerprint);
      }
  }
  cancelAll(): void {
    for (const j of this.jobs.values()) j.cancel();
  }
}

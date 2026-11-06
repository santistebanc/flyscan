import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  leg,
  now,
  offer,
  queryKey,
  roundMoney,
  segment,
  tripKey,
  type Itinerary,
  type Leg,
  type Offer,
  type Query,
} from "./models.js";
import { migrations, schema } from "./schema.js";

type Row = Record<string, any>;
const round = roundMoney;
const json = (v: any, fallback: any = []) => {
  try {
    return typeof v === "string" ? JSON.parse(v) : (v ?? fallback);
  } catch {
    return fallback;
  }
};
const codeFields = [
  "carrier",
  "carrier_name",
  "flight_number",
  "operating_carrier",
  "operating_carrier_name",
  "operating_flight_number",
];
export function offerCodes(i: Itinerary): string | null {
  const legs = { out: i.outbound.segments, ret: i.inbound?.segments || [] };
  if (
    !Object.values(legs)
      .flat()
      .some((s) => s.carrier || s.flight_number)
  )
    return null;
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(legs).map(([key, segments]) => [
        key,
        segments.map((s) =>
          Object.fromEntries(codeFields.map((k) => [k, (s as any)[k]])),
        ),
      ]),
    ),
  );
}
export function applyCodes(data: Row, codes: string | null): void {
  const given = json(codes, null);
  if (!given || Array.isArray(given)) return;
  for (const [key, col] of [
    ["out", "depart_segments"],
    ["ret", "return_segments"],
  ]) {
    const old = data[col],
      named = given[key];
    if (
      !Array.isArray(old) ||
      !Array.isArray(named) ||
      !named.length ||
      old.length !== named.length
    )
      continue;
    data[col] = old.map((s, i) =>
      named[i] && (named[i].carrier || named[i].flight_number)
        ? {
            ...s,
            ...Object.fromEntries(
              codeFields.map((k) => [k, named[i][k] || ""]),
            ),
          }
        : s,
    );
  }
  const out = data.depart_segments || [];
  if (out.some((s: any) => s.flight_number)) {
    data.airlines = [
      ...new Set(
        out.map((s: any) => s.carrier_name || s.carrier).filter(Boolean),
      ),
    ].join(", ");
    data.flight_numbers = out
      .map((s: any) => s.flight_number)
      .filter(Boolean)
      .join(", ");
  }
}
export function mergeSegments(
  stored: string | null,
  fresh: string | null,
): string | null {
  const old = json(stored),
    next = json(fresh);
  if (
    !Array.isArray(old) ||
    !Array.isArray(next) ||
    !old.length ||
    old.length !== next.length
  )
    return null;
  let changed = false;
  const out = [];
  for (let i = 0; i < old.length; i++) {
    const a = old[i],
      b = next[i];
    if (!a || !b || typeof a !== "object" || typeof b !== "object") return null;
    const identity = (s: any) => [
      String(s.origin || "").toUpperCase(),
      String(s.destination || "").toUpperCase(),
      String(s.departure || "").slice(0, 16),
      String(s.arrival || "").slice(0, 16),
    ];
    const ai = identity(a),
      bi = identity(b);
    if (ai.some((v, n) => !v || v !== bi[n])) return null;
    const merged = { ...a };
    for (const [key, value] of Object.entries(b))
      if (
        value != null &&
        value !== "" &&
        !(Array.isArray(value) && !value.length) &&
        (merged[key] == null ||
          merged[key] === "" ||
          (Array.isArray(merged[key]) && !merged[key].length))
      ) {
        merged[key] = value;
        changed = true;
      }
    out.push(merged);
  }
  return changed ? JSON.stringify(out) : null;
}
export function decodeRow(row: Row): Row {
  const data = { ...row };
  for (const col of ["depart_segments", "return_segments"])
    if (col in data) data[col] = json(data[col]);
  if ("codes" in data) {
    applyCodes(data, data.codes);
    delete data.codes;
  }
  return data;
}
export function rowLeg(d: Row, inbound = false): Leg {
  const p = inbound ? "return_" : "";
  return leg({
    origin_airport: (inbound ? d.destination : d.origin) || "",
    destination_airport: (inbound ? d.origin : d.destination) || "",
    departure: d[p + "departure_time"] || "",
    arrival: d[p + "arrival_time"] || "",
    duration_minutes: d[p + "duration_minutes"] || 0,
    stops: d[p + "stops"],
    airlines: d.airlines || "",
    flight_numbers: inbound ? "" : d.flight_numbers || "",
    segments: (d[inbound ? "return_segments" : "depart_segments"] || []).map(
      segment,
    ),
  });
}
export class FlightStore {
  db: DatabaseSync;
  constructor(public path = "flights.db") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(schema);
    const version = Number(this.get("PRAGMA user_version")!.user_version);
    if (version > migrations.length) {
      this.db.close();
      throw new Error(
        `${path} was written by a newer version of flyscan (schema ${version}, this version knows ${migrations.length})`,
      );
    }
    try {
      for (let n = version; n < migrations.length; n++)
        this.db.exec(
          `BEGIN;\n${migrations[n]}\nPRAGMA user_version = ${n + 1};\nCOMMIT;`,
        );
      this.db.exec("PRAGMA foreign_keys=ON");
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      this.db.close();
      throw e;
    }
  }
  all(sql: string, ...args: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...args);
  }
  get(sql: string, ...args: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...args);
  }
  run(sql: string, ...args: SQLInputValue[]) {
    return this.db.prepare(sql).run(...args);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  plan(
    q: Query,
    sources: string[],
    ttlHours = 6,
    maxRetries = 3,
  ): Record<string, Row> {
    return Object.fromEntries(
      sources.map((source) => {
        const r = this.get(
          "SELECT * FROM fetches WHERE query_key=?",
          queryKey(source, q),
        );
        if (!r)
          return [
            source,
            {
              fetch: true,
              why: "never asked",
              age_hours: null,
              last_fetched: null,
              count: 0,
              retries: 0,
              reason: null,
            },
          ];
        const ms = r.last_fetched
            ? Date.now() - Date.parse(r.last_fetched)
            : NaN,
          age = Number.isFinite(ms) ? ms / 3600000 : null;
        let fetch = true,
          why = "stale";
        if (r.status === "challenge") {
          fetch = false;
          why = "needs a human";
        } else if (r.status === "loading") {
          fetch = age === null || age > 1 / 6;
          why = fetch ? "stuck loading" : "in flight";
        } else if (r.status === "failed") {
          fetch = r.retries < maxRetries;
          why = fetch ? "retrying" : "retries exhausted";
        } else if (r.status === "success" && age !== null && age <= ttlHours) {
          fetch = false;
          why = "fresh";
        }
        return [
          source,
          {
            fetch,
            why,
            age_hours: age === null ? null : round(age),
            last_fetched: r.last_fetched,
            count: r.count,
            retries: r.retries,
            reason: r.reason,
          },
        ];
      }),
    );
  }
  beginFetch(q: Query, source: string): number {
    const key = queryKey(source, q);
    this.run(
      `INSERT INTO fetches(query_key,origin,destination,depart_date,return_date,adults,children,infants,cabin,currency,source,status,reason,last_fetched) VALUES(?,?,?,?,?,?,?,?,?,?,?,'loading',NULL,?) ON CONFLICT(query_key) DO UPDATE SET status='loading',reason=NULL,last_fetched=excluded.last_fetched`,
      key,
      q.origin,
      q.destination,
      q.depart,
      q.ret,
      q.adults,
      q.children,
      q.infants,
      q.cabin,
      q.currency,
      source,
      now(),
    );
    return Number(
      this.get("SELECT id FROM fetches WHERE query_key=?", key)!.id,
    );
  }
  completeFetch(
    id: number,
    offers: Offer[],
    convert: (price: number, currency: string) => number | null = (p, c) =>
      c === "EUR" ? p : null,
  ): number {
    return this.transaction(() => {
      this.run("DELETE FROM offers WHERE fetch_id=?", id);
      let written = 0;
      const seen = new Map<string, number>();
      for (const o of offers) {
        let price = o.price_eur ?? convert(o.price, o.currency);
        if (price === null || !Number.isFinite(price)) continue;
        price = round(price);
        const tid = this.upsertTrip(o.itinerary),
          mark = tid + ":" + o.agent;
        const was = seen.get(mark);
        if (was !== undefined) {
          if (price < was) {
            seen.set(mark, price);
            this.run(
              "UPDATE offers SET price=?,deeplink=?,seen_at=?,codes=? WHERE fetch_id=? AND trip_id=? AND agent=?",
              price,
              o.deeplink,
              o.seen_at || now(),
              offerCodes(o.itinerary),
              id,
              tid,
              o.agent,
            );
          }
          continue;
        }
        seen.set(mark, price);
        this.run(
          "INSERT INTO offers(fetch_id,trip_id,agent,price,deeplink,seen_at,codes) VALUES(?,?,?,?,?,?,?)",
          id,
          tid,
          o.agent,
          price,
          o.deeplink,
          o.seen_at || now(),
          offerCodes(o.itinerary),
        );
        written++;
      }
      this.run(
        "UPDATE fetches SET status='success',reason=NULL,retries=0,count=?,last_fetched=? WHERE id=?",
        written,
        now(),
        id,
      );
      return written;
    });
  }
  failFetch(id: number, reason: string): void {
    this.run(
      "UPDATE fetches SET status='failed',reason=?,retries=retries+1,last_fetched=? WHERE id=?",
      reason.slice(0, 500),
      now(),
      id,
    );
  }
  challengeFetch(id: number, url: string): void {
    this.run(
      "UPDATE fetches SET status='challenge',reason=?,last_fetched=? WHERE id=?",
      url,
      now(),
      id,
    );
  }
  clearChallenges(source: string): number {
    return Number(
      this.run(
        "UPDATE fetches SET status='pending',reason=NULL WHERE source=? AND status='challenge'",
        source,
      ).changes,
    );
  }
  pendingChallenges(): Record<string, string> {
    return Object.fromEntries(
      this.all(
        "SELECT source,reason,MAX(last_fetched) FROM fetches WHERE status='challenge' AND reason IS NOT NULL GROUP BY source",
      ).map((r) => [r.source, r.reason]),
    );
  }
  upsertTrip(i: Itinerary): number {
    const o = i.outbound,
      b = i.inbound,
      q = i.query;
    const values: Row = {
      trip_key: tripKey(i),
      origin: o.origin_airport || q.origin,
      destination: o.destination_airport || q.destination,
      depart_date: q.depart,
      return_date: q.ret,
      departure_time: o.departure,
      arrival_time: o.arrival,
      duration_minutes: o.duration_minutes,
      stops: o.stops,
      return_departure_time: b?.departure ?? null,
      return_arrival_time: b?.arrival ?? null,
      return_duration_minutes: b?.duration_minutes ?? null,
      return_stops: b?.stops ?? null,
      airlines: o.airlines,
      flight_numbers: o.flight_numbers,
      depart_segments: JSON.stringify(o.segments),
      return_segments: JSON.stringify(b?.segments || []),
    };
    const keys = Object.keys(values);
    const result = this.run(
      `INSERT INTO trips(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")}) ON CONFLICT(trip_key) DO NOTHING`,
      ...Object.values(values),
    );
    if (result.changes) return Number(result.lastInsertRowid);
    const row = this.get(
      "SELECT * FROM trips WHERE trip_key=?",
      values.trip_key,
    )!;
    const gaps: Row = {};
    for (const [k, v] of Object.entries(values))
      if (v !== null && v !== "" && v !== "[]" && (!row[k] || row[k] === "[]"))
        gaps[k] = v;
    for (const col of ["depart_segments", "return_segments"]) {
      const merged = mergeSegments(row[col], values[col]);
      if (merged !== null) gaps[col] = merged;
    }
    if (Object.keys(gaps).length)
      this.run(
        `UPDATE trips SET ${Object.keys(gaps)
          .map((k) => k + "=?")
          .join(",")} WHERE id=?`,
        ...Object.values(gaps),
        row.id,
      );
    return row.id;
  }
  offersForSearch(q: Query): Offer[] {
    return this.all(
      `SELECT t.*,o.price,o.deeplink,o.agent,o.seen_at,o.codes,f.source FROM offers o JOIN trips t ON t.id=o.trip_id JOIN fetches f ON f.id=o.fetch_id WHERE f.origin=? AND f.destination=? AND f.depart_date=? AND f.return_date IS ? AND f.adults=? AND f.children=? AND f.infants=? AND f.cabin=?`,
      q.origin,
      q.destination,
      q.depart,
      q.ret,
      q.adults,
      q.children,
      q.infants,
      q.cabin,
    ).map((row) => {
      const d = decodeRow(row);
      return offer({
        itinerary: {
          query: q,
          outbound: rowLeg(d),
          inbound: d.return_departure_time ? rowLeg(d, true) : null,
        },
        source: d.source,
        price: d.price,
        currency: "EUR",
        agent: d.agent || "",
        deeplink: d.deeplink || "",
        price_eur: d.price,
        seen_at: d.seen_at || "",
      });
    });
  }
  browse(filters: Row = {}): Row[] {
    const where = ["f.adults=?", "f.children=?", "f.infants=?", "f.cabin=?"],
      args: SQLInputValue[] = [
        filters.adults ?? 1,
        filters.children ?? 0,
        filters.infants ?? 0,
        filters.cabin || "economy",
      ];
    for (const [key, col, op] of [
      ["origin", "f.origin", "="],
      ["destination", "f.destination", "="],
      ["start", "f.depart_date", ">="],
      ["end", "f.depart_date", "<="],
      ["max_stops", "t.stops", "<="],
    ])
      if (
        filters[key] !== undefined &&
        filters[key] !== null &&
        filters[key] !== ""
      ) {
        where.push(`${col}${op}?`);
        args.push(filters[key]);
      }
    if (filters.match_return !== false) {
      if (filters.ret) {
        where.push("f.return_date>=? AND f.return_date<=?");
        args.push(filters.ret, filters.ret_end || filters.ret);
      } else where.push("f.return_date IS NULL");
    }
    const rows = this.all(
      `SELECT t.*,o.price,o.deeplink,o.agent,o.seen_at,o.codes,f.source,f.last_fetched,f.id AS fetch_id FROM offers o JOIN trips t ON t.id=o.trip_id JOIN fetches f ON f.id=o.fetch_id WHERE ${where.join(" AND ")} ORDER BY o.price`,
      ...args,
    );
    return this.groupTrips(
      rows,
      filters.limit === undefined ? 300 : filters.limit,
    );
  }
  private groupTrips(rows: Row[], limit: number | null): Row[] {
    const trips = new Map<number, Row>(),
      columns = [
        "price",
        "deeplink",
        "agent",
        "seen_at",
        "source",
        "last_fetched",
        "fetch_id",
        "codes",
      ];
    for (const row of rows) {
      const data = decodeRow(row);
      let trip = trips.get(data.id);
      if (!trip) {
        if (limit !== null && trips.size >= limit) continue;
        trip = {
          ...Object.fromEntries(
            Object.entries(data).filter(([k]) => !columns.includes(k)),
          ),
          offers: [],
          last_fetched: null,
        };
        trips.set(data.id, trip);
      }
      this.appendOffer(trip, data);
    }
    return [...trips.values()].sort(
      (a, b) =>
        (a.offers[0]?.price ?? Infinity) - (b.offers[0]?.price ?? Infinity),
    );
  }
  private appendOffer(trip: Row, d: Row): void {
    const o: Row = {
      source: d.source,
      agent: d.agent || "",
      price: d.price,
      deeplink: d.deeplink || "",
      seen_at: d.seen_at,
    };
    if (d.source === "manual") {
      o.entry_id = d.fetch_id;
      o.added_at = d.last_fetched;
    } else if ((d.last_fetched || "") > (trip.last_fetched || ""))
      trip.last_fetched = d.last_fetched;
    trip.offers.push(o);
  }
  findTrips(filters: Row = {}): Row[] {
    const number = String(filters.number || "")
        .replace(/\s/g, "")
        .toUpperCase(),
      digits = (
        /^\d+$/.test(number) ? number : number.slice(2).replace(/\D/g, "")
      ).replace(/^0+/, ""),
      airports = (filters.airports || []) as string[];
    const found = this.all(
      "SELECT * FROM trips ORDER BY depart_date,departure_time",
    )
      .map(decodeRow)
      .filter((t) => {
        if (
          filters.round_trip !== undefined &&
          filters.round_trip !== null &&
          !!t.return_date !== filters.round_trip
        )
          return false;
        const all = [
            ...(t.depart_segments || []),
            ...(t.return_segments || []),
          ],
          numbers = [
            ...all.map((s: any) => s.flight_number || ""),
            ...String(t.flight_numbers || "")
              .split(",")
              .map((s) => s.trim()),
          ];
        if (
          number &&
          !numbers.some(
            (n) =>
              n.startsWith(number) ||
              (digits &&
                (/^\d+$/.test(number) || digits.length >= 3) &&
                n
                  .replace(/^[A-Z0-9]{2,3}?(?=\d)/, "")
                  .replace(/^0+/, "")
                  .startsWith(digits)),
          )
        )
          return false;
        const haystack = JSON.stringify([
          all,
          t.origin,
          t.destination,
          t.departure_time,
        ]);
        if (airports.some((c) => !haystack.includes(`"${c.toUpperCase()}"`)))
          return false;
        if (filters.day && !haystack.includes(filters.day)) return false;
        return true;
      })
      .slice(0, Math.max(1, Math.min(filters.limit ?? 150, 500)));
    for (const t of found) {
      t.offers = [];
      t.last_fetched = null;
      const rows = this.all(
        "SELECT o.*,f.source,f.last_fetched FROM offers o JOIN fetches f ON f.id=o.fetch_id WHERE o.trip_id=? AND f.adults=? AND f.children=? AND f.infants=? AND f.cabin=? ORDER BY o.price",
        t.id,
        filters.adults ?? 1,
        filters.children ?? 0,
        filters.infants ?? 0,
        filters.cabin || "economy",
      );
      for (const d of rows) {
        if (!t.offers.length) applyCodes(t, d.codes);
        this.appendOffer(t, d);
      }
    }
    return found;
  }
  addManual(
    q: Query,
    price: number,
    agent = "",
    deeplink = "",
    key?: string,
    itinerary?: Itinerary,
  ): Row {
    if (!Number.isFinite(price) || price <= 0)
      throw new Error("the price must be more than zero");
    return this.transaction(() => {
      const tid = key
        ? this.get("SELECT id FROM trips WHERE trip_key=?", key)?.id
        : itinerary
          ? this.upsertTrip(itinerary)
          : null;
      if (!tid) throw new Error("that flight is not stored");
      const at = now(),
        result = this.run(
          "INSERT INTO fetches(query_key,origin,destination,depart_date,return_date,adults,children,infants,cabin,currency,source,status,count,last_fetched) VALUES(?,?,?,?,?,?,?,?,?,?,'manual','success',1,?)",
          "manual:" + randomUUID().replaceAll("-", ""),
          q.origin,
          q.destination,
          q.depart,
          q.ret,
          q.adults,
          q.children,
          q.infants,
          q.cabin,
          "EUR",
          at,
        ),
        id = Number(result.lastInsertRowid);
      this.run(
        "INSERT INTO offers(fetch_id,trip_id,agent,price,deeplink,seen_at) VALUES(?,?,?,?,?,?)",
        id,
        tid,
        agent.trim(),
        round(price),
        deeplink.trim(),
        at,
      );
      return {
        entry_id: id,
        trip_key: this.get("SELECT trip_key FROM trips WHERE id=?", tid)!
          .trip_key,
        added_at: at,
      };
    });
  }
  updateManual(id: number, price: number, agent = "", deeplink = ""): boolean {
    if (!Number.isFinite(price) || price <= 0)
      throw new Error("the price must be more than zero");
    return !!this.run(
      "UPDATE offers SET price=?,agent=?,deeplink=?,seen_at=? WHERE fetch_id=(SELECT id FROM fetches WHERE id=? AND source='manual')",
      round(price),
      agent.trim(),
      deeplink.trim(),
      now(),
      id,
    ).changes;
  }
  deleteManual(id: number): boolean {
    return this.transaction(() => {
      const trips = this.all("SELECT trip_id FROM offers WHERE fetch_id=?", id);
      const removed = !!this.run(
        "DELETE FROM fetches WHERE id=? AND source='manual'",
        id,
      ).changes;
      if (removed)
        for (const t of trips)
          this.run(
            "DELETE FROM trips WHERE id=? AND id NOT IN(SELECT trip_id FROM offers)",
            t.trip_id,
          );
      return removed;
    });
  }
  sourceSummary(): Row[] {
    return this.all(
      "SELECT f.source,COUNT(o.id) AS offers,COUNT(DISTINCT o.trip_id) AS itineraries,MIN(o.price) AS cheapest,AVG(o.price) AS average FROM offers o JOIN fetches f ON f.id=o.fetch_id GROUP BY f.source ORDER BY cheapest",
    );
  }
  cheapest(filters: Row = {}): Row[] {
    const where = ["1=1"],
      args: SQLInputValue[] = [];
    for (const [key, column, operator] of [
      ["origin", "f.origin", "="],
      ["destination", "f.destination", "="],
      ["start", "f.depart_date", ">="],
      ["end", "f.depart_date", "<="],
      ["max_stops", "t.stops", "<="],
    ])
      if (
        filters[key] !== undefined &&
        filters[key] !== null &&
        filters[key] !== ""
      ) {
        where.push(`${column}${operator}?`);
        args.push(
          ["origin", "destination"].includes(key)
            ? String(filters[key]).toUpperCase()
            : filters[key],
        );
      }
    if (filters.sources?.length) {
      where.push(`f.source IN(${filters.sources.map(() => "?").join(",")})`);
      args.push(...filters.sources);
    }
    return this.all(
      `SELECT t.*,MIN(o.price) AS price_base,o.agent,o.deeplink,o.codes,f.source FROM offers o JOIN trips t ON t.id=o.trip_id JOIN fetches f ON f.id=o.fetch_id WHERE ${where.join(" AND ")} GROUP BY t.id ORDER BY price_base LIMIT ?`,
      ...args,
      filters.limit ?? 100,
    ).map((row) => {
      const data = decodeRow(row);
      return {
        ...data,
        origin_airport: data.origin,
        destination_airport: data.destination,
        departure: data.departure_time,
        base_currency: "EUR",
      };
    });
  }
  fetchSummary(): Row[] {
    return this.all(
      "SELECT source,status,COUNT(*) AS count FROM fetches GROUP BY source,status ORDER BY source,status",
    );
  }
  stats(): Row {
    return Object.fromEntries(
      ["fetches", "trips", "offers"].map((t) => [
        t,
        this.get(`SELECT COUNT(*) AS count FROM ${t}`)!.count,
      ]),
    );
  }
  purge(before = new Date().toISOString().slice(0, 10)): Row {
    const removed = this.transaction(() => {
      const removed: Row = {};
      removed.fetches = Number(
        this.run("DELETE FROM fetches WHERE depart_date<?", before).changes,
      );
      removed.trips = Number(
        this.run(
          "DELETE FROM trips WHERE id NOT IN(SELECT trip_id FROM offers)",
        ).changes,
      );
      return removed;
    });
    this.db.exec("VACUUM");
    return removed;
  }
  close(): void {
    this.db.close();
  }
}

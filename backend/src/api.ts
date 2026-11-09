import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { extname, relative, resolve, sep } from "node:path";
import { manualItinerary, manualQuery } from "./manual.js";
import { belongsTo, prettyDuration, query, tripPairs } from "./models.js";
import { QueueClosed, QueueFull, Scheduler } from "./scheduler.js";
import { Searches, parseParams, publicLeg } from "./searches.js";
import { allowedSources, labels, webMode } from "./sources.js";
import { FlightStore, rowLeg } from "./store.js";
import { Places, type Data } from "./support.js";
import { version } from "./version.js";

export function storedRow(row: Data): Data {
  const allowed = allowedSources(),
    offers = (row.offers || [])
      .filter((o: Data) => o.source === "manual" || allowed.includes(o.source))
      .map((o: Data) => ({ ...o, currency: "EUR", price_base: o.price })),
    out = rowLeg(row),
    back = row.return_departure_time ? rowLeg(row, true) : null,
    prices = offers.map((o: Data) => o.price).filter((p: any) => p !== null),
    sources = [...new Set(offers.map((o: Data) => o.source))];
  return {
    trip_key: row.trip_key,
    depart_date: row.depart_date,
    route: row.origin + "-" + row.destination,
    departure: out.departure,
    arrival: out.arrival,
    duration: prettyDuration(out.duration_minutes),
    stops: out.stops,
    airlines: out.airlines,
    flight_numbers: out.flight_numbers,
    return_date: row.return_date || "",
    return_departure: back?.departure || "",
    return_arrival: back?.arrival || "",
    return_duration: back ? prettyDuration(back.duration_minutes) : "",
    outbound: publicLeg(out),
    inbound: back ? publicLeg(back) : null,
    best: offers[0] || null,
    sources,
    source_count: sources.length,
    spread:
      prices.length > 1
        ? Math.round((Math.max(...prices) - Math.min(...prices)) * 100) / 100
        : null,
    offers,
  };
}
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export class App {
  searches: Searches;
  private calls: number[] = [];
  constructor(
    public scheduler: Scheduler,
    public places: Places,
    private frontend = resolve(
      process.env.FLYSCAN_FRONTEND || "../desktop/dist",
    ),
  ) {
    this.searches = new Searches(scheduler, places);
    allowedSources();
  }
  createServer(): Server {
    return createServer((req, res) => {
      void this.handle(req, res);
    });
  }
  private json(
    res: ServerResponse,
    value: unknown,
    status = 200,
    headers: Data = {},
  ): void {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    });
    res.end(JSON.stringify(value));
  }
  private async body(req: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 65536) throw new HttpError(413, "request body is too large");
      chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new HttpError(400, "invalid JSON");
    }
  }
  private integer(
    value: unknown,
    fallback: number,
    min = -Infinity,
    max = Infinity,
  ): number {
    const n =
      value === undefined || value === null || value === ""
        ? fallback
        : Number(value);
    if (!Number.isInteger(n) || n < min)
      throw new HttpError(400, "bad filter: expected an integer in range");
    return Math.min(n, max);
  }
  private withStore<T>(path: string | undefined, fn: (s: FlightStore) => T): T {
    const chosen = webMode() ? this.scheduler.store?.path : path;
    if (
      !chosen ||
      resolve(chosen) === resolve(this.scheduler.store?.path || "flights.db")
    ) {
      if (this.scheduler.store) return fn(this.scheduler.store);
    }
    const store = new FlightStore(chosen || "flights.db");
    try {
      return fn(store);
    } finally {
      store.close();
    }
  }
  private input<T>(operation: () => T): T {
    try {
      return operation();
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : String(e));
    }
  }
  private parse(form: Data): Data {
    return this.input(() => parseParams(form, this.scheduler));
  }
  private async selection(p: Data): Promise<Data> {
    const params = this.parse(p),
      [origin, destination] = await Promise.all([
        this.places.resolve(params.origin, params.prefer),
        this.places.resolve(params.destination, params.prefer),
      ]);
    return {
      origin: origin.code,
      destination: destination.code,
      start: params.start,
      end: params.end || params.start,
      ret: params.ret || "",
      ret_end: params.ret_end || params.ret || "",
      adults: params.adults,
      children: params.children,
      infants: params.infants,
      cabin: params.cabin,
      currency: params.currency,
    };
  }
  private authenticate(req: IncomingMessage, path: string, url: URL): void {
    const key = process.env.FLYSCAN_API_KEY;
    if (!key || req.method === "OPTIONS" || !path.startsWith("/v1/")) return;
    let supplied = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : String(req.headers["x-api-key"] || "");
    if (
      !supplied &&
      req.method === "GET" &&
      /^\/v1\/searches\/[^/]+\/events$/.test(path)
    )
      supplied = url.searchParams.get("api_key") || "";
    const a = Buffer.from(supplied),
      b = Buffer.from(key);
    if (a.length !== b.length || !timingSafeEqual(a, b))
      throw new HttpError(401, "unauthorized");
  }
  private hosted(req: IncomingMessage, url: URL, p: any): void {
    if (!webMode()) return;
    const method = req.method || "GET",
      path = url.pathname,
      write = !["GET", "HEAD", "OPTIONS"].includes(method);
    if (write) {
      const time = Date.now();
      this.calls = this.calls.filter((t) => t > time - 60000);
      if (this.calls.length >= 90)
        throw new HttpError(
          429,
          "The service is busy. Please try again shortly.",
        );
      this.calls.push(time);
      const origin = req.headers.origin,
        allowed = (
          process.env.FLYSCAN_PUBLIC_ORIGIN || `http://${req.headers.host}`
        )
          .split(",")
          .map((s) => s.trim());
      if (origin && !allowed.includes(origin))
        throw new HttpError(403, "cross-origin writes are disabled");
    }
    if (path.startsWith("/download/"))
      throw new HttpError(403, "Server exports are not public.");
    if (!path.startsWith("/v1/")) return;
    if (url.searchParams.has("db") || (p && typeof p === "object" && "db" in p))
      throw new HttpError(400, "Database paths cannot be selected remotely.");
    if (path === "/v1/errors" && !write)
      throw new HttpError(403, "Server diagnostics are private.");
    if (path === "/v1/flights") {
      const a = url.searchParams,
        first = a.get("start"),
        last = a.get("end") || first,
        back = a.get("ret"),
        backLast = a.get("ret_end") || back;
      const outward = first
          ? (Date.parse(last!) - Date.parse(first)) / 86400000 + 1
          : 1,
        inward = back
          ? (Date.parse(backLast!) - Date.parse(back)) / 86400000 + 1
          : 1;
      if (
        !Number.isFinite(outward) ||
        !Number.isFinite(inward) ||
        outward > 31 ||
        inward > 31 ||
        outward * inward > 31
      )
        throw new HttpError(400, "Hosted reads support at most 31 trips.");
    }
    if (!write) return;
    if (path === "/v1/queue/selection") return;
    if (
      method === "POST" &&
      ["/v1/searches", "/v1/jobs", "/v1/freshness", "/v1/errors"].includes(path)
    ) {
      if (!p || typeof p !== "object" || Array.isArray(p))
        throw new HttpError(400, "A JSON object is required.");
      if (["/v1/searches", "/v1/jobs"].includes(path)) {
        const state = this.scheduler.snapshot();
        if (state.queued + state.running >= 128)
          throw new HttpError(429, "The search queue is full.");
      }
      return;
    }
    throw new HttpError(
      403,
      "This operation is available only in the desktop app.",
    );
  }
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", "http://localhost"),
      path = url.pathname,
      method = req.method || "GET",
      a: Data = Object.fromEntries(url.searchParams);
    let p: any = {};
    if (webMode()) res.setHeader("X-Content-Type-Options", "nosniff");
    else {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, X-API-Key, Last-Event-ID",
      );
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, PATCH, DELETE, OPTIONS",
      );
      res.setHeader("Access-Control-Expose-Headers", "Last-Event-ID");
    }
    try {
      this.authenticate(req, path, url);
      if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
        p = await this.body(req);
        if (
          (p === null && path !== "/v1/queue/selection") ||
          Array.isArray(p) ||
          (p !== null && typeof p !== "object")
        )
          throw new HttpError(400, "a JSON object is required");
      }
      this.hosted(req, url, p);
      if (method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      let data: any,
        status = 200,
        m: RegExpMatchArray | null = null;
      if (method === "GET" && path === "/v1/version")
        data = { version, mode: webMode() ? "web" : "desktop" };
      else if (method === "GET" && path === "/v1/health")
        data = {
          status: "ok",
          sources: allowedSources(),
          mode: webMode() ? "web" : "desktop",
          scheduler: this.scheduler.snapshot(),
        };
      else if (path === "/v1/errors" && method === "POST") {
        const context =
          p.context &&
          typeof p.context === "object" &&
          !Array.isArray(p.context)
            ? { ...p.context }
            : { detail: p.context };
        context.stack ??= p.stack;
        data = {
          id: this.scheduler.errors.record(
            String(p.where || "ui").startsWith("ui")
              ? String(p.where || "ui")
              : "ui." + p.where,
            String(p.message || "unknown error"),
            context,
          ),
        };
        status = 202;
      } else if (path === "/v1/errors" && method === "GET")
        data = {
          errors: this.scheduler.errors.recent(
            this.integer(a.limit, 20, 0, 200),
            a.where || "",
          ),
          summary: this.scheduler.errors.summary(),
        };
      else if (path === "/v1/errors" && method === "DELETE")
        data = { cleared: this.scheduler.errors.clear() };
      else if (method === "GET" && path === "/v1/sources")
        data = [
          ...allowedSources().map((name) => {
            const s = this.scheduler.source(name);
            return {
              name,
              label: labels[name],
              currency: s.fixedCurrency,
              max_concurrency: s.maxConcurrency,
              min_interval: s.minInterval,
              fetchable: true,
            };
          }),
          {
            name: "manual",
            label: "Entered by hand",
            currency: "EUR",
            fetchable: false,
          },
        ];
      else if (method === "GET" && path === "/v1/jobs")
        data = {
          // view=groups leaves out the flat list, which repeats every source
          // row of query_jobs; the desktop polls this every second.
          ...(a.view === "groups"
            ? {}
            : {
                jobs: this.scheduler
                  .jobs()
                  .map((j) => (a.origin ? { ...j, mine: belongsTo(j, a) } : j)),
              }),
          query_jobs: this.scheduler
            .queryJobs()
            .map((g) => (a.origin ? { ...g, mine: belongsTo(g, a) } : g)),
          scheduler: this.scheduler.snapshot(),
        };
      else if (method === "POST" && path === "/v1/jobs") {
        if (
          !p ||
          typeof p !== "object" ||
          Array.isArray(p) ||
          !allowedSources().includes(p.source)
        )
          throw new HttpError(400, "unknown source");
        if (
          ["origin", "destination", "depart"].some(
            (k) => typeof p[k] !== "string",
          )
        )
          throw new HttpError(
            400,
            "origin, destination and depart are required",
          );
        const q = this.input(() => query({ ...p, ret: p.ret || null }));
        if (
          ![q.origin, q.destination, q.currency].every((c) =>
            /^[A-Z]{3}$/.test(c),
          )
        )
          throw new HttpError(
            400,
            "origin, destination and currency must be three-letter codes",
          );
        if (p.refresh !== undefined && typeof p.refresh !== "boolean")
          throw new HttpError(400, "refresh must be a boolean");
        const sub = this.scheduler.submit(this.scheduler.source(p.source), q, {
          owner: "enqueue-" + randomUUID(),
          refresh: webMode() ? false : !!p.refresh,
        });
        if (sub.id === null) {
          const r = await sub.result;
          data = {
            id: null,
            state: r.error ? "failed" : "done",
            count: r.found ?? r.offers.length,
            error: r.error,
            cached: !r.error,
          };
        } else {
          data = {
            id: sub.id,
            state: this.scheduler.find(sub.id)?.state || "done",
            url: `/v1/jobs/${sub.id}`,
          };
          status = 202;
        }
      } else if (method === "GET" && (m = path.match(/^\/v1\/jobs\/(\d+)$/))) {
        data = this.scheduler.find(+m[1]);
        if (!data) throw new HttpError(404, "no such job");
      } else if (
        method === "POST" &&
        (m = path.match(/^\/v1\/jobs\/(\d+)\/(cancel|promote|retry)$/))
      ) {
        const id = +m[1],
          action = m[2];
        if (action === "cancel") {
          if (this.scheduler.cancelJob(id) === "gone")
            throw new HttpError(404, "no such job");
          data = { id, state: "cancelled" };
        } else if (action === "promote") {
          if (!this.scheduler.promote(id))
            throw new HttpError(409, "not waiting any more");
          data = { id, state: "queued", priority: 0 };
        } else {
          const newId = this.scheduler.retry(id);
          if (newId === null)
            throw new HttpError(409, "still queued or running");
          data = { id: newId, state: "queued" };
        }
      } else if (method === "POST" && path === "/v1/jobs/cancel") {
        if (!p.mine && !p.others)
          data = { cancelled: this.scheduler.cancelQueued() };
        else {
          let count = 0;
          for (const j of this.scheduler.jobs())
            if (
              ["queued", "blocked"].includes(j.state) &&
              belongsTo(j, p) === !!p.mine &&
              this.scheduler.cancelJob(j.id) === "cancelled"
            )
              count++;
          data = { cancelled: count };
        }
      } else if (method === "POST" && path === "/v1/queue/selection") {
        if (p !== null && (typeof p !== "object" || Array.isArray(p)))
          throw new HttpError(400, "a search object or null is required");
        const selection = p ? await this.selection(p) : null;
        if (!webMode()) this.scheduler.select(selection);
        data = { selected: selection };
      } else if (
        method === "POST" &&
        (m = path.match(/^\/v1\/queue\/actions\/(cancel|retry)$/))
      )
        data = this.scheduler.selectionAction(await this.selection(p), m[1]);
      else if (
        method === "POST" &&
        (m = path.match(
          /^\/v1\/query-jobs\/([^/]+)(?:\/sources\/([^/]+))?\/(cancel|retry)$/,
        ))
      ) {
        data = this.scheduler.queryAction(m[1], m[3], m[2]);
        if (!data)
          throw new HttpError(404, "query job or source no longer available");
      } else if (method === "POST" && path === "/v1/searches") {
        const result = this.searches.start(
          this.parse(p),
          !!p.force && !webMode(),
        );
        data = { ...result.job.summary(), joined: result.joined };
        status = result.joined ? 200 : 202;
      } else if (method === "GET" && path === "/v1/searches")
        data = this.searches.list(this.integer(a.limit, 25, 0, 100));
      else if (
        (m = path.match(/^\/v1\/searches\/([^/]+)(?:\/(events|results))?$/))
      ) {
        const job = this.searches.get(m[1]);
        if (!job) throw new HttpError(404, "unknown search");
        if (method === "GET" && m[2] === "events") {
          this.stream(
            req,
            res,
            job.log,
            Math.max(0, Number(req.headers["last-event-id"] || a.after) || 0),
          );
          return;
        }
        if (method === "GET" && m[2] === "results") {
          const days = job.results(),
            limit = this.integer(a.limit, 200, 0, 1000),
            maxStops = a.max_stops ? this.integer(a.max_stops, 0) : null,
            rows = days
              .filter((d) => !a.day || d.day === a.day)
              .flatMap((d) => d.rows)
              .filter(
                (r) =>
                  maxStops === null ||
                  (r.stops !== null && r.stops <= maxStops),
              )
              .sort(
                (x, y) =>
                  (x.best.price_base ?? Infinity) -
                  (y.best.price_base ?? Infinity),
              );
          data = {
            search_id: job.id,
            status: job.status,
            days_done: days.length,
            count: rows.length,
            results: rows.slice(0, limit),
          };
        } else if (method === "GET" && !m[2]) data = job.summary();
        else if (method === "DELETE" && !m[2]) {
          job.cancel();
          data = { ...job.summary(), cancelling: true };
        } else throw new HttpError(404, "not found");
      } else if (method === "GET" && path === "/v1/flights") {
        const requested = a.all === "1" ? 0 : this.integer(a.limit, 300, 0),
          limit = webMode()
            ? Math.min(requested || 1000, 1000)
            : requested
              ? Math.min(requested, 1000)
              : null;
        data = this.withStore(a.db, (store) => {
          const rows = store.browse({
            ...a,
            origin: a.origin?.toUpperCase(),
            destination: a.destination?.toUpperCase(),
            end: a.end || a.start,
            adults: this.integer(a.adults, 1, 1),
            children: this.integer(a.children, 0, 0),
            infants: this.integer(a.infants, 0, 0),
            max_stops: a.max_stops ? this.integer(a.max_stops, 0) : null,
            limit,
            per_pair: a.per_pair ? this.integer(a.per_pair, 0, 0, 100) : 0,
          });
          const results = rows.map(storedRow).filter((r) => r.offers.length);
          return {
            count: results.length,
            results,
            stamp: store.browseStamp(this.browseFilters(a)),
            last_seen: rows.reduce(
              (n, r) => (r.last_fetched > n ? r.last_fetched : n),
              "",
            ),
            sources: a.start ? this.sourceStatus(store, a) : [],
          };
        });
      } else if (method === "GET" && path === "/v1/flights/stamp")
        // Cheap enough to poll: tells a client whether /v1/flights changed.
        data = this.withStore(a.db, (store) => ({
          stamp: store.browseStamp(this.browseFilters(a)),
        }));
      else if (method === "GET" && path === "/v1/trips")
        data = this.withStore(a.db, (store) => ({
          results: store
            .findTrips({
              ...a,
              airports: url.searchParams
                .getAll("airport")
                .filter((c) => /^[A-Za-z]{3}$/.test(c)),
              round_trip:
                a.round === "1" ? true : a.round === "0" ? false : null,
              adults: this.integer(a.adults, 1, 1),
              children: this.integer(a.children, 0, 0),
              infants: this.integer(a.infants, 0, 0),
              limit: this.integer(a.limit, 150, 1, 500),
            })
            .map(storedRow),
        }));
      else if (method === "POST" && path === "/v1/manual-offers") {
        data = this.withStore(p.db, (store) => {
          const i = p.trip_key
            ? undefined
            : this.input(() => manualItinerary(p));
          if (
            p.trip_key &&
            !store.get(
              "SELECT id FROM trips WHERE trip_key=?",
              String(p.trip_key),
            )
          )
            throw new HttpError(404, "that flight is not stored");
          return store.addManual(
            i?.query || this.input(() => manualQuery(p)),
            Number(p.price),
            String(p.agent || ""),
            String(p.deeplink || ""),
            p.trip_key,
            i,
          );
        });
        status = 201;
      } else if (
        (m = path.match(/^\/v1\/manual-offers\/(\d+)$/)) &&
        ["PATCH", "DELETE"].includes(method)
      ) {
        const id = +m[1],
          changed = this.withStore(p.db || a.db, (store) =>
            method === "PATCH"
              ? store.updateManual(
                  id,
                  Number(p.price),
                  String(p.agent || ""),
                  String(p.deeplink || ""),
                )
              : store.deleteManual(id),
          );
        if (!changed) throw new HttpError(404, "no such price");
        data = { entry_id: id };
      } else if (method === "POST" && path === "/v1/freshness")
        data = this.freshness(this.parse(p));
      else if (method === "POST" && path === "/v1/maintenance/purge")
        data = this.withStore(p.db, (store) => ({
          removed: store.purge(p.before),
        }));
      else if (method === "GET" && path === "/v1/challenges")
        data = this.scheduler.challenges.status();
      else if (
        (m = path.match(/^\/v1\/challenges\/([^/]+)(?:\/(solve|cookies))?$/))
      ) {
        const source = m[1];
        if (!allowedSources().includes(source))
          throw new HttpError(404, `unknown source: ${source}`);
        if (method === "DELETE" && !m[2])
          data = { source, cleared: this.scheduler.challenges.clear(source) };
        else if (method === "POST" && m[2] === "cookies") {
          const cookies = p.cookies;
          if (
            !cookies ||
            typeof cookies !== "object" ||
            !Object.keys(cookies).length
          )
            throw new HttpError(
              400,
              "expected a non-empty 'cookies' object or list",
            );
          if (
            Array.isArray(cookies) &&
            cookies.some(
              (c) =>
                !c || typeof c.name !== "string" || typeof c.value !== "string",
            )
          )
            throw new HttpError(400, "invalid cookies");
          data = {
            source,
            stored: this.scheduler.challenges.accept(
              source,
              cookies,
              p.url || "",
            ),
            cleared: true,
          };
        } else if (method === "POST" && m[2] === "solve") {
          if (!this.scheduler.challenges.status().can_solve_here)
            throw new HttpError(501, "this server cannot open a browser");
          if (!this.scheduler.challenges.pending()[source])
            data = { source, status: "already cleared" };
          else {
            data = {
              source,
              status: this.scheduler.challenges.startRecovery(source)
                ? "opening a browser"
                : "already open",
            };
            status = 202;
          }
        } else throw new HttpError(404, "not found");
      } else if (method === "GET" && path === "/v1/places")
        data =
          String(a.q || "").trim().length < 2
            ? []
            : (await this.places.search(a.q)).map(({ detail, ...p }) => p);
      else if (method === "GET" && path === "/v1/rates")
        data = await this.scheduler.rates.get(
          String(a.base || "EUR").toUpperCase(),
        );
      else if (
        (method === "GET" || method === "HEAD") &&
        !path.startsWith("/v1/")
      ) {
        this.file(res, path);
        return;
      } else throw new HttpError(404, "not found");
      this.json(res, data, status);
    } catch (e) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const known =
        e instanceof HttpError ||
        e instanceof QueueFull ||
        e instanceof QueueClosed;
      const status =
        e instanceof HttpError
          ? e.status
          : e instanceof QueueFull
            ? 429
            : e instanceof QueueClosed
              ? 503
              : e instanceof Error &&
                  /^(invalid |bad |cabin |return |end |every |the |a |origin |sources |unknown |source |currency |database |max_workers |hosted )/i.test(
                    e.message,
                  )
                ? 400
                : 500;
      const message = e instanceof Error ? e.message : String(e);
      const logged =
        status === 500
          ? this.scheduler.errors.record("api" + path.replaceAll("/", "."), e, {
              method,
              path,
              body: p,
            })
          : null;
      this.json(
        res,
        {
          error:
            status === 500 && webMode()
              ? "The request could not be completed."
              : message,
          ...(logged ? { logged } : {}),
        },
        status,
        status === 429 ? { "Retry-After": known ? "5" : "60" } : {},
      );
    }
  }
  private file(res: ServerResponse, path: string): void {
    const download = path.startsWith("/download/"),
      root = download ? resolve("out") : this.frontend,
      part = download
        ? path.slice(10)
        : path === "/"
          ? "index.html"
          : decodeURIComponent(path.slice(1)),
      target = resolve(root, part),
      rel = relative(root, target);
    if (
      rel.startsWith(".." + sep) ||
      rel === ".." ||
      resolve(target) === resolve(root) ||
      !existsSync(target) ||
      !statSync(target).isFile() ||
      relative(realpathSync(root), realpathSync(target)).split(sep)[0] === ".."
    ) {
      if (path === "/" && !existsSync(resolve(root, "index.html"))) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          "<h1>Flyscan</h1><p>The API is running. Build the frontend with npm run build --prefix desktop.</p>",
        );
        return;
      }
      throw new HttpError(404, "not found");
    }
    const types: Data = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".ico": "image/x-icon",
      ".woff2": "font/woff2",
    };
    res.writeHead(200, {
      "Content-Type": types[extname(target)] || "application/octet-stream",
      ...(download
        ? {
            "Content-Disposition": `attachment; filename="${part.replace(/["\r\n]/g, "_")}"`,
          }
        : {}),
    });
    res.end(readFileSync(target));
  }
  private browseFilters(a: Data): Data {
    return {
      ...a,
      origin: a.origin?.toUpperCase(),
      destination: a.destination?.toUpperCase(),
      end: a.end || a.start,
      adults: this.integer(a.adults, 1, 1),
      children: this.integer(a.children, 0, 0),
      infants: this.integer(a.infants, 0, 0),
    };
  }
  private stream(
    req: IncomingMessage,
    res: ServerResponse,
    log: import("./searches.js").EventLog,
    after: number,
  ): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    let closed = false;
    const heartbeat = setInterval(() => {
      if (!closed) res.write(": keep-alive\n\n");
    }, 20000);
    const unsubscribe = log.subscribe(after, (event) => {
      if (closed) return;
      if (event === null) {
        clearInterval(heartbeat);
        res.end();
        closed = true;
        return;
      }
      if (res.writableLength > 8 * 1024 * 1024) {
        closed = true;
        res.destroy();
        return;
      }
      res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    res.on("close", () => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    });
  }
  private sourceStatus(store: FlightStore, a: Data): Data[] {
    const rank = [
        "needs a human",
        "retries exhausted",
        "never asked",
        "stale",
        "retrying",
        "stuck loading",
        "in flight",
        "fresh",
      ],
      worst: Data = {};
    for (const [depart, ret] of tripPairs(
      a.start,
      a.end || a.start,
      a.ret,
      a.ret_end,
    )) {
      const q = query({
        ...a,
        origin: a.origin || "",
        destination: a.destination || "",
        depart,
        ret,
        adults: this.integer(a.adults, 1, 1),
        children: this.integer(a.children, 0, 0),
        infants: this.integer(a.infants, 0, 0),
      });
      for (const [source, d] of Object.entries(
        store.plan(q, allowedSources()),
      )) {
        const seen = worst[source];
        if (!seen) worst[source] = { source, ...d };
        else {
          const count = seen.count + d.count,
            age = Math.max(
              seen.age_hours ?? -Infinity,
              d.age_hours ?? -Infinity,
            );
          if (rank.indexOf(d.why) < rank.indexOf(seen.why))
            Object.assign(seen, d);
          seen.count = count;
          seen.age_hours = age === -Infinity ? null : age;
        }
      }
    }
    return allowedSources()
      .filter((s) => worst[s])
      .map((s) => worst[s]);
  }
  private freshness(p: Data): Data {
    const store = this.scheduler.store;
    if (!store) throw new HttpError(409, "no database, so nothing is recorded");
    const days = tripPairs(p.start, p.end, p.ret, p.ret_end).map(
      ([day, ret]) => ({
        day,
        ret,
        sources: Object.entries(
          store.plan(
            query({
              ...p,
              origin: p.origin,
              destination: p.destination,
              depart: day,
              ret,
            }),
            p.sources,
            this.scheduler.ttl,
          ),
        ).map(([source, d]) => ({
          source,
          cached: !d.fetch || d.why !== "never asked",
          fresh: d.why === "fresh",
          why: d.why,
          age_hours: d.age_hours,
          offers: d.count,
        })),
      }),
    );
    const summary = p.sources
      .map((source: string) => {
        const rows = days
            .flatMap((d) => d.sources)
            .filter((s) => s.source === source),
          ages = rows.map((r) => r.age_hours).filter((v) => v !== null);
        return {
          source,
          days_cached: rows.filter((r) => r.cached).length,
          days_total: rows.length,
          days_fresh: rows.filter((r) => r.fresh).length,
          oldest_hours: ages.length ? Math.max(...ages) : null,
          newest_hours: ages.length ? Math.min(...ages) : null,
          offers: rows.reduce((n, r) => n + r.offers, 0),
        };
      })
      .sort(
        (a: Data, b: Data) =>
          (b.oldest_hours ?? -Infinity) - (a.oldest_hours ?? -Infinity),
      );
    return { ttl_hours: this.scheduler.ttl, summary, days };
  }
  async close(force = false): Promise<void> {
    this.searches.cancelAll();
    await this.scheduler.close(force);
  }
}

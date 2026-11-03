/**
 * Typed client for the sidecar's /v1 API.
 *
 * Deliberately framework-free: this is the part worth keeping if the UI is
 * later rebuilt in React, Svelte or anything else. The base URL is injected
 * rather than assumed, because the shell picks a free port at launch.
 */

import { AirportCities } from "./airportCities";

export type SourceName =
  | "ff-kayak"
  | "ff-sky"
  | "ff-kiwi"
  | "momondo"
  | "jetradar"
  /** Prices a person typed in. Shown like any source, never asked. */
  | "manual";

export type Cabin = "economy" | "premiumeconomy" | "business" | "first";

/** One hit from `/places` autocomplete (Travelpayouts). */
export interface PlaceSuggestion {
  code: string;
  name: string;
  country: string;
  kind: string;
  city?: string;
}

/** One question for one source, as the queue describes it. */
export interface QueueJob {
  id: number | null;
  query_id: string;
  source: SourceName;
  route: string;
  depart: string;
  /** Empty for a one-way. */
  ret: string;
  /** "2 adults + 1 child, business", or empty for one adult in economy.
      Part of what makes a trip distinct, not only how it is labelled. */
  params: string;
  owner: string;
  /** 0 is the search on screen; higher numbers wait behind it. */
  priority: number;
  state: "queued" | "running" | "done" | "failed" | "blocked" | "cancelled";
  queue_state: "queued" | "running" | "retry_wait" | "waiting_action" | "done" | "failed" | "timed_out" | "cancelled";
  status: "waiting" | "running" | "retrying" | "rate_limited" | "waiting_input" | "completed" | "cached" | "failed" | "timed_out" | "cancelled" | "cancelling" | "stopping";
  worker_busy: boolean;
  retry_in: number | null;
  ready_in: number | null;
  wait_reason: string;
  action: { kind: string; message: string; url: string } | null;
  /** Whether this job belongs to the search that asked. Absent if none did. */
  mine?: boolean;
  /** Times this trip has been asked of this source, counted by the panel. */
  attempts?: number;
  queued_at: string;
  started_at: string | null;
  /** Seconds running — ticking while it runs, fixed once it is done. */
  elapsed: number | null;
  /** Seconds spent waiting to start. */
  waited: number;
  count: number;
  error: string;
}

export interface QueryJob {
  id: string;
  origin: string;
  destination: string;
  depart: string;
  ret: string;
  adults: number;
  children: number;
  infants: number;
  cabin: Cabin;
  currency: string;
  mine: boolean;
  sources: QueueJob[];
  created_at: string;
}

export interface QueueState {
  jobs: QueueJob[];
  query_jobs: QueryJob[];
  scheduler: {
    queued: number;
    running: number;
    max_workers: number;
    cached: number;
    scraped: number;
    shared: number;
  };
}

export interface QueueActionResult {
  cancelled: number;
  retried: number;
  skipped: number;
  errors: { source: string; error: string }[];
}

export interface SearchRequest {
  origin: string;
  destination: string;
  /** First departure date, and the last one when a range is being searched. */
  start: string;
  end?: string;
  /** First return date, and the last one. Absent for a one-way. */
  ret?: string;
  ret_end?: string;
  adults?: number;
  children?: number;
  infants?: number;
  cabin?: Cabin;
  currency?: string;
  base_currency?: string;
  sources?: SourceName[];
  /** Skip joining an identical search already running. */
  force?: boolean;
  /** Ask every source again, even ones that answered recently. */
  refresh?: boolean;
}

/**
 * One seller's price.
 *
 * Numbers only, deliberately: `price_base` is EUR — the one currency the
 * database stores — and `price`/`currency` are what the seller actually quoted.
 * Formatting happens on this side, so switching display currency is a
 * re-render rather than another scrape.
 */
export interface Offer {
  source: SourceName;
  agent: string;
  price: number;
  currency: string;
  price_base: number | null;
  deeplink: string;
  manual_price?: boolean;
  original_price_base?: number | null;
  /** A correction the source has since requoted: kept to reapply, not applied. */
  stale_price_base?: number;
  /** When the correction, applied or set aside, was made. */
  corrected_at?: string;
  /** When the source quoted this price, or the person typed or changed it. */
  seen_at?: string;
  /** Set on prices typed in by hand: what editing or deleting one needs. */
  entry_id?: number;
  added_at?: string;
}

export interface Segment {
  carrier: string;
  carrier_name: string;
  flight_number: string;
  /** Who flies it when the seller sells another airline's flight (a codeshare). */
  operating_carrier_name?: string;
  operating_flight_number?: string;
  origin: string;
  destination: string;
  departure: string;
  arrival: string;
  duration: string;
}

/** One direction of the trip, with its connections. */
export interface Leg {
  origin_airport: string;
  destination_airport: string;
  departure: string;
  arrival: string;
  duration: string;
  stops: number | null;
  airlines: string;
  flight_numbers: string;
  segments: Segment[];
}

export interface FlightRow {
  trip_key: string;
  depart_date: string;
  route: string;
  departure: string;
  arrival: string;
  duration: string;
  stops: number | null;
  airlines: string;
  flight_numbers: string;
  /** The return date searched for, even when no inbound leg was described. */
  return_date: string;
  return_departure: string;
  return_arrival: string;
  /** How long the way back takes, when the seller described it. */
  return_duration: string;
  /** Carried on every row so the detail panel opens without a round trip. */
  outbound: Leg;
  inbound: Leg | null;
  best: Offer;
  sources: SourceName[];
  source_count: number;
  /** Gap between the cheapest and dearest quote for the same seat, in EUR. */
  spread: number | null;
  offers: Offer[];
}

/** A hand-entered price. Always EUR, like everything stored. */
export interface ManualPrice { price: number; agent?: string; deeplink?: string }

/** One flight typed in, in local airport time. */
export interface ManualSegment {
  flight_number: string;
  carrier_name?: string;
  origin: string;
  destination: string;
  departure: string;
  arrival: string;
  duration_minutes: number | null;
}

/**
 * A hand-entered price and the search it belongs to: on a stored flight
 * (`trip_key` and its dates) or on typed flights.
 */
export interface ManualOfferRequest extends ManualPrice {
  origin: string;
  destination: string;
  adults: number;
  children: number;
  infants: number;
  cabin: Cabin;
  trip_key?: string;
  depart?: string;
  ret?: string | null;
  outbound?: ManualSegment[];
  inbound?: ManualSegment[];
}

export type SearchStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface SearchSummary {
  search_id: string;
  status: SearchStatus;
  params: Record<string, unknown>;
  created_at: string;
  finished_at: string | null;
  error: string;
  last_seq: number;
  days_done: number;
  offers?: number;
  itineraries?: number;
  errors?: number;
  csv: string | null;
  json: string | null;
  /** True when this reused a search that was already running. */
  joined?: boolean;
}

/** Where an answer came from — a scrape, the cache, or another live search. */
export type ResultOrigin = "scrape" | "cache" | "shared";

interface ScrapeIdentity {
  source: SourceName;
  day: string;
  ret: string | null;
  scrape_id: number | null;
  attempt: number;
}

export type SearchEvent =
  | { event: "resolved"; seq: number; origin: string; destination: string }
  | { event: "start"; seq: number; days: number; sources: SourceName[]; jobs: number }
  | ({ event: "source_start"; seq: number } & ScrapeIdentity)
  | ({
      event: "source_done";
      seq: number;
      source: SourceName;
      day: string;
      count: number;
      error: string;
      elapsed: number;
      origin: ResultOrigin;
      /** How old a cached answer is. Null when it was just fetched. */
      age_hours: number | null;
      url: string;
    } & ScrapeIdentity)
  | ({ event: "source_retry"; seq: number; message: string } & ScrapeIdentity)
  | ({ event: "challenge_required"; seq: number; url: string } & ScrapeIdentity)
  | {
      /** Results so far for a date, emitted as each source lands. */
      event: "day_partial";
      seq: number;
      day: string;
      ret: string | null;
      offers: number;
      itineraries: number;
      sources_done: number;
      sources_total: number;
      rows: FlightRow[];
    }
  | {
      /** One trip finished — every source has answered for it. */
      event: "day_done";
      seq: number;
      day: string;
      /** The return date this departure was priced against, if any. */
      ret: string | null;
      /** Which trip this is, and how many the search covers. Trips are
          released in order, so `index` is how far along the search is. */
      index: number;
      total: number;
      offers: number;
      itineraries: number;
      elapsed: number;
      errors: Record<string, string>;
      rows: FlightRow[];
    }
  | { event: "error"; seq: number; message: string }
  | { event: "done"; seq: number; total: number; itineraries: number; errors: number };

/** Where one source stands for a search, without asking it anything. */
export interface SourceStatus {
  source: SourceName;
  /** never asked · stale · fresh · retrying · retries exhausted · needs a human · in flight · stuck loading */
  why: string;
  /** True when a scrape would actually contact this source. */
  fetch: boolean;
  age_hours: number | null;
  last_fetched: string | null;
  count: number;
  retries: number;
  reason: string | null;
}

export interface PendingChallenge {
  source: SourceName;
  url: string;
  /** A browser is already open for this one. */
  solving?: boolean;
  error?: string | null;
}

export class FlyscanApi {
  readonly airportCities = new AirportCities((code) => this.places(code));
  private placeQueries = new Map<string, { until: number; promise: Promise<PlaceSuggestion[]> }>();
  constructor(private readonly base: string, private readonly apiKey?: string) {}

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.base}/v1${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        ...init?.headers,
      },
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(detail.error ?? `HTTP ${response.status}`);
    }
    return response.json() as Promise<T>;
  }

  /** A lost queue connection must not strand the poll loop or an action. */
  private async queueJson<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 8000);
    try {
      return await this.json<T>(path, { ...init, cache: "no-store", signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw new Error("Queue request timed out. Checking its latest status.");
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  version() {
    return this.json<{ version: string; mode: "desktop" | "web" }>("/version");
  }

  health() {
    return this.json<{ status: string; sources: SourceName[] }>("/health");
  }

  /** Conversion table for display only — it never touches stored prices. */
  rates(base = "EUR") {
    return this.json<{
      base: string;
      provider: string;
      fetched_at: string;
      rates: Record<string, number>;
    }>(`/rates?base=${base}`);
  }

  /**
   * Tell the sidecar something went wrong out here.
   *
   * A browser cannot write to the error log, and an error that only ever
   * reached a console nobody had open may as well not have happened. Fails
   * silently on purpose: a reporting failure must not become a second error
   * to report.
   */
  report(where: string, message: string, context?: Record<string, unknown>) {
    return this.json<{ id: string }>("/errors", {
      method: "POST",
      body: JSON.stringify({ where, message, context }),
    }).catch(() => undefined);
  }

  /**
   * The scrape queue. Memory only — no database, no source, cheap to poll.
   *
   * Given a search, every job comes back marked as belonging to it or not, so
   * the page can tell its own work from a search someone left running.
   */
  queue(mine?: SearchRequest) {
    if (!mine) return this.queueJson<QueueState>("/jobs");
    const query = new URLSearchParams({
      origin: mine.origin, destination: mine.destination, start: mine.start,
      end: mine.end ?? mine.start,
      adults: String(mine.adults ?? 1), children: String(mine.children ?? 0),
      infants: String(mine.infants ?? 0), cabin: mine.cabin ?? "economy",
      currency: mine.currency ?? "EUR",
    });
    if (mine.ret) query.set("ret", mine.ret);
    if (mine.ret_end) query.set("ret_end", mine.ret_end);
    return this.queueJson<QueueState>(`/jobs?${query}`);
  }

  /** cancel a waiting job · promote it to the front · retry a finished one. */
  jobAction(id: number, action: "cancel" | "promote" | "retry") {
    return this.queueJson<{ id: number; state: string }>(
      `/jobs/${id}/${action}`, { method: "POST" },
    );
  }

  selectQueueQuery(selection: SearchRequest | null) {
    return this.queueJson<{ selected: SearchRequest | null }>("/queue/selection", {
      method: "POST", body: JSON.stringify(selection),
    });
  }

  queryJobAction(id: string, action: "cancel" | "retry", source?: string) {
    const path = `/query-jobs/${encodeURIComponent(id)}`
      + (source ? `/sources/${encodeURIComponent(source)}` : "");
    return this.queueJson<QueueActionResult>(
      `${path}/${action}`, { method: "POST" },
    );
  }

  queueRangeAction(selection: SearchRequest, action: "cancel" | "retry") {
    return this.queueJson<QueueActionResult & { groups: number }>(`/queue/actions/${action}`, {
      method: "POST", body: JSON.stringify(selection),
    });
  }

  /**
   * Drop what is waiting. Whatever is running is left to finish.
   *
   * Scoped by `which`: this search's waiting fetches, or everyone else's.
   * Without a search, everything waiting goes.
   */
  cancelQueue(search?: SearchRequest, which: "mine" | "others" = "others") {
    return this.queueJson<{ cancelled: number }>("/jobs/cancel", {
      method: "POST",
      body: JSON.stringify(search ? { ...search, [which]: true } : {}),
    });
  }

  sources() {
    return this.json<
      { name: SourceName; label: string; currency: string | null; fetchable?: boolean }[]
    >("/sources");
  }

  /** Store a price found by hand, on a stored flight or on one typed in. */
  addManualOffer(entry: ManualOfferRequest) {
    return this.json<{ entry_id: number; trip_key: string; added_at: string }>("/manual-offers", {
      method: "POST", body: JSON.stringify(entry),
    });
  }

  /**
   * Stored trips from every search that mention a flight number, airports or
   * a day. Loose by design and capped; prices are only for the party given.
   */
  findTrips(filters: { number?: string; airports?: string[]; day?: string; roundTrip?: boolean;
    adults: number; children: number; infants: number; cabin: Cabin }, signal?: AbortSignal) {
    const query = new URLSearchParams({
      adults: String(filters.adults), children: String(filters.children),
      infants: String(filters.infants), cabin: filters.cabin,
    });
    if (filters.number) query.set("number", filters.number);
    for (const code of filters.airports ?? []) query.append("airport", code);
    if (filters.day) query.set("day", filters.day);
    if (filters.roundTrip !== undefined) query.set("round", filters.roundTrip ? "1" : "0");
    return this.json<{ results: FlightRow[] }>(`/trips?${query}`, { signal });
  }

  updateManualOffer(id: number, change: ManualPrice) {
    return this.json<{ entry_id: number }>(`/manual-offers/${id}`, { method: "PATCH", body: JSON.stringify(change) });
  }

  deleteManualOffer(id: number) {
    return this.json<{ entry_id: number }>(`/manual-offers/${id}`, { method: "DELETE" });
  }

  places(term: string) {
    const query = term.trim(), key = query.toLowerCase(), cached = this.placeQueries.get(key);
    if (!query) return Promise.resolve([]);
    if (cached && cached.until > Date.now()) return cached.promise;
    const entry = { until: Infinity, promise: Promise.resolve([] as PlaceSuggestion[]) };
    entry.promise = this.json<PlaceSuggestion[]>(`/places?q=${encodeURIComponent(query)}`).then((matches) => {
      this.airportCities.remember(matches);
      entry.until = Date.now() + 5 * 60_000;
      // Keep pending requests deduplicated even while pruning old query results.
      for (const [oldKey, old] of this.placeQueries) {
        if (old.until !== Infinity && (old.until <= Date.now() || this.placeQueries.size > 128)) this.placeQueries.delete(oldKey);
      }
      return matches;
    }).catch((error) => { this.placeQueries.delete(key); throw error; });
    this.placeQueries.set(key, entry);
    return entry.promise;
  }

  /**
   * What the database already knows — no scraping, no rate limit.
   *
   * This is the read side, and it is why editing the form can fill the table
   * instantly: asking the sources is a separate, deliberate act.
   */
  storedFlights(request: SearchRequest, limit = 0) {
    const query = new URLSearchParams({
      origin: request.origin,
      destination: request.destination,
      start: request.start,
      adults: String(request.adults ?? 1),
      children: String(request.children ?? 0),
      infants: String(request.infants ?? 0),
      cabin: request.cabin ?? "economy",
      limit: String(limit === 0 ? 1000 : limit),
    });
    // Older sidecars ignore `all` and still return a bounded, usable list.
    if (limit === 0) query.set("all", "1");
    if (request.end) query.set("end", request.end);
    // Sent even when empty: a blank return means "one-way only", not "either".
    if (request.ret) query.set("ret", request.ret);
    if (request.ret_end) query.set("ret_end", request.ret_end);
    return this.json<{
      count: number;
      results: FlightRow[];
      last_seen: string;
      sources: SourceStatus[];
    }>(`/flights?${query}`);
  }

  createSearch(request: SearchRequest) {
    return this.json<SearchSummary>("/searches", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  getSearch(id: string) {
    return this.json<SearchSummary>(`/searches/${id}`);
  }

  results(id: string, opts: { limit?: number; maxStops?: number; day?: string } = {}) {
    const query = new URLSearchParams();
    if (opts.limit) query.set("limit", String(opts.limit));
    if (opts.maxStops !== undefined) query.set("max_stops", String(opts.maxStops));
    if (opts.day) query.set("day", opts.day);
    return this.json<{ status: SearchStatus; count: number; results: FlightRow[] }>(
      `/searches/${id}/results?${query}`,
    );
  }

  cancel(id: string) {
    return this.json<SearchSummary>(`/searches/${id}`, { method: "DELETE" });
  }

  challenges() {
    return this.queueJson<{
      pending: PendingChallenge[];
      /** Whether the server can open a browser itself. */
      can_solve_here: boolean;
      mode?: "web" | "desktop";
      /** A page streaming the server's display, where a check it opens can be solved. */
      viewer_url?: string;
    }>("/challenges");
  }

  /**
   * Ask the server to open the check in a browser it owns.
   *
   * Only useful when the server is on this machine — the browser appears
   * wherever the server is. Returns as soon as it has started: solving takes as
   * long as a person takes, so watch `challenges()` for the source to go.
   */
  solveChallenge(source: SourceName) {
    return this.queueJson<{ source: string; status: string }>(
      `/challenges/${source}/solve`, { method: "POST" },
    );
  }

  /** Hand back the cookies a person earned by clearing a challenge. */
  submitChallengeCookies(source: SourceName, cookies: { name: string; value: string }[], url = "") {
    return this.queueJson<{ source: string; stored: number; cleared: boolean }>(
      `/challenges/${source}/cookies`,
      { method: "POST", body: JSON.stringify({ cookies, url }) },
    );
  }

  /**
   * Live progress for a search.
   *
   * Events are numbered and the log is replayable, so a dropped connection
   * resumes rather than starting blank — EventSource sends Last-Event-ID for
   * us on reconnect. Returns the source so the caller can close it.
   */
  streamSearch(
    id: string,
    onEvent: (event: SearchEvent) => void,
    onError?: (error: Event) => void,
  ): EventSource {
    const auth = this.apiKey ? `?api_key=${encodeURIComponent(this.apiKey)}` : "";
    const stream = new EventSource(`${this.base}/v1/searches/${id}/events${auth}`);
    stream.onmessage = (message) => onEvent(JSON.parse(message.data) as SearchEvent);
    if (onError) stream.onerror = onError;
    return stream;
  }
}

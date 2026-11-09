/**
 * Typed client for the sidecar's /v1 API.
 *
 * Deliberately framework-free: this is the part worth keeping if the UI is
 * later rebuilt in React, Svelte or anything else. The base URL is injected
 * rather than assumed, because the shell picks a free port at launch.
 */

import { AirportCities } from "./airportCities";

import type { SourceName, Cabin, PlaceSuggestion, QueueState, QueueActionResult, SearchRequest, FlightRow, ManualPrice, ManualOfferRequest, SearchStatus, SearchSummary, SearchEvent, SourceStatus, PendingChallenge } from "../../shared/contracts";
export type * from "../../shared/contracts";

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
    // Only the grouped view is read; the flat list doubled every poll.
    if (!mine) return this.queueJson<QueueState>("/jobs?view=groups");
    const query = new URLSearchParams({
      view: "groups",
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

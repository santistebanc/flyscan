/** The /v1 wire contract shared by the backend and desktop client. */

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
  queue_state:
    | "queued"
    | "running"
    | "retry_wait"
    | "waiting_action"
    | "done"
    | "failed"
    | "timed_out"
    | "cancelled";
  status:
    | "waiting"
    | "running"
    | "retrying"
    | "rate_limited"
    | "waiting_input"
    | "completed"
    | "cached"
    | "failed"
    | "timed_out"
    | "cancelled"
    | "cancelling"
    | "stopping";
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
export interface ManualPrice {
  price: number;
  agent?: string;
  deeplink?: string;
}

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

export type SearchStatus =
  "queued" | "running" | "done" | "failed" | "cancelled";

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
  | {
      event: "start";
      seq: number;
      days: number;
      sources: SourceName[];
      jobs: number;
    }
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
  | {
      event: "done";
      seq: number;
      total: number;
      itineraries: number;
      errors: number;
    };

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

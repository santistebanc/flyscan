/**
 * The search engine behind the UI, and the one place the read/scrape split
 * is enforced.
 *
 * `loadStored` answers from the database and never contacts a source, so the
 * table can fill in the moment the form changes. `runSearch` is the only path
 * that scrapes, and it only ever runs from a deliberate press of the button.
 *
 * It also keeps one view of each source, merged from two places: what the
 * database says about this search, overlaid with whatever is happening right
 * now if a scrape is running. That merged list is the entire progress display —
 * there is no log, because "ff-sky: 183 offers in 33s" is the same sentence
 * that source's own row already says, in a place that scrolls away.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  FlightRow,
  FlightScraperApi,
  SearchEvent,
  SearchRequest,
  SourceName,
  SourceStatus,
} from "./api";

import { emptyProgress, reduceProgress, type LiveState } from "./progress";

/** One source as the UI shows it: stored state, overlaid with live progress. */
export interface SourceView {
  source: string;
  /** ready · never run · stale · failed · gave up · blocked · fetching */
  label: string;
  tone: "ok" | "warn" | "bad" | "muted" | "busy";
  count: number | null;
  /** Hours since this source last answered, or null if it never has. */
  ageHours: number | null;
  /** Seconds: elapsed so far while fetching, or how long it took. */
  seconds: number | null;
  running: boolean;
  reason: string | null;
  /** True when a scrape would actually contact this source. */
  pending: boolean;
}

export type Freshness =
  | { kind: "none" }
  | { kind: "empty" }
  | { kind: "stored"; hours: number }
  | { kind: "scraped"; oldestCacheHours: number | null };

function sortRows(byKey: Map<string, FlightRow>): FlightRow[] {
  return [...byKey.values()]
    .sort((a, b) => (a.best?.price_base ?? Infinity) - (b.best?.price_base ?? Infinity));
}

const STORED_LABELS: Record<string, { label: string; tone: SourceView["tone"] }> = {
  "fresh": { label: "ready", tone: "ok" },
  "never asked": { label: "never run", tone: "muted" },
  "stale": { label: "stale", tone: "warn" },
  "retrying": { label: "failed", tone: "bad" },
  "retries exhausted": { label: "gave up", tone: "bad" },
  "needs a human": { label: "blocked", tone: "bad" },
  "in flight": { label: "fetching", tone: "busy" },
  "stuck loading": { label: "interrupted", tone: "warn" },
};

/** Stored state and live progress, reconciled into what a row should say. */
function merge(stored: SourceStatus[], live: Record<string, LiveState>): SourceView[] {
  const names = stored.length ? stored.map((s) => s.source as string) : Object.keys(live);

  return names.map((source) => {
    const base = stored.find((s) => s.source === source);
    const now = live[source];

    if (now) {
      if (now.phase === "waiting") {
        return { source, label: "waiting", tone: "muted", count: null,
          ageHours: base?.age_hours ?? null, seconds: null, running: false,
          reason: now.error || null, pending: false };
      }
      if (now.phase === "fetching") {
        return {
          source, label: "fetching", tone: "busy", count: null,
          ageHours: base?.age_hours ?? null,
          seconds: now.startedAt ? (Date.now() - now.startedAt) / 1000 : 0,
          running: true, reason: null, pending: false,
        };
      }
      if (now.phase === "failed") {
        return {
          source, label: "failed", tone: "bad", count: null,
          ageHours: base?.age_hours ?? null, seconds: now.elapsed,
          running: false, reason: now.error, pending: true,
        };
      }
      if (now.phase === "challenge") {
        return {
          source, label: "blocked", tone: "bad", count: null,
          ageHours: base?.age_hours ?? null, seconds: null, running: false,
          reason: now.error || "needs you to confirm you are human", pending: false,
        };
      }
      return {
        source,
        label: now.phase === "skipped" ? "up to date" : "ready",
        tone: "ok",
        count: now.count,
        ageHours: now.phase === "skipped" ? now.ageHours : 0,
        seconds: now.elapsed,
        running: false, reason: null, pending: false,
      };
    }

    if (!base) {
      return {
        source, label: "never run", tone: "muted", count: null, ageHours: null,
        seconds: null, running: false, reason: null, pending: true,
      };
    }

    const shown = STORED_LABELS[base.why] ?? { label: base.why, tone: "muted" as const };
    return {
      source,
      label: shown.label,
      tone: shown.tone,
      count: base.count || null,
      ageHours: base.age_hours,
      seconds: null,
      running: base.why === "in flight",
      reason: base.reason,
      pending: base.fetch,
    };
  });
}

/**
 * @param onChallenge Called when a source turns out to be blocked mid-search,
 *   so the banner can refresh — it reads its list from `/challenges`, which was
 *   last fetched at connect.
 */
export function useFlights(api: FlightScraperApi | null, onChallenge?: () => void) {
  const [rows, setRows] = useState<FlightRow[]>([]);
  const [total, setTotal] = useState(0);
  const [freshness, setFreshness] = useState<Freshness>({ kind: "none" });
  const [running, setRunning] = useState(false);
  const [loadingStored, setLoadingStored] = useState(false);
  const [summary, setSummary] = useState("");
  /**
   * Trips finished out of trips asked for.
   *
   * The job counts these for us — `start` says how many there are and every
   * `day_done` says which one just landed — so the header can report progress
   * through the search itself rather than through the sources. A search of
   * three departures against three returns is nine trips, and "4 of 9" says
   * far more about how far along it is than "3 of 5 sources" ever did.
   */
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  /**
   * Fetches: one source asked about one trip, which is the unit of work the
   * scheduler actually queues.
   *
   * The job counts them for us. `start` carries `jobs` — every trip against
   * every source — and each `source_done` is one of them landing, whether it
   * was scraped, served from the ledger or shared with another search. A
   * search of four trips across five sources is twenty fetches, and knowing
   * that twelve are done and two failed says more about what is left than any
   * count of sources or trips can.
   */
  const [execution, setExecution] = useState(emptyProgress);
  const { counts: fetches, sources: live } = execution;
  const [stored, setStored] = useState<SourceStatus[]>([]);
  /** Bumped while anything is fetching, to tick the elapsed timers. */
  const [, setTick] = useState(0);

  const byKey = useRef(new Map<string, FlightRow>());
  const stream = useRef<EventSource | null>(null);
  const searchId = useRef<string | null>(null);
  /** Guards against a late response overwriting a newer one. */
  const token = useRef(0);
  const searching = useRef(false);
  const storedRead = useRef<{ key: string; token: number; api: FlightScraperApi; result: Promise<void> } | null>(null);
  /**
   * Whether the view on screen has had its first answer from the database.
   * Only that first read is "loading": the refreshes after it run every few
   * seconds, and showing them would blink an empty list into a spinner and
   * back each time.
   */
  const answered = useRef(false);

  const sources = merge(stored, live);
  const anyRunning = sources.some((s) => s.running);

  // Only tick while something is in flight: a timer that runs forever
  // re-renders the whole table once a second for nothing.
  useEffect(() => {
    if (!anyRunning) return;
    const timer = window.setInterval(() => setTick((n) => n + 1), 250);
    return () => window.clearInterval(timer);
  }, [anyRunning]);

  const publish = useCallback(() => {
    setRows(sortRows(byKey.current));
    setTotal(byKey.current.size);
  }, []);

  useEffect(() => () => stream.current?.close(), []);

  const selectView = useCallback((awaitingStored = false) => {
    searching.current = false;
    token.current++;
    storedRead.current = null;
    answered.current = false;
    stream.current?.close();
    stream.current = null;
    searchId.current = null;
    setRunning(false);
    setLoadingStored(awaitingStored);
    byKey.current.clear();
    publish();
    setStored([]);
    setExecution(emptyProgress());
    setProgress({ done: 0, total: 0 });
    setFreshness({ kind: "none" });
    setSummary("");
  }, [publish]);

  /** Read the database. No source is contacted. */
  const loadStored = useCallback(async (request: SearchRequest) => {
    if (!api || searching.current) return;
    const key = JSON.stringify(request);
    const pending = storedRead.current;
    // A slow initial read must survive the next poll. Supersede reads only
    // when the selected query changes, not when the same query refreshes.
    if (pending?.api === api && pending.token === token.current && pending.key === key) {
      return pending.result;
    }
    const mine = ++token.current;
    if (!answered.current) setLoadingStored(true);
    const result = (async () => {
      try {
        const answer = await api.storedFlights(request);
        if (mine !== token.current) return;   // the form moved on
        byKey.current = new Map(answer.results.map((row) => [row.trip_key, row]));
        publish();
        setStored(answer.sources ?? []);
        setExecution(emptyProgress());                          // the live view belongs to one run
        if (!answer.results.length) {
          setFreshness({ kind: "empty" });
          return;
        }
        const seen = Date.parse(answer.last_seen);
        setFreshness({
          kind: "stored",
          hours: Number.isFinite(seen) ? (Date.now() - seen) / 3_600_000 : NaN,
        });
      } catch {
        /* each source's own row already says what is known */
      }
    })();
    storedRead.current = { key, token: mine, api, result };
    try {
      await result;
    } finally {
      if (mine === token.current) {
        answered.current = true;
        setLoadingStored(false);
      }
      if (storedRead.current?.result === result) storedRead.current = null;
    }
  }, [api, publish]);

  const finish = useCallback(() => {
    searching.current = false;
    stream.current?.close();
    stream.current = null;
    setRunning(false);
  }, []);

  const handle = useCallback((event: SearchEvent) => {
    setExecution((was) => reduceProgress(was, event));
    switch (event.event) {
      case "start":
        setProgress({ done: 0, total: event.days });
        break;
      case "challenge_required":
        onChallenge?.();
        break;
      case "day_partial":
        for (const row of event.rows) byKey.current.set(row.trip_key, row);
        publish();
        break;
      case "day_done":
        for (const row of event.rows) byKey.current.set(row.trip_key, row);
        // Trips are released in order, so the index of the one that just
        // landed is how many are behind us.
        setProgress({ done: event.index, total: event.total });
        publish();
        break;
      case "done":
        setSummary(`${event.itineraries} distinct flights from ${event.total} offers`);
        finish();
        break;
    }
  }, [finish, publish, onChallenge]);

  /** Ask the sources. The only path that scrapes. */
  const runSearch = useCallback(async (request: SearchRequest) => {
    if (!api) return;
    searching.current = true;
    const mine = ++token.current; // abandon any stored read still in flight
    setLoadingStored(false);
    stream.current?.close();
    stream.current = null;

    setSummary("");
    setExecution(emptyProgress());
    setFreshness({ kind: "scraped", oldestCacheHours: null });
    setRunning(true);

    try {
      const search = await api.createSearch(request);
      if (mine !== token.current) return;
      searchId.current = search.search_id;
      stream.current = api.streamSearch(search.search_id,
        (event) => { if (mine === token.current) handle(event); },
        () => { if (mine === token.current) finish(); });
    } catch (exc) {
      if (mine !== token.current) return;
      void api.report(
        "search",
        exc instanceof Error ? exc.message : String(exc),
        {
          route: `${request.origin}-${request.destination}`,
          start: request.start, end: request.end,
          ret: request.ret, ret_end: request.ret_end,
          adults: request.adults, cabin: request.cabin,
        },
      );
      finish();
    }
  }, [api, finish, handle]);

  const cancel = useCallback(async () => {
    if (api && searchId.current) await api.cancel(searchId.current);
  }, [api]);

  return {
    rows, total, freshness, running, loadingStored, summary, sources, progress, fetches,
    selectView, loadStored, runSearch, cancel,
    /** Sources a scrape would actually contact. */
    pending: sources.filter((s) => s.pending).map((s) => s.source as SourceName),
  };
}

/**
 * The whole UI: a fixed header of search controls, one list of every flight
 * found, and a side panel showing either the queue or the selected flight.
 *
 * One rule shapes it: editing the form reads the **database** and never contacts
 * a source; only the scrape button contacts one. That holds for the party and
 * cabin too — changing them re-reads stored prices for exactly that party, and
 * the source panel is where you find out whether anything has been scraped for
 * it yet.
 */

import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from "react";
import { defaultRangeExtractor, useWindowVirtualizer } from "@tanstack/react-virtual";
import {
  FlightScraperApi,
  type Cabin,
  type FlightRow,
  type PendingChallenge,
  type SearchRequest,
  type SourceName,
} from "./api";
import { apiConnection } from "./platform";
import { CURRENCIES, CurrencyProvider, useCurrency } from "./currency";
import { RangePicker, daysBetween, todayISO } from "./RangePicker";
import { Details } from "./Details";
import { ChallengeBanner } from "./ChallengeBanner";
import { Queue } from "./Queue";
import { useFlights } from "./useFlights";
import { useQueue } from "./useQueue";
import { UpdateControls } from "./UpdateControls";
import { RangeStatus } from "./RangeStatus";
import { rangeStats } from "./queueModel";
import { Icon, Spinner } from "./Icon";
import { flightRatings } from "./flightRatings";
import { DEFAULT_SORT, SORT_LABELS, sortFlightRows, type SortKey } from "./flightSort";
import { useFavorites } from "./useFavorites";
import { FavoriteButton } from "./FavoriteButton";
import { FlightTimeline, LegDuration } from "./TimelineFlight";
import { TimelineTooltipProvider } from "./TimelineTooltip";
import { flightTimelines, normalizeTimelineMode, TIMELINE_MODE_KEY, type FlightTimelines, type TimelineMode } from "./flightTimeline";
import { FILTERS_KEY, FlightFiltersBar } from "./FilterBar";
import { FILTERS_VERSION, filtersActive, matchesFlight, sanitizeFilters, type ListFilters } from "./flightFilters";
import { connectionFilterOptions, filterRanges } from "./filterSuggestions";
import { PlaceInput } from "./PlaceInput";
import { CurrencyInput } from "./CurrencyInput";
import { rememberPlace } from "./recentPlaces";
import { useFlightArrivals, useSelectedFlightAnchor } from "./useFlightListEffects";

/** Default to a couple of weeks out: today's flights are mostly gone. */
function defaultDate(): string {
  const day = new Date();
  day.setDate(day.getDate() + 14);
  return day.toISOString().slice(0, 10);
}

const today = () => new Date().toISOString().slice(0, 10);

const CABINS: Cabin[] = ["economy", "premiumeconomy", "business", "first"];
const CABIN_LABELS: Record<Cabin, string> = {
  economy: "Economy",
  premiumeconomy: "Premium economy",
  business: "Business",
  first: "First",
};

/** "2 adults + 1 child, business" — what the prices on screen are actually for. */
function describeParty(
  adults: number, children: number, infants: number, cabin: Cabin,
): string {
  const bits = [`${adults} adult${adults > 1 ? "s" : ""}`];
  if (children) bits.push(`${children} child${children > 1 ? "ren" : ""}`);
  if (infants) bits.push(`${infants} infant${infants > 1 ? "s" : ""}`);
  const who = bits.join(" + ");
  return cabin === "economy" ? who : `${who}, ${CABIN_LABELS[cabin].toLowerCase()}`;
}

interface RememberedForm {
  origin: string;
  destination: string;
  /** First and last departure date searched. Equal for a single day. */
  start: string;
  end: string;
  /** First and last return date. Both empty for a one-way. */
  ret: string;
  ret_end: string;
  adults: number;
  children: number;
  infants: number;
  cabin: Cabin;
  /** What the sources are asked to quote in. Storage is EUR regardless. */
  currency: string;
}

const FORM_KEY = "flight-scraper:form";

const DAY_MS = 86_400_000;

const addDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T12:00:00`) + days * DAY_MS).toISOString().slice(0, 10);

const nightsBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T12:00:00`) - Date.parse(`${from}T12:00:00`)) / DAY_MS);

/**
 * The last search, so a reload lands back where you left off.
 *
 * A departure that has already passed is **pushed forward** rather than
 * restored or thrown away: coming back next week should not re-run a search for
 * last Tuesday, which can only come back empty, but the trip being planned is
 * still the trip being planned. The shape is preserved — how wide each range
 * is, and how far the return sits from the departure — so a saved seven-night
 * trip stays a seven-night trip starting from the default date.
 */
function rememberedForm(): Partial<RememberedForm> {
  try {
    const raw = localStorage.getItem(FORM_KEY);
    if (!raw) return {};
    const saved = JSON.parse(raw) as Partial<RememberedForm>;
    const now = today();

    if (saved.start && saved.start < now) {
      const width = saved.end ? nightsBetween(saved.start, saved.end) : 0;
      const gap = saved.ret ? nightsBetween(saved.start, saved.ret) : 0;
      const retWidth = saved.ret && saved.ret_end
        ? nightsBetween(saved.ret, saved.ret_end) : 0;

      saved.start = defaultDate();
      saved.end = addDays(saved.start, Math.max(0, width));
      saved.ret = gap > 0 ? addDays(saved.start, gap) : "";
      saved.ret_end = saved.ret ? addDays(saved.ret, Math.max(0, retWidth)) : "";
    } else if (saved.ret && saved.ret < now) {
      // An outbound still ahead but a return behind us is not a trip.
      saved.ret = "";
      saved.ret_end = "";
    }
    return saved;
  } catch {
    return {};   // corrupt or unavailable storage is not worth a broken page
  }
}

/** "2026-09-05" → "Sep 5". Parsed as local noon so no timezone shifts the day. */
function readableDay(iso: string): string {
  const day = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(day.getTime())) return iso;
  return day.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * The results, as a list rather than a table.
 *
 * There are no headers because none are needed: a price, a date, an itinerary
 * and a duration each announce themselves. Airlines, stop counts and every
 * seller's price live in the side panel, which is what keeps a row scannable.
 */
function Results(
  { rows, dataset, total, limited, loading, openKey, onOpen, favorites, onToggleFavorite, ratings, timelines, timelineMode, connectionRecovery }:
  {
    rows: FlightRow[]; dataset: FlightRow[]; total: number; limited: boolean; loading: boolean; openKey: string | null;
    onOpen: (key: string) => void;
    favorites: ReadonlySet<string>; onToggleFavorite: (key: string) => void;
    ratings: ReturnType<typeof flightRatings>;
    timelines: FlightTimelines;
    timelineMode: TimelineMode;
    connectionRecovery: { label: string; onClick: () => void } | null;
  },
) {
  const { money } = useCurrency();
  const list = useRef<HTMLDivElement | null>(null);
  const index = openKey ? rows.findIndex((row) => row.trip_key === openKey) : -1;
  const isAnchored = useSelectedFlightAnchor(list, openKey);
  /**
   * How far down the document the list starts.
   *
   * Held in state rather than read from the ref while rendering: during the
   * first render the ref is still null, and a value of zero puts every row a
   * header's height out of place. It moves when the header does — opening
   * Advanced gives it another line — so it is measured again on a resize.
   */
  const [listTop, setListTop] = useState(0);
  useLayoutEffect(() => {
    const measure = () => setListTop(list.current?.offsetTop ?? 0);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  });

  /**
   * Only the rows on screen are built.
   *
   * Three hundred rows is 6,600 nodes and 150 ms of layout every time the list
   * is rebuilt — on a re-sort, on every poll that lands new results — and that
   * cap is itself a compromise: a search of nine trips finds thousands of
   * distinct flights and the other thousands are thrown away. Roughly twenty
   * rows exist at a time now, so the cost stops depending on the answer's
   * size.
   *
   * Window-scrolled, because the results *are* the page — hence
   * `scrollMargin`, which tells the virtualiser how far down the document the
   * list begins. Heights are measured rather than assumed: a one-way row is
   * one line and a round trip is two.
   */
  const virtual = useWindowVirtualizer({
    count: rows.length,
    estimateSize: (i) => rows[i]?.inbound || rows[i]?.return_date ? 156 : 84,
    overscan: 10,
    scrollMargin: listTop,
    getItemKey: (index) => rows[index]?.trip_key ?? index,
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range);
      // One extra mounted row lets a large insert preserve the selection even
      // when its new index would otherwise fall outside the virtual viewport.
      if (index >= 0 && !indexes.includes(index)) indexes.push(index);
      return indexes.sort((a, b) => a - b);
    },
  });
  // The selected row's anchor handles measurement changes before paint. Avoid
  // a second correction from the virtualizer while that anchor is visible.
  virtual.shouldAdjustScrollPositionOnItemSizeChange = isAnchored() ? () => false : undefined;
  useFlightArrivals(list, dataset);

  // Arrow keys walk the selection past the edge of the screen, so the page has
  // to follow it. The neighbouring row is nearly always mounted thanks to the
  // overscan, and moving to a *rendered* row keeps `scroll-margin-top` doing
  // its job of clearing the sticky bar; only a jump to somewhere far away —
  // Home, End — has to be handed to the virtualiser.
  useEffect(() => {
    if (index < 0) return;
    const node = list.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    if (node) node.scrollIntoView({ block: "nearest" });
    else virtual.scrollToIndex(index, { align: "center" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openKey]);

  if (rows.length === 0) {
    if (loading && total === 0) return <div className="results-loading" role="status">
      <Spinner /><span>Loading flights…</span>
    </div>;
    return <div className="empty-results">
      <p className="muted">{connectionRecovery ? "No flights match your connection preferences."
        : limited && total > 0 ? "Nothing matches these limits." : "No flights to show."}</p>
      {connectionRecovery && <button type="button" onClick={connectionRecovery.onClick}>{connectionRecovery.label}</button>}
    </div>;
  }

  const items = virtual.getVirtualItems();

  return (
    <TimelineTooltipProvider resetKey={rows}><div
      className="results"
      role="grid"
      aria-label="Flights"
      aria-rowcount={rows.length}
      aria-colcount={2}
      ref={list}
      // The full height stands in for the rows that are not there, so the
      // scrollbar means what it says.
      style={{ height: virtual.getTotalSize(), position: "relative" }}
    >
      {items.map((item) => {
        const row = rows[item.index]!;
        const isOpen = row.trip_key === openKey;
        const rating = ratings.get(row.trip_key);
        const favorite = favorites.has(row.trip_key);
        const oneWay = !row.return_date && !row.inbound;
        return (
          <div
            key={item.key}
            data-index={item.index}
            data-flight-key={row.trip_key}
            ref={virtual.measureElement}
            role="row"
            aria-selected={isOpen}
            aria-rowindex={item.index + 1}
            className={isOpen ? "flight picked" : "flight"}
            onClick={() => onOpen(row.trip_key)}
            style={{
              position: "absolute", top: 0, left: 0, width: "100%",
              transform: `translateY(${item.start - virtual.options.scrollMargin}px)`,
            }}
          >
            <span className="fare-cell" role="gridcell">
              <span className="fare-header">
                <FavoriteButton row={row} favorite={favorite} onToggle={onToggleFavorite} />
                <span className="price" data-rating={rating?.price?.level} title={rating?.price?.description}>{money(row.best?.price_base)}</span>
              </span>
              <span className="flight-dates">
                <span className={oneWay ? "fare-journey fare-journey--one-way" : "fare-journey"}>
                  <span className="fare-journey-label">
                    <span className="fare-route">
                      <strong>{row.outbound.origin_airport}</strong>
                      {oneWay && <><Icon name="arrow-right" /><strong>{row.outbound.destination_airport}</strong></>}
                    </span>
                    <time className="fare-journey-date" dateTime={row.depart_date} title={`Departure: ${row.depart_date}`}>{readableDay(row.depart_date)}</time>
                  </span>
                  <LegDuration leg={row.outbound} timing={timelines.journeys.get(row.outbound)} rating={rating?.outbound} />
                </span>
                {row.return_date && <span className="fare-journey">
                  <span className="fare-journey-label">
                    <strong>{row.inbound?.origin_airport || row.outbound.destination_airport}</strong>
                    <time className="fare-journey-date" dateTime={row.return_date} title={`Return: ${row.return_date}`}>{readableDay(row.return_date)}</time>
                  </span>
                  {row.inbound && <LegDuration leg={row.inbound} timing={timelines.journeys.get(row.inbound)} rating={rating?.inbound} />}
                </span>}
              </span>
            </span>
            <span className="trip" role="gridcell">
              <FlightTimeline leg={row.outbound} scale={timelines.outbound} timing={timelines.journeys.get(row.outbound)} mode={timelineMode} />
              {/* A round trip is half-described by its outbound alone. */}
              {row.inbound ? (
                <div className="back">
                  <FlightTimeline leg={row.inbound} scale={timelines.inbound} timing={timelines.journeys.get(row.inbound)} mode={timelineMode} />
                </div>
              ) : row.return_date && (
                // The seller priced the round trip without saying which flight
                // comes back. Saying so beats a row that reads as a cheaper
                // one-way — and the return date above still says when.
                <div className="back no-detail">return not detailed</div>
              )}
            </span>
          </div>
        );
      })}
    </div></TimelineTooltipProvider>
  );
}

function Shell() {
  const [api, setApi] = useState<FlightScraperApi | null>(null);
  const [pending, setPending] = useState<PendingChallenge[]>([]);
  const [canSolveHere, setCanSolveHere] = useState(false);

  const remembered = useRef(rememberedForm()).current;
  const [origin, setOrigin] = useState(remembered.origin ?? "BER");
  const [destination, setDestination] = useState(remembered.destination ?? "LON");
  const [start, setStart] = useState(() => remembered.start ?? defaultDate());
  const [end, setEnd] = useState(() => remembered.end ?? remembered.start ?? defaultDate());
  const [ret, setRet] = useState(remembered.ret ?? "");
  const [retEnd, setRetEnd] = useState(remembered.ret_end ?? remembered.ret ?? "");
  const [adults, setAdults] = useState(remembered.adults ?? 1);
  const [children, setChildren] = useState(remembered.children ?? 0);
  const [infants, setInfants] = useState(remembered.infants ?? 0);
  const [cabin, setCabin] = useState<Cabin>(remembered.cabin ?? "economy");
  const [askCurrency, setAskCurrency] = useState(remembered.currency ?? "EUR");

  const [advanced, setAdvanced] = useState(
    // Open it if it is holding anything other than the default, so a party set
    // last time is visible rather than hidden behind a closed fold.
    () => (remembered.adults ?? 1) !== 1 || (remembered.children ?? 0) !== 0
      || (remembered.infants ?? 0) !== 0 || (remembered.cabin ?? "economy") !== "economy"
      || (remembered.currency ?? "EUR") !== "EUR",
  );

  const [openKey, setOpenKey] = useState<string | null>(null);
  const { favorites, toggleFavorite } = useFavorites();
  const [sort, setSort] = useState<SortKey>(DEFAULT_SORT);
  const [timelineMode, setTimelineMode] = useState<TimelineMode>(() => {
    try { return normalizeTimelineMode(localStorage.getItem(TIMELINE_MODE_KEY)); }
    catch { return "days"; }
  });
  useEffect(() => {
    try { localStorage.setItem(TIMELINE_MODE_KEY, timelineMode); }
    catch { /* The view still works when preference storage is unavailable. */ }
  }, [timelineMode]);
  const [filters, setFilters] = useState<ListFilters>(() => {
    try { return sanitizeFilters(JSON.parse(localStorage.getItem(FILTERS_KEY) || "null")); }
    catch { return sanitizeFilters(null); }
  });
  useEffect(() => {
    localStorage.setItem(FILTERS_KEY, JSON.stringify({ ...filters, version: FILTERS_VERSION }));
  }, [filters]);

  const challengeRead = useRef(0);
  const refreshChallenges = useCallback(async () => {
    if (!api) return;
    const version = ++challengeRead.current;
    const c = await api.challenges();
    if (version !== challengeRead.current) return;
    setPending(c.pending);
    setCanSolveHere(Boolean(c.can_solve_here));
  }, [api]);

  // Background jobs and other windows can add or clear a challenge at any time.
  const verifying = pending.some((p) => p.solving);
  useEffect(() => {
    if (!api) return;
    let disposed = false, timer = 0;
    const poll = async () => {
      try { await refreshChallenges(); } catch { /* keep the last known requests */ }
      if (!disposed) timer = window.setTimeout(poll, verifying ? 1000 : 3000);
    };
    const resume = () => {
      if (document.visibilityState !== "hidden") void refreshChallenges().catch(() => {});
    };
    void poll();
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [api, refreshChallenges, verifying]);

  const refreshChallengesInBackground = useCallback(() => {
    void refreshChallenges().catch(() => {});
  }, [refreshChallenges]);
  const engine = useFlights(api, refreshChallengesInBackground);
  const { roundedIn } = useCurrency();

  const limits = useMemo(() => ({
    maxPrice: filters.maxPriceEur == null ? null : roundedIn(filters.maxPriceEur),
    maxDurationMinutes: filters.maxDurationMinutes,
    maxLayoverMinutes: filters.maxLayoverMinutes,
    maxStops: filters.maxStops,
    excludeRepeatedAirports: filters.excludeRepeatedAirports,
    outbound: filters.outbound,
    inbound: filters.inbound,
  }), [filters, roundedIn]);
  const filtered = useMemo(() => engine.rows.filter((row) => matchesFlight(
    row, limits, row.best?.price_base == null ? null : roundedIn(row.best.price_base),
  )), [engine.rows, limits, roundedIn]);
  const shown = useMemo(() => sortFlightRows(filtered, sort), [filtered, sort]);
  // Ratings and bounds include every matching row, even offscreen. Sorting
  // and favorites reuse them; suggestions still cover all loaded results.
  const ratings = useMemo(() => flightRatings(filtered), [filtered]);
  const allTimelines = useMemo(() => flightTimelines(engine.rows), [engine.rows]);
  const timelines = useMemo(() => flightTimelines(filtered, allTimelines.journeys), [filtered, allTimelines]);
  const suggestions = useMemo(() => filterRanges(engine.rows, allTimelines.journeys), [engine.rows, allTimelines]);
  const connectionOptions = useMemo(() => connectionFilterOptions(engine.rows, limits,
    (row) => row.best?.price_base == null ? null : roundedIn(row.best.price_base)), [engine.rows, limits, roundedIn]);
  const connectionRecovery = useMemo(() => {
    if (filtered.length || !engine.rows.length) return null;
    const canShow = (next: typeof limits) => engine.rows.some((row) => matchesFlight(
      row, next, row.best?.price_base == null ? null : roundedIn(row.best.price_base),
    ));
    if (limits.maxLayoverMinutes !== null && canShow({ ...limits, maxLayoverMinutes: null })) {
      return { label: "Show longer connections", onClick: () => setFilters((old) => ({ ...old, maxLayoverMinutes: null })) };
    }
    if (limits.excludeRepeatedAirports && canShow({ ...limits, maxLayoverMinutes: null, excludeRepeatedAirports: false })) {
      return { label: "Show all connections", onClick: () => setFilters((old) => ({ ...old, maxLayoverMinutes: null, excludeRepeatedAirports: false })) };
    }
    return null;
  }, [filtered, engine.rows, limits, roundedIn]);

  // What a scrape will actually ask for. Every departure day against every
  // return day that is not before it — five trips out of three departures and
  // two returns, not six, because a return before its departure is not a trip.
  // Worth showing: it is the number of questions put to every source.
  const departDays = start ? daysBetween(start, end || start) + 1 : 0;
  const returnDays = ret ? daysBetween(ret, retEnd || ret) + 1 : 0;
  const trips = useMemo(() => {
    if (!start) return 0;
    if (!ret) return departDays;
    let count = 0;
    for (let out = 0; out < departDays; out++) {
      for (let back = 0; back < returnDays; back++) {
        const departing = addDays(start, out);
        if (addDays(ret, back) >= departing) count++;
      }
    }
    return count;
  }, [start, end, ret, retEnd, departDays, returnDays]);

  const request = useMemo<SearchRequest | null>(() => {
    if (!origin.trim() || !destination.trim() || !start) return null;
    return {
      origin: origin.trim(),
      destination: destination.trim(),
      start,
      end: end || start,
      ret: ret || undefined,
      ret_end: ret ? (retEnd || ret) : undefined,
      adults, children, infants, cabin,
      currency: askCurrency,
    };
  }, [origin, destination, start, end, ret, retEnd,
      adults, children, infants, cabin, askCurrency]);

  const queue = useQueue(api, request, engine.running, refreshChallengesInBackground);
  const fetchRange = useCallback((refresh: boolean) => {
    if (request && trips > 0 && !engine.running && !queue.busy) {
      rememberPlace(request.origin);
      rememberPlace(request.destination);
      void engine.runSearch({ ...request, refresh });
    }
  }, [request, trips, engine.running, engine.runSearch, queue.busy]);

  // Wait for the sidecar to come up. Nothing announces the wait: until it
  // answers there are no sources, and the source panel says so in the one
  // place that is already about them.
  useEffect(() => {
    let live = true;
    (async () => {
      const { base, apiKey } = await apiConnection();
      const client = new FlightScraperApi(base, apiKey);
      for (let attempt = 0; attempt < 40 && live; attempt++) {
        try {
          await client.health();
          if (!live) return;
          setApi(client);
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    })();
    return () => { live = false; };
  }, []);

  // Every edit re-reads the database — debounced, because a typed airport code
  // changes the form three times on the way to something real. Nothing here
  // reaches a source.
  // Query identity also guards live streams. Changing quote currency detaches
  // the previous query even though both read the same EUR price ledger.
  const storedKey = request
    ? JSON.stringify([
        request.origin, request.destination, request.start, request.end ?? "",
        request.ret ?? "", request.ret_end ?? "",
        request.adults, request.children, request.infants, request.cabin, request.currency,
      ])
    : "";
  useEffect(() => {
    engine.selectView(Boolean(request));
    if (!api || !request) return;
    const timer = window.setTimeout(() => void engine.loadStored(request), 350);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, storedKey]);

  // Queue actions can start work without a results stream. Read only the
  // selected view's ledger, so background query results never enter this table.
  useEffect(() => {
    if (!api || !request || engine.running) return;
    const timer = window.setInterval(() => void engine.loadStored(request), 3000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, storedKey, engine.running]);

  // A return range entirely before the departures describes no trip at all —
  // every pairing would be a flight home before the flight out. Rather than
  // let the search fail, the return range is dragged forward to start where
  // the departures do.
  useEffect(() => {
    if (ret && start && retEnd && retEnd < start) {
      const width = Math.max(0, nightsBetween(ret, retEnd));
      setRet(start);
      setRetEnd(addDays(start, width));
    } else if (ret && start && ret < start) {
      setRet(start);
    }
  }, [start, ret, retEnd]);

  // Remember the form as it is edited, so a reload or a later visit starts here.
  useEffect(() => {
    try {
      localStorage.setItem(
        FORM_KEY,
        JSON.stringify({
          origin, destination, start, end, ret, ret_end: retEnd,
          adults, children, infants, cabin, currency: askCurrency,
        } satisfies RememberedForm),
      );
    } catch { /* private mode, quota — not worth breaking the page over */ }
  }, [origin, destination, start, end, ret, retEnd,
      adults, children, infants, cabin, askCurrency]);

  /**
   * How tall the two pinned regions are, as CSS variables.
   *
   * The header and the side panel are pinned; the results are the page itself
   * and scroll with it. That only lines up if the rest of the layout knows how
   * much room the pinned parts take — and both of them move. The header grows
   * a second row when Advanced opens; the panel, once it is stacked across the
   * top on a narrow window, is as tall as whatever it is holding. CSS cannot
   * measure either, so this does.
   */
  const header = useRef<HTMLElement | null>(null);
  const side = useRef<HTMLElement | null>(null);

  const measure = useCallback(() => {
    for (const [ref, name] of [[header, "--header-h"], [side, "--side-h"]] as const) {
      if (!ref.current) continue;
      // Floor, never round. These heights are fractional, and the number is
      // what the list is pushed down by: a pixel short tucks the list under an
      // opaque edge, a pixel long opens a slit for it to show through.
      document.documentElement.style.setProperty(
        name, `${Math.floor(ref.current.getBoundingClientRect().height)}px`,
      );
    }
  }, []);

  // Three ways in, because a stale number here is a visible seam. Every React
  // render is measured before it paints, which covers the fold opening and a
  // flight being picked. A resize covers the layout changing shape underneath
  // us — at the breakpoint the panel goes from full-height column to a capped
  // band, and React is never told. The observer catches the rest.
  useLayoutEffect(measure);
  useEffect(() => {
    const observer = new ResizeObserver(measure);
    for (const ref of [header, side]) if (ref.current) observer.observe(ref.current);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  /**
   * ↑/↓ walk the list and Escape steps out of it, wherever you are on the page.
   *
   * Bound to the window rather than to the list so it works without clicking
   * in first — but not while a field has focus, where ↑ on a number input or
   * Escape on a date picker means something else entirely.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End", "Escape"].includes(event.key)) return;
      if (event.altKey || event.metaKey || event.ctrlKey) return;

      const focused = document.activeElement?.tagName;
      if (focused === "INPUT" || focused === "SELECT" || focused === "TEXTAREA") return;

      if (event.key === "Escape") {
        if (document.querySelector(".time-popup")) return;
        event.preventDefault();
        setOpenKey(null);      // return to the queue
        return;
      }
      if (!shown.length) return;

      event.preventDefault();
      const at = shown.findIndex((row) => row.trip_key === openKey);
      const to = event.key === "Home" ? 0
        : event.key === "End" ? shown.length - 1
        : at < 0 ? 0                                  // nothing picked yet: start at the top
        : event.key === "ArrowDown" ? Math.min(shown.length - 1, at + 1)
        : Math.max(0, at - 1);
      setOpenKey(shown[to]!.trip_key);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown, openKey]);

  const openRow = shown.find((row) => row.trip_key === openKey) ?? null;

  /**
   * Clicking away from the list puts the flight down.
   *
   * Away means the page itself — empty space beside the results, the bar above
   * them, the header's background. Not the side panel: that *is* the flight,
   * and dismissing it by reading it would be absurd. Not a control either — the
   * sort, the currency and the dates all sit outside the list, and losing your
   * place every time you changed the sort would be a worse bargain than never
   * being able to click a flight away.
   *
   * On mousedown rather than click, so it lands before the thing you pressed
   * does something of its own.
   */
  useEffect(() => {
    if (!openKey) return;
    const away = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest(".results, .side")) return;
      if (target.closest("input, select, button, label, a, .cal-popup, .time-popup, .flight-filter-panel, .place-suggest, .currency-suggest")) return;
      setOpenKey(null);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [openKey]);

  return (
    <div className="app">
      <header className="topbar" ref={header}>
        <form
          className="params"
          onSubmit={(e) => {
            e.preventDefault();
            const selected = rangeStats(queue.selected);
            fetchRange(selected.groups === trips && selected.total > 0 && selected.done === selected.total);
          }}
        >
          <PlaceInput label="From" value={origin} onChange={setOrigin} api={api} required />
          <PlaceInput label="To" value={destination} onChange={setDestination} api={api} required />
          {/* Each departure day is priced against each return day. */}
          <RangePicker
            label="Depart"
            from={start}
            to={end || start}
            min={todayISO()}
            hint={`${departDays} departure${departDays > 1 ? "s" : ""}`}
            onChange={(from, to) => { setStart(from); setEnd(to); }}
          />
          <RangePicker
            label="Return"
            from={ret}
            to={retEnd || ret}
            min={start || todayISO()}
            optional
            empty="One way"
            hint={ret ? `${returnDays} return${returnDays > 1 ? "s" : ""}` : ""}
            onChange={(from, to) => { setRet(from); setRetEnd(to); }}
          />

          {/* Folded away because most searches are one adult in economy, but
              part of the search itself — changing any of it re-reads the
              database for that party, and a scrape asks for exactly it. */}
          <button
            type="button"
            className="disclose"
            aria-expanded={advanced}
            onClick={() => setAdvanced((open) => !open)}
          >
            <Icon name={advanced ? "chevron-down" : "chevron-right"} /> Advanced
          </button>

          {advanced && (
            <div className="advanced">
              <label>Adults
                <input type="number" min={1} max={9} value={adults}
                  onChange={(e) => setAdults(Math.max(1, +e.target.value))} />
              </label>
              <label>Children
                <input type="number" min={0} max={8} value={children}
                  onChange={(e) => setChildren(Math.max(0, +e.target.value))} />
              </label>
              <label>Infants
                <input type="number" min={0} max={8} value={infants}
                  onChange={(e) => setInfants(Math.max(0, +e.target.value))} />
              </label>
              <label>Cabin
                <select value={cabin} onChange={(e) => setCabin(e.target.value as Cabin)}>
                  {CABINS.map((c) => <option key={c} value={c}>{CABIN_LABELS[c]}</option>)}
                </select>
              </label>
              <label>Quote in
                <select value={askCurrency} onChange={(e) => setAskCurrency(e.target.value)}>
                  {CURRENCIES.map((code) => <option key={code} value={code}>{code}</option>)}
                </select>
              </label>
            </div>
          )}
        </form>

        {/* Pushed to the right of the search it acts on. */}
        <div className="topbar-actions">
          <UpdateControls busy={engine.running || Boolean(queue.busy) || queue.offline || !queue.state
            || Boolean(queue.state.scheduler.running || queue.state.scheduler.queued)} />
          <RangeStatus queue={queue} trips={trips} canSearch={Boolean(api && request)}
            fetching={engine.running} onFetch={fetchRange} />
          <button type="button" className="queue-icon-button sidebar-toggle"
            title="Show search queue" aria-label="Show search queue"
            aria-pressed={!openRow} aria-controls="search-queue" onClick={() => setOpenKey(null)}>
            <Icon name="queue" />
          </button>
        </div>
      </header>

      <main className="results-pane">
        {/* These display controls do not request new results from a source. */}
        <div className="results-bar">
          <FlightFiltersBar filters={filters} onChange={setFilters} shown={shown.length} total={engine.rows.length} roundTrip={Boolean(ret)} suggestions={suggestions} connectionOptions={connectionOptions} />
          <div className="results-view-controls">
            <label className="inline">
              Timeline
              <select value={timelineMode} onChange={(e) => setTimelineMode(normalizeTimelineMode(e.target.value))}
                title="Day ranges start at 03:00 at the departure airport. Shared scale aligns all filtered flights.">
                <option value="days">Day ranges</option>
                <option value="shared">Shared scale</option>
              </select>
            </label>
            <label className="inline">
              Sort by
              <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}
                title={sort === "best" ? "Balances price and total travel time, including the return and layovers" : undefined}>
                {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
                  <option key={key} value={key}>{SORT_LABELS[key]}</option>
                ))}
              </select>
            </label>
            <CurrencyInput />
          </div>
        </div>

        <Results
          rows={shown}
          dataset={engine.rows}
          total={engine.total}
          limited={filtersActive(filters)}
          loading={Boolean(request) && (!api || engine.loadingStored || engine.running)}
          openKey={openKey}
          onOpen={setOpenKey}
          favorites={favorites}
          onToggleFavorite={toggleFavorite}
          ratings={ratings}
          timelines={timelines}
          timelineMode={timelineMode}
          connectionRecovery={connectionRecovery}
        />
      </main>

      <aside className="side" ref={side} aria-label={openRow ? "Flight details" : "Search queue"}>
        <div className="queue-view" id="search-queue" hidden={Boolean(openRow)}>
          <ChallengeBanner
            api={api}
            pending={pending}
            canSolveHere={canSolveHere}
            onCleared={refreshChallenges}
          />
          <Queue queue={queue} />
        </div>

        <Details
          row={openRow}
          rating={openRow ? ratings.get(openRow.trip_key) : undefined}
          favorite={Boolean(openRow && favorites.has(openRow.trip_key))}
          onToggleFavorite={toggleFavorite}
          partyLabel={describeParty(adults, children, infants, cabin)}
        />
      </aside>
    </div>
  );
}

export default function App() {
  const [api, setApi] = useState<FlightScraperApi | null>(null);
  // The provider needs a client to fetch rates; the shell builds its own once
  // the sidecar answers. Resolving the base once here keeps them in step.
  useEffect(() => {
    apiConnection().then(({ base, apiKey }) => setApi(new FlightScraperApi(base, apiKey))).catch(() => {});
  }, []);
  return (
    <CurrencyProvider api={api}>
      <Shell />
    </CurrencyProvider>
  );
}

export type { SourceName };

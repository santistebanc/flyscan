/**
 * The whole UI: one search bar across the top, the list of every flight found,
 * and a side panel with two tabs — the selected flight and the queue.
 *
 * One rule shapes it: editing the search reads the **database** and never
 * contacts a source; only Fetch contacts one. That holds for the party and
 * cabin too — changing them re-reads stored prices for exactly that party, and
 * the status beside the search is where you find out whether anything has been
 * scraped for it yet.
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
import { RangePicker, daysBetween, readableRange, todayISO } from "./RangePicker";
import { Details } from "./Details";
import { ChallengeBanner } from "./ChallengeBanner";
import { Queue } from "./Queue";
import { useFlights } from "./useFlights";
import { useQueue } from "./useQueue";
import { UpdateControls } from "./UpdateControls";
import { FetchButton, RangeStatus, rangeComplete } from "./RangeStatus";
import { rangeStats, splitQueueGroups } from "./queueModel";
import { Icon, Spinner } from "./Icon";
import { flightRatings } from "./flightRatings";
import { DEFAULT_SORT, SORT_LABELS, sortFlightRows, type SortKey } from "./flightSort";
import { useFavorites } from "./useFavorites";
import { FavoriteButton } from "./FavoriteButton";
import { FlightTimeline } from "./TimelineFlight";
import { elapsed, flightTimelines, normalizeTimelineMode, TIMELINE_MODE_KEY, type FlightTimelines, type TimelineMode } from "./flightTimeline";
import { FILTERS_KEY, FlightFiltersBar } from "./FilterBar";
import { DEFAULT_FILTERS, FILTERS_VERSION, matchesFlight, sanitizeFilters, type ListFilters } from "./flightFilters";
import { connectionFilterOptions, filterRanges } from "./filterSuggestions";
import { PlaceInput } from "./PlaceInput";
import { TravellersPicker, CABIN_LABELS } from "./TravellersPicker";
import { SourcesPicker } from "./SourcesPicker";
import { EditFlightDialog, type ManualFlight } from "./EditFlightDialog";
import type { ManualActions } from "./Details";
import type { ManualPriceValues } from "./ManualPriceForm";
import { MANUAL_SOURCE, carrierNames, isManual } from "./manualEntry";
import { SOURCES_KEY, chosenSources, requestedSources, rowsFromSources, sanitizeDisabled } from "./sourceSelection";
import { CurrencyInput } from "./CurrencyInput";
import { rememberPlace } from "./recentPlaces";
import { useFlightArrivals, useListAwareness, useSelectedFlightAnchor } from "./useFlightListEffects";
import { AirportNamesProvider } from "./AirportLabel";
import { useOfferPrices } from "./useOfferPrices";
import { connectionRatings } from "./connectionRatings";
import { useFareColumnWidth } from "./useFareColumnWidth";
import { PriceMark, priceMarks } from "./PriceMark";

/** Default to a couple of weeks out: today's flights are mostly gone. */
function defaultDate(): string {
  const day = new Date();
  day.setDate(day.getDate() + 14);
  return day.toISOString().slice(0, 10);
}

const today = () => new Date().toISOString().slice(0, 10);

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
  return day.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const returnDateOf = (row: FlightRow) => row.return_date || row.inbound?.departure.slice(0, 10) || "";

type EmptyState = { title: string; body?: string; action?: { label: string; onClick: () => void } };

/**
 * The results, as a list rather than a table.
 *
 * There are no headers because none are needed: a price, a date, an itinerary
 * and a duration each announce themselves. Airlines and every seller's price
 * live in the side panel, which is what keeps a row scannable.
 */
function Results(
  { rows, dataset, view, loading, empty, openKey, onOpen, favorites, onToggleFavorite, ratings, timelines, timelineMode, layoverRatings }:
  {
    /** The sort and filters; a change returns the list to its top. */
    rows: FlightRow[]; dataset: FlightRow[]; view: string; loading: string | null; empty: EmptyState; openKey: string | null;
    onOpen: (key: string) => void;
    favorites: ReadonlySet<string>; onToggleFavorite: (key: string) => void;
    ratings: ReturnType<typeof flightRatings>;
    timelines: FlightTimelines;
    timelineMode: TimelineMode;
    layoverRatings: ReturnType<typeof connectionRatings>;
  },
) {
  const { money } = useCurrency();
  const list = useRef<HTMLDivElement | null>(null);
  const fareContent = useMemo(() => rows.map((row) => {
    const returnDate = returnDateOf(row);
    return { price: money(row.best?.price_base), marks: priceMarks(row, money).length,
      dates: readableDay(row.depart_date) + (returnDate ? ` – ${readableDay(returnDate)}` : "") };
  }), [rows, money]);
  useFareColumnWidth(list, fareContent);
  const index = openKey ? rows.findIndex((row) => row.trip_key === openKey) : -1;
  const isAnchored = useSelectedFlightAnchor(list, openKey, view);
  /**
   * How far down the document the list starts.
   *
   * Held in state rather than read from the ref while rendering: during the
   * first render the ref is still null, and a value of zero puts every row a
   * header's height out of place. It moves when the header does, so it is
   * measured again on a resize.
   */
  const [listTop, setListTop] = useState(0);
  // Where the pinned results bar ends, for the notice that hangs below it.
  const [barBottom, setBarBottom] = useState(0);
  useLayoutEffect(() => {
    const measure = () => {
      setListTop(list.current?.offsetTop ?? 0);
      const bar = document.querySelector<HTMLElement>(".results-bar");
      setBarBottom(bar ? parseFloat(getComputedStyle(bar).top) + bar.offsetHeight : 0);
    };
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
    estimateSize: (i) => rows[i]?.inbound || rows[i]?.return_date ? 125 : 72,
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
  const { newAbove, selectedOutOfView } = useListAwareness(list, rows, dataset, view, openKey);
  const firstView = useRef(true);
  useLayoutEffect(() => {
    if (firstView.current) { firstView.current = false; return; }
    if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: "instant" });
  }, [view]);

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
    if (loading) return <div className="results-loading" role="status"><Spinner /><span>{loading}</span></div>;
    return <div className="empty-results">
      <b>{empty.title}</b>
      {empty.body && <p>{empty.body}</p>}
      {empty.action && <button type="button" className="primary" onClick={empty.action.onClick}>{empty.action.label}</button>}
    </div>;
  }

  const items = virtual.getVirtualItems();
  /** Smooth within two screens, where seeing the way you went helps; instant
   * beyond, where a long glide only flashes rows past. Never with reduced motion. */
  const glides = (top: number) => Math.abs(top - window.scrollY) <= 2 * window.innerHeight
    && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const toTop = () => window.scrollTo({ top: 0, behavior: glides(0) ? "smooth" : "instant" });
  const toSelected = () => {
    const target = virtual.getOffsetForIndex(index, "center")?.[0];
    // Far rows are estimated, not measured; the virtualiser corrects its own jump.
    if (target === undefined || !glides(target)) virtual.scrollToIndex(index, { align: "center" });
    else window.scrollTo({ top: target, behavior: "smooth" });
  };

  return (<>
    {/* Zero-height and sticky, so the notices float over the list without moving it. */}
    <div className="list-notice top" style={{ top: barBottom }}>
      {newAbove > 0 && <button type="button" onClick={toTop}>
        <Icon name="arrow-up" />{newAbove} new flight{newAbove === 1 ? "" : "s"} above</button>}
    </div>
    <div
      className="results"
      role="grid"
      aria-label="Flights"
      aria-rowcount={rows.length}
      aria-colcount={3}
      ref={list}
      // The full height stands in for the rows that are not there, so the
      // scrollbar means what it says.
      style={{ height: virtual.getTotalSize(), position: "relative" }}
    >
      {items.map((item) => {
        const row = rows[item.index]!;
        const isOpen = row.trip_key === openKey;
        const rating = ratings.get(row.trip_key);
        const returnDate = returnDateOf(row);
        const marks = priceMarks(row, money);
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
            <span className="favorite-cell" role="gridcell">
              <FavoriteButton row={row} favorite={favorites.has(row.trip_key)} onToggle={onToggleFavorite} />
            </span>
            <span className="fare-cell" role="gridcell">
              <span className="fare-price">
                <span className="price" data-rating={rating?.price?.level} title={rating?.price?.description}>{money(row.best?.price_base)}</span>
                {marks.map((mark) => <PriceMark key={mark.kind} {...mark} />)}
              </span>
              <span className="fare-dates">
                <time dateTime={row.depart_date} title={`Departure: ${row.depart_date}`}>{readableDay(row.depart_date)}</time>
                {returnDate && <> – <time dateTime={returnDate} title={`Return: ${returnDate}`}>{readableDay(returnDate)}</time></>}
              </span>
            </span>
            <span className="trip" role="gridcell">
              <FlightTimeline label="Outbound" leg={row.outbound} scale={timelines.outbound} timing={timelines.journeys.get(row.outbound)}
                mode={timelineMode} rating={rating?.outbound} layoverRatings={layoverRatings} />
              {row.inbound ? (
                <FlightTimeline label="Return" leg={row.inbound} scale={timelines.inbound} timing={timelines.journeys.get(row.inbound)}
                  mode={timelineMode} rating={rating?.inbound} layoverRatings={layoverRatings} />
              ) : row.return_date && (
                // The seller priced the round trip without saying which flight
                // comes back. Saying so beats a row that reads as a cheaper
                // one-way — and the return date still says when.
                <span className="leg no-detail">
                  <span className="leg-label" aria-hidden="true">Ret</span>
                  <span title="The seller priced the round trip without saying which flight comes back.">
                    Return not detailed · {readableDay(row.return_date)}</span>
                </span>
              )}
            </span>
          </div>
        );
      })}
    </div>
    <div className="list-notice bottom">
      {openKey && index < 0 ? <span>Your selected flight is hidden by the filters</span>
        : selectedOutOfView && <button type="button" onClick={toSelected}>
          Selected flight is #{(index + 1).toLocaleString()} of {rows.length.toLocaleString()} · Show</button>}
    </div>
  </>);
}

type PopoverName = "from" | "to" | "depart" | "return" | "travellers" | "sources";
const POPOVERS: PopoverName[] = ["from", "to", "depart", "return", "travellers", "sources"];

function Shell() {
  const [api, setApi] = useState<FlightScraperApi | null>(null);
  const [pending, setPending] = useState<PendingChallenge[]>([]);
  const [canSolveHere, setCanSolveHere] = useState(false);
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);

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
  /** Every source the sidecar offers, and the ones Fetch is told to skip. */
  const [knownSources, setKnownSources] = useState<{ name: SourceName; label: string; fetchable?: boolean }[]>([]);
  const [disabledSources, setDisabledSources] = useState<string[]>(() => {
    try { return sanitizeDisabled(JSON.parse(localStorage.getItem(SOURCES_KEY) || "null")); }
    catch { return []; }
  });
  useEffect(() => {
    try { localStorage.setItem(SOURCES_KEY, JSON.stringify(disabledSources)); }
    catch { /* The choice still applies for this session. */ }
  }, [disabledSources]);

  /** One popover of the search bar at a time. */
  const [popover, setPopover] = useState<PopoverName | null>(null);
  const toggles = useMemo(() => Object.fromEntries(POPOVERS.map((name) => [name,
    (open: boolean) => setPopover((was) => open ? name : was === name ? null : was)])) as Record<PopoverName, (open: boolean) => void>, []);

  const [openKey, setOpenKey] = useState<string | null>(null);
  const [tab, setTab] = useState<"flight" | "queue">("queue");
  const pickFlight = useCallback((key: string | null) => {
    setOpenKey(key);
    setTab(key ? "flight" : "queue");
  }, []);
  const [toast, setToast] = useState("");
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);
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
    setViewerUrl(c.viewer_url || null);
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
  // Kept out of `request`: the choice changes what Fetch asks and whose
  // prices are listed, not which stored trips or queued searches are on screen.
  // Prices added by hand are a source to show or hide, never one to ask.
  const sourceNames = useMemo(() => knownSources.map((source) => source.name), [knownSources]);
  const fetchableNames = useMemo(() => knownSources.filter((source) => source.fetchable !== false)
    .map((source) => source.name), [knownSources]);
  const askSources = useMemo(() => requestedSources(fetchableNames, disabledSources), [fetchableNames, disabledSources]);
  const shownSources = useMemo(() => requestedSources(sourceNames, disabledSources), [sourceNames, disabledSources]);
  /** Every source Fetch could ask is turned off, leaving only your own prices. */
  const nothingToAsk = fetchableNames.length > 0 && fetchableNames.every((name) => disabledSources.includes(name));
  const wantedSources = useMemo(() => fetchableNames.length ? chosenSources(fetchableNames, disabledSources) : undefined,
    [fetchableNames, disabledSources]);
  const { rows: correctedRows, correctPrice } = useOfferPrices(engine.rows, JSON.stringify([adults, children, infants, cabin]));
  const priceRows = useMemo(() => rowsFromSources(correctedRows, shownSources), [correctedRows, shownSources]);
  const { roundedIn, money } = useCurrency();

  const limits = useMemo(() => ({
    maxPrice: filters.maxPriceEur == null ? null : roundedIn(filters.maxPriceEur),
    maxDurationMinutes: filters.maxDurationMinutes,
    maxLayoverMinutes: filters.maxLayoverMinutes,
    maxStops: filters.maxStops,
    excludeRepeatedAirports: filters.excludeRepeatedAirports,
    outbound: filters.outbound,
    inbound: filters.inbound,
  }), [filters, roundedIn]);
  const filtered = useMemo(() => priceRows.filter((row) => matchesFlight(
    row, limits, row.best?.price_base == null ? null : roundedIn(row.best.price_base),
  )), [priceRows, limits, roundedIn]);
  const shown = useMemo(() => sortFlightRows(filtered, sort), [filtered, sort]);
  // Ratings and bounds include every matching row, even offscreen. Sorting
  // and favorites reuse them; suggestions still cover all loaded results.
  const ratings = useMemo(() => flightRatings(filtered), [filtered]);
  const allTimelines = useMemo(() => flightTimelines(priceRows), [priceRows]);
  const timelines = useMemo(() => flightTimelines(filtered, allTimelines.journeys), [filtered, allTimelines]);
  const layoverRatings = useMemo(() => connectionRatings(timelines), [timelines]);
  const suggestions = useMemo(() => filterRanges(priceRows, allTimelines.journeys), [priceRows, allTimelines]);
  const connectionOptions = useMemo(() => connectionFilterOptions(priceRows, limits,
    (row) => row.best?.price_base == null ? null : roundedIn(row.best.price_base)), [priceRows, limits, roundedIn]);
  const connectionRecovery = useMemo(() => {
    if (filtered.length || !priceRows.length) return null;
    const canShow = (next: typeof limits) => priceRows.some((row) => matchesFlight(
      row, next, row.best?.price_base == null ? null : roundedIn(row.best.price_base),
    ));
    if (limits.maxLayoverMinutes !== null && canShow({ ...limits, maxLayoverMinutes: null })) {
      return { label: "Show longer connections", onClick: () => setFilters((old) => ({ ...old, maxLayoverMinutes: null })) };
    }
    if (limits.excludeRepeatedAirports && canShow({ ...limits, maxLayoverMinutes: null, excludeRepeatedAirports: false })) {
      return { label: "Show all connections", onClick: () => setFilters((old) => ({ ...old, maxLayoverMinutes: null, excludeRepeatedAirports: false })) };
    }
    return null;
  }, [filtered, priceRows, limits, roundedIn]);

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
    if (request && trips > 0 && !nothingToAsk && !engine.running && !queue.busy) {
      rememberPlace(request.origin);
      rememberPlace(request.destination);
      setPopover(null);
      void engine.runSearch({ ...request, sources: askSources, refresh });
    }
  }, [request, askSources, nothingToAsk, trips, engine.running, engine.runSearch, queue.busy]);

  // -- prices added by hand ------------------------------------------------
  const [editingFlight, setEditingFlight] = useState<FlightRow | null>(null);
  const manualParty = useMemo(() => ({ adults, children, infants, cabin }), [adults, children, infants, cabin]);
  const carriers = useMemo(() => carrierNames(correctedRows), [correctedRows]);
  const reloadStored = useCallback(() => {
    if (request && !engine.running) void engine.loadStored(request);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, engine.running, engine.loadStored]);
  const addManual = useCallback(async (flight: ManualFlight, values: ManualPriceValues) => {
    if (!api) throw new Error("The flight database is not connected yet.");
    const added = await api.addManualOffer({ ...flight, ...values.party, price: values.eur, agent: values.agent, deeplink: values.deeplink });
    const forThisSearch = (Object.keys(manualParty) as (keyof typeof manualParty)[])
      .every((key) => manualParty[key] === values.party[key]);
    if (disabledSources.includes(MANUAL_SOURCE)) setDisabledSources((was) => was.filter((name) => name !== MANUAL_SOURCE));
    const day = flight.depart ?? flight.outbound?.[0]?.departure.slice(0, 10) ?? "";
    const sameKind = Boolean(flight.ret || flight.inbound?.length) === Boolean(ret);
    const onScreen = forThisSearch && sameKind && day >= start && day <= (end || start);
    setToast(!forThisSearch ? "Price added for another party. Change Travellers to see it."
      : !sameKind ? `Price added for a ${ret ? "one-way" : "round"} trip. Search for one to see it.`
      : !onScreen ? "Price added for a date outside the ones on screen." : "Price added");
    if (onScreen) pickFlight(added.trip_key);
    reloadStored();
  }, [api, manualParty, disabledSources, start, end, ret, pickFlight, reloadStored]);
  const manualActions = useMemo<ManualActions | undefined>(() => api ? {
    party: manualParty,
    add: (row, values) => addManual({ origin: origin.trim(), destination: destination.trim(), trip_key: row.trip_key,
      depart: row.depart_date, ret: row.return_date || null }, values),
    update: async (entryId, values) => {
      await api.updateManualOffer(entryId, { price: values.eur, agent: values.agent, deeplink: values.deeplink });
      reloadStored();
    },
    remove: async (entryId) => {
      await api.deleteManualOffer(entryId);
      setToast("Price deleted");
      reloadStored();
    },
    editFlight: setEditingFlight,
  } : undefined, [api, manualParty, origin, destination, addManual, reloadStored]);
  /** New flights for every price you added to it, then the old entries go. */
  const replaceManualFlight = useCallback(async (row: FlightRow, flight: ManualFlight) => {
    if (!api) throw new Error("The flight database is not connected yet.");
    const entries = row.offers.filter((offer) => isManual(offer) && offer.entry_id != null);
    let moved = row.trip_key;
    for (const offer of entries) {
      const added = await api.addManualOffer({ ...flight, ...manualParty, price: offer.price_base ?? offer.price,
        agent: offer.agent, deeplink: offer.deeplink });
      moved = added.trip_key;
      await api.deleteManualOffer(offer.entry_id!);
    }
    setToast("Flight updated");
    pickFlight(moved);
    reloadStored();
  }, [api, manualParty, pickFlight, reloadStored]);

  // Wait for the sidecar to come up. Nothing announces the wait: until it
  // answers there are no sources, and the queue panel says so in the one
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
          client.sources().then((known) => { if (live) setKnownSources(known); }).catch(() => {});
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
   * much room the pinned parts take — and both of them move. The header wraps
   * onto a second line on a narrow window; the panel, once it is stacked
   * across the top, is as tall as whatever it is holding. CSS cannot measure
   * either, so this does.
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
  // render is measured before it paints, which covers a flight being picked.
  // A resize covers the layout changing shape underneath us — at the
  // breakpoint the panel goes from full-height column to a capped band, and
  // React is never told. The observer catches the rest.
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
   * Escape on a date picker means something else entirely. Open popovers take
   * Escape for themselves before it gets here.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End", "Escape"].includes(event.key)) return;
      if (event.altKey || event.metaKey || event.ctrlKey) return;

      const focused = document.activeElement?.tagName;
      if (focused === "INPUT" || focused === "SELECT" || focused === "TEXTAREA") return;
      // An open dialog owns the keyboard, Escape included.
      if (document.querySelector("dialog[open]")) return;

      if (event.key === "Escape") {
        event.preventDefault();
        pickFlight(null);      // back to the queue
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
      pickFlight(shown[to]!.trip_key);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown, openKey, pickFlight]);

  const openRow = shown.find((row) => row.trip_key === openKey) ?? null;
  const listView = useMemo(() => JSON.stringify({ sort, filters }), [sort, filters]);

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
      if (target.closest("input, select, button, label, a, dialog, .popover, .flight-filter-panel")) return;
      pickFlight(null);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [openKey, pickFlight]);

  const party = describeParty(adults, children, infants, cabin);
  const stats = rangeStats(queue.selected);
  const loading = !request ? null
    : engine.running ? (askSources ? "Searching the chosen sources…" : "Searching every source…")
    : !api || engine.loadingStored ? "Loading flights…" : null;
  const tripWord = `${trips} trip${trips === 1 ? "" : "s"}`;
  const asked = askSources ? `the ${askSources.length === 1 ? "chosen source" : `${askSources.length} chosen sources`}` : "every source";
  const empty: EmptyState = connectionRecovery ? {
    title: "No flights match your connection preferences.",
    body: filters.maxLayoverMinutes !== null
      ? `Every stored flight has a connection longer than ${elapsed(filters.maxLayoverMinutes)}, or revisits an airport.`
      : "Every stored flight revisits an airport on the way.",
    action: connectionRecovery,
  } : !priceRows.length && correctedRows.length ? {
    title: "The chosen sources have no flights stored here.",
    body: `${correctedRows.length.toLocaleString()} flight${correctedRows.length === 1 ? " is" : "s are"} stored from the sources you turned off.`,
    action: { label: "Show every source", onClick: () => setDisabledSources([]) },
  } : priceRows.length ? {
    title: "Nothing matches these limits.",
    body: "Relax a filter or reset them all. Filters never delete stored results.",
    action: { label: "Reset filters", onClick: () => setFilters(DEFAULT_FILTERS) },
  } : request && queue.state && !stats.groups ? {
    title: "Nothing stored for this search yet",
    body: `No source has been asked about ${request.origin.toUpperCase()} → ${request.destination.toUpperCase()}, `
      + `${readableRange(start, end || start)}${ret ? ` / ${readableRange(ret, retEnd || ret)}` : ", one way"} for ${party}. `
      + (trips === 1 ? `Fetch asks ${asked} for it.` : `Fetch asks ${asked} for each of the ${tripWord}.`),
    action: trips > 0 ? { label: `Fetch ${tripWord}`, onClick: () => fetchRange(false) } : undefined,
  } : request && rangeComplete(queue, trips, wantedSources) ? {
    title: "No flights found",
    body: askSources ? "The chosen sources answered for these dates, and none of them had a flight."
      : "Every source answered for these dates, and none of them had a flight.",
  } : { title: "No flights to show." };

  const cheapest = shown.reduce<number | null>((low, row) => row.best?.price_base == null ? low
    : low === null ? row.best.price_base : Math.min(low, row.best.price_base), null);
  const activeSearches = splitQueueGroups(queue.groups, queue.busy?.groupIds).active.length;

  return (
    <AirportNamesProvider api={api}><div className="app">
      <header className="topbar" ref={header}>
        <div className="search-bar" role="search" aria-label="Flight search">
          <PlaceInput label="From" value={origin} onChange={setOrigin} api={api}
            open={popover === "from"} onToggle={toggles.from} />
          <PlaceInput label="To" value={destination} onChange={setDestination} api={api}
            open={popover === "to"} onToggle={toggles.to} />
          {/* Each departure day is priced against each return day. */}
          <RangePicker
            label="Depart"
            from={start}
            to={end || start}
            min={todayISO()}
            relatedRange={{ from: ret, to: retEnd || ret, label: "Return" }}
            open={popover === "depart"} onToggle={toggles.depart}
            onChange={(from, to) => { setStart(from); setEnd(to); }}
          />
          <RangePicker
            label="Return"
            selectionSide="right"
            from={ret}
            to={retEnd || ret}
            min={start || todayISO()}
            optional
            empty="One way"
            relatedRange={{ from: start, to: end || start, label: "Departure" }}
            open={popover === "return"} onToggle={toggles.return}
            onChange={(from, to) => { setRet(from); setRetEnd(to); }}
          />
          <TravellersPicker party={{ adults, children, infants, cabin, currency: askCurrency }} currencies={CURRENCIES}
            open={popover === "travellers"} onToggle={toggles.travellers}
            onChange={(next) => {
              if (next.adults !== undefined) setAdults(next.adults);
              if (next.children !== undefined) setChildren(next.children);
              if (next.infants !== undefined) setInfants(next.infants);
              if (next.cabin) setCabin(next.cabin);
              if (next.currency) setAskCurrency(next.currency);
            }} />
          <SourcesPicker known={knownSources} disabled={disabledSources}
            open={popover === "sources"} onToggle={toggles.sources} onChange={setDisabledSources} />
          <FetchButton queue={queue} trips={trips} sources={wantedSources} canSearch={Boolean(api && request) && !nothingToAsk}
            fetching={engine.running} onFetch={fetchRange} />
        </div>

        <div className="topbar-actions">
          <UpdateControls busy={engine.running || Boolean(queue.busy) || queue.offline || !queue.state
            || Boolean(queue.state.scheduler.running || queue.state.scheduler.queued)} />
          <RangeStatus queue={queue} trips={trips} sources={wantedSources} canSearch={Boolean(api && request)} />
        </div>
      </header>

      <main className="results-pane">
        {/* These display controls do not request new results from a source. */}
        <div className="results-bar">
          <div className="results-summary">
            <h1>{loading && !priceRows.length ? "Searching…" : priceRows.length
              ? `${shown.length.toLocaleString()} flight${shown.length === 1 ? "" : "s"}` : "No flights"}</h1>
            <span>{shown.length && cheapest !== null ? `from ${money(cheapest)} · ` : ""}prices for {party}
              {engine.running && shown.length ? " · more arriving" : ""}</span>
            <div className="sort-options" role="group" aria-label="Sort by">
              {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => <button type="button" key={key}
                aria-pressed={sort === key} onClick={() => setSort(key)}
                title={key === "best" ? "Balances price and total travel time, including the return and layovers" : undefined}>
                {SORT_LABELS[key]}</button>)}
            </div>
          </div>
          <div className="results-controls">
            <FlightFiltersBar filters={filters} onChange={setFilters} shown={shown.length} total={priceRows.length}
              roundTrip={Boolean(ret)} suggestions={suggestions} connectionOptions={connectionOptions} />
            <div className="results-view-controls">
              <button type="button" className="view-control" aria-label={`Timeline scale: ${timelineMode === "days" ? "per trip" : "shared"}`}
                title="Per trip: each row spans whole days from 05:00. Shared: all rows align on one scale per direction."
                onClick={() => setTimelineMode((mode) => mode === "days" ? "shared" : "days")}>
                Scale <b>{timelineMode === "days" ? "Per trip" : "Shared"}</b>
              </button>
              <CurrencyInput />
            </div>
          </div>
        </div>

        <Results
          rows={shown}
          dataset={priceRows}
          view={listView}
          loading={loading}
          empty={empty}
          openKey={openKey}
          onOpen={(key) => pickFlight(key === openKey ? null : key)}
          favorites={favorites}
          onToggleFavorite={toggleFavorite}
          ratings={ratings}
          timelines={timelines}
          timelineMode={timelineMode}
          layoverRatings={layoverRatings}
        />
      </main>

      <aside className="side" ref={side} aria-label="Flight and search queue">
        <div className="side-tabs" role="tablist" aria-label="Side panel">
          <button type="button" role="tab" id="tab-flight" aria-selected={tab === "flight"} aria-controls="panel-flight"
            onClick={() => setTab("flight")}>Flight</button>
          <button type="button" role="tab" id="tab-queue" aria-selected={tab === "queue"} aria-controls="panel-queue"
            onClick={() => setTab("queue")}>Queue<span className="side-tab-count">{activeSearches}</span>
            {pending.length > 0 && <span className="side-tab-alert" role="img" aria-label="Verification needed" />}</button>
          <span className="side-hint" aria-hidden="true">↑ ↓ to browse · Esc</span>
        </div>
        <div className="side-body">
          <div role="tabpanel" id="panel-queue" aria-labelledby="tab-queue" hidden={tab !== "queue"}>
            <ChallengeBanner
              api={api}
              pending={pending}
              canSolveHere={canSolveHere}
              viewerUrl={viewerUrl}
              onCleared={refreshChallenges}
            />
            <Queue queue={queue} />
          </div>
          <div role="tabpanel" id="panel-flight" aria-labelledby="tab-flight" hidden={tab !== "flight"}>
            {openRow ? <Details
              row={openRow}
              rating={ratings.get(openRow.trip_key)}
              layoverRatings={layoverRatings}
              onCorrectPrice={correctPrice}
              manual={manualActions}
              favorite={favorites.has(openRow.trip_key)}
              onToggleFavorite={toggleFavorite}
              partyLabel={party}
              onOpenBooking={(seller) => setToast(`Opening ${seller} in your browser…`)}
            /> : <p className="side-note">Select a flight to see its full itinerary, connections and every seller's price.</p>}
          </div>
        </div>
      </aside>
      {toast && <div className="toast" role="status">{toast}</div>}
      <EditFlightDialog editing={editingFlight} onClose={() => setEditingFlight(null)}
        rows={correctedRows} carriers={carriers} party={manualParty} api={api}
        search={{ origin: origin.trim(), destination: destination.trim() }}
        onReplace={replaceManualFlight} />
    </div></AirportNamesProvider>
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

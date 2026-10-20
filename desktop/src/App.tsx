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
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import {
  FlightScraperApi,
  type Cabin,
  type FlightRow,
  type Leg,
  type PendingChallenge,
  type SearchRequest,
  type SourceName,
} from "./api";
import { apiBase } from "./platform";
import { CURRENCIES, CurrencyProvider, useCurrency } from "./currency";
import { RangePicker, daysBetween, todayISO } from "./RangePicker";
import { Details } from "./Details";
import { ChallengeBanner } from "./ChallengeBanner";
import { Queue } from "./Queue";
import { useFlights } from "./useFlights";
import { useQueue } from "./useQueue";
import { RangeStatus } from "./RangeStatus";
import { rangeStats } from "./queueModel";
import { Icon } from "./Icon";

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

/** The airports actually touched: BER → STN → CDG, connections included. */
function pathOf(leg: Leg | null, fallback: string): string[] {
  const segments = leg?.segments ?? [];
  if (!segments.length) {
    return leg
      ? [leg.origin_airport, leg.destination_airport]
      : fallback.split("-");
  }
  return [segments[0]!.origin, ...segments.map((segment) => segment.destination)];
}

const clockOf = (iso: string) => (iso || "").slice(11, 16);

/** Whole days between departure and arrival, for the "+1" an overnight needs. */
function dayShift(from: string, to: string): number {
  const a = Date.parse(`${(from || "").slice(0, 10)}T00:00:00`);
  const b = Date.parse(`${(to || "").slice(0, 10)}T00:00:00`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/** One direction as `21:15 BER → STN → CDG 12:20`. */
function Itinerary({ leg, fallback }: { leg: Leg | null; fallback: string }) {
  if (!leg) return null;
  const stops = pathOf(leg, fallback);
  const shift = dayShift(leg.departure, leg.arrival);
  return (
    <span className="itin">
      <span className="clock">{clockOf(leg.departure)}</span>
      <span className="path">
        {stops.map((code, index) => (
          <span key={`${code}-${index}`}>
            {index > 0 && <Icon name="arrow-right" className="arrow" />}
            {code}
          </span>
        ))}
      </span>
      <span className="clock">{clockOf(leg.arrival)}</span>
      {shift > 0 && <span className="nextday">+{shift}</span>}
    </span>
  );
}

/** How the list is ordered. The database only ever hands it back cheapest-first. */
type SortKey = "price" | "depart" | "duration" | "stops";

const SORT_LABELS: Record<SortKey, string> = {
  price: "Cheapest",
  depart: "Departure",
  duration: "Shortest",
  stops: "Fewest stops",
};

/** Minutes in the air, from the timestamps; the printed duration is a fallback. */
function minutesOf(row: FlightRow): number {
  const from = Date.parse(row.departure), to = Date.parse(row.arrival);
  if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
    return (to - from) / 60_000;
  }
  const match = /(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?/.exec(row.duration || "");
  return (+(match?.[1] ?? 0)) * 60 + (+(match?.[2] ?? 0)) || Infinity;
}

/**
 * Reorder what is on screen — never re-query.
 *
 * These rows are the cheapest few hundred for this search, chosen by price
 * before they got here. Sorting by anything else re-orders that set; it does
 * not go looking for a shorter flight that was too dear to make the list.
 */
function sortRows(rows: FlightRow[], key: SortKey): FlightRow[] {
  const priceOf = (row: FlightRow) => row.best?.price_base ?? Infinity;
  // Ties fall back to price, or two flights of equal length look shuffled.
  const by = (rank: (row: FlightRow) => number) =>
    [...rows].sort((a, b) => rank(a) - rank(b) || priceOf(a) - priceOf(b));

  switch (key) {
    case "depart":
      return by((row) => Date.parse(row.departure) || Date.parse(`${row.depart_date}T00:00`));
    case "duration":
      return by(minutesOf);
    case "stops":
      return by((row) => row.outbound?.stops ?? row.stops ?? 9);
    default:
      return by(priceOf);
  }
}

/**
 * The results, as a list rather than a table.
 *
 * There are no headers because none are needed: a price, a date, an itinerary
 * and a duration each announce themselves. Airlines, stop counts and every
 * seller's price live in the side panel, which is what keeps a row scannable.
 */
function Results(
  { rows, total, openKey, onOpen }:
  {
    rows: FlightRow[]; total: number; openKey: string | null;
    onOpen: (key: string) => void;
  },
) {
  const { money } = useCurrency();
  const list = useRef<HTMLDivElement | null>(null);
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
    estimateSize: () => 69,
    overscan: 10,
    scrollMargin: listTop,
    getItemKey: (index) => rows[index]?.trip_key ?? index,
  });

  // Arrow keys walk the selection past the edge of the screen, so the page has
  // to follow it. The neighbouring row is nearly always mounted thanks to the
  // overscan, and moving to a *rendered* row keeps `scroll-margin-top` doing
  // its job of clearing the sticky bar; only a jump to somewhere far away —
  // Home, End — has to be handed to the virtualiser.
  const index = openKey ? rows.findIndex((row) => row.trip_key === openKey) : -1;
  useEffect(() => {
    if (index < 0) return;
    const node = list.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    if (node) node.scrollIntoView({ block: "nearest" });
    else virtual.scrollToIndex(index, { align: "center" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openKey]);

  if (total === 0) return <p className="muted empty-results">no flights to show</p>;

  const items = virtual.getVirtualItems();

  return (
    <div
      className="results"
      role="listbox"
      aria-label="Flights"
      ref={list}
      // The full height stands in for the rows that are not there, so the
      // scrollbar means what it says.
      style={{ height: virtual.getTotalSize(), position: "relative" }}
    >
      {items.map((item) => {
        const row = rows[item.index]!;
        const isOpen = row.trip_key === openKey;
        return (
          <div
            key={item.key}
            data-index={item.index}
            ref={virtual.measureElement}
            role="option"
            aria-selected={isOpen}
            aria-posinset={item.index + 1}
            aria-setsize={rows.length}
            className={isOpen ? "flight picked" : "flight"}
            onClick={() => onOpen(row.trip_key)}
            style={{
              position: "absolute", top: 0, left: 0, width: "100%",
              transform: `translateY(${item.start - virtual.options.scrollMargin}px)`,
            }}
          >
            <span className="price">{money(row.best?.price_base)}</span>
            {/* Both dates, stacked to line up with the two itineraries beside
                them. The return date matters more than it used to: a search is
                a range of departures against a range of returns, so two rows
                leaving on the same day can be different trips entirely. */}
            <span className="day">
              {readableDay(row.depart_date)}
              {row.return_date && (
                <div className="back">{readableDay(row.return_date)}</div>
              )}
            </span>
            <span className="trip">
              <Itinerary leg={row.outbound} fallback={row.route} />
              {/* A round trip is half-described by its outbound alone. */}
              {row.inbound ? (
                <div className="back">
                  <Itinerary leg={row.inbound} fallback={row.route} />
                </div>
              ) : row.return_date && (
                // The seller priced the round trip without saying which flight
                // comes back. Saying so beats a row that reads as a cheaper
                // one-way — and the return date above still says when.
                <div className="back no-detail">return not detailed</div>
              )}
            </span>
            <span className="dur">
              {row.duration}
              {row.return_duration && (
                <div className="back">{row.return_duration}</div>
              )}
            </span>
          </div>
        );
      })}
    </div>
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
  const [sort, setSort] = useState<SortKey>("price");

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
  const { currency, setCurrency } = useCurrency();

  const shown = useMemo(() => sortRows(engine.rows, sort), [engine.rows, sort]);

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
      void engine.runSearch({ ...request, refresh });
    }
  }, [request, trips, engine.running, engine.runSearch, queue.busy]);

  // Wait for the sidecar to come up. Nothing announces the wait: until it
  // answers there are no sources, and the source panel says so in the one
  // place that is already about them.
  useEffect(() => {
    let live = true;
    (async () => {
      const client = new FlightScraperApi(await apiBase());
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
    engine.selectView();
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
      if (target.closest("input, select, button, label, a, .cal-popup")) return;
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
          <label>From
            <input value={origin} onChange={(e) => setOrigin(e.target.value)} required />
          </label>
          <label>To
            <input value={destination} onChange={(e) => setDestination(e.target.value)} required />
          </label>
          {/* Two ranges, not one span. Each departure day is priced against
              each return day, so widening either one multiplies what a scrape
              has to ask for — which is what the trip count next to them is
              for. */}
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
          <span className="trip-count muted" title="what one scrape asks each source">
            {trips} {trips === 1 ? "trip" : "trips"}
          </span>

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
        {/* What is on screen, and the two knobs that only change how it reads:
            neither sorting nor the display currency asks a source anything. */}
        <div className="results-bar">
          <label className="inline">
            Sort by
            <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
              {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
                <option key={key} value={key}>{SORT_LABELS[key]}</option>
              ))}
            </select>
          </label>

          <label className="inline">
            Show prices in
            <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {CURRENCIES.map((code) => <option key={code} value={code}>{code}</option>)}
            </select>
          </label>
        </div>

        <Results
          rows={shown}
          total={engine.total}
          openKey={openKey}
          onOpen={setOpenKey}
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
    apiBase().then((base) => setApi(new FlightScraperApi(base))).catch(() => {});
  }, []);
  return (
    <CurrencyProvider api={api}>
      <Shell />
    </CurrencyProvider>
  );
}

export type { SourceName };

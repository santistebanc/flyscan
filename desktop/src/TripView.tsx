/**
 * One trip across the whole window: its price, time and stops, then each
 * direction drawn to scale on one axis for every trip, stepped through with
 * Prev and Next, the arrow keys or a swipe. In Outbound first and Return
 * first it steps through one direction's flights, then the pairs of the one
 * picked, as the list does.
 */
import { useLayoutEffect, useRef, useState, type ReactNode, type TouchEvent } from "react";
import type { FlightRow, Leg, Offer } from "./api";
import type { Rating } from "./flightRatings";
import type { ConnectionRatings } from "./connectionRatings";
import type { DirectionTimes } from "./flightFilters";
import { clock, elapsed, journeyTiming, percent, timelineScaleFor, wallDay, type FlightTimelines, type JourneyTiming,
  type TimelineScale } from "./flightTimeline";
import { otherDirection, type Direction, type PickGroup } from "./pairPicking";
import { JourneyTimeline } from "./JourneyTimeline";
import { TimeHandles, type TimesPatch, type View } from "./TimeHandles";
import { FavoriteButton } from "./FavoriteButton";
import { Icon } from "./Icon";
import { useCurrency } from "./currency";
import { openExternal } from "./platform";
import { MANUAL_LABEL, isManual } from "./manualEntry";
import { placeIn, tripStats, type Bin, type Distribution, type StatKey, type TripDistributions, type TripStats } from "./tripStats";

type JourneyRating = { price?: Rating; outbound?: Rating; inbound?: Rating };
const ZOOMS = [1, 1.5, 2, 3, 4];
/** How far a finger travels sideways before a swipe turns the trip. */
const SWIPE = 60;
const sellerName = (offer: Offer) => offer.agent || (isManual(offer) ? MANUAL_LABEL : offer.source);
const stopsText = (stops: number) => stops === 0 ? "Nonstop" : `${stops} stop${stops === 1 ? "" : "s"}`;
const TITLES: Record<Direction, string> = { outbound: "Outbound", inbound: "Return" };

/** What the Trip view steps through: every pair, one direction's flights to pick one from, or the pairs of the one picked. */
export type TripStage =
  | { kind: "pairs" }
  | { kind: "pick"; direction: Direction; groups: ReadonlyMap<string, PickGroup>; onPick: (key: string) => void }
  | { kind: "pair"; pinned: PickGroup; onChange: () => void };

/** What a trip beats, said per figure: lower is better for all four. */
const STANDING: Record<StatKey, { best: string; better: string; worst: string }> = {
  price: { best: "The cheapest", better: "Cheaper than", worst: "None cost more" },
  duration: { best: "The shortest", better: "Shorter than", worst: "None take longer" },
  layover: { best: "The least waiting", better: "Less waiting than", worst: "None wait longer" },
  stops: { best: "The fewest stops", better: "Fewer stops than", worst: "None have more stops" },
};

/** How many trips have each value, with this trip's bar lit and its value marked. */
function DistributionChart({ stat, label, dist, value, format, noun }: {
  stat: StatKey; label: string; dist: Distribution; value: number | null; format: (value: number) => string;
  /** What is counted, plural: "trips", or "outbounds" while picking one. */
  noun: string;
}) {
  const place = value === null ? null : placeIn(dist, value);
  const peak = Math.max(1, ...dist.bins.map((bin) => bin.count));
  const last = dist.bins.length - 1;
  const range = (bin: Bin, i: number) => dist.discrete || bin.from === bin.to ? format(bin.from)
    : i === last && dist.overflow ? `${format(bin.from)} and over` : `${format(bin.from)}–${format(bin.to)}`;
  const words = STANDING[stat];
  const standing = !place ? "" : place.best ? words.best
    : place.worse === 0 ? words.worst : `${words.better} ${Math.round(place.worse * 100)}% of ${noun}`;
  const count = dist.sorted.length;
  return <div className="trip-dist">
    <span className="trip-dist-plot">
      <svg viewBox={`0 0 ${dist.bins.length * 10} 40`} preserveAspectRatio="none" role="img"
        aria-label={`${label} across ${count.toLocaleString()} ${noun}, from ${format(dist.sorted[0]!)} to ${format(dist.sorted[count - 1]!)}`}>
        {dist.bins.map((bin, i) => {
          const height = bin.count ? Math.max(1.5, bin.count / peak * 38) : 0;
          return <rect key={i} x={i * 10 + 1} width={8} y={40 - height} height={height}
            className={i === place?.bin ? "current" : undefined}>
            <title>{`${range(bin, i)}: ${bin.count.toLocaleString()} ${bin.count === 1 ? noun.slice(0, -1) : noun}`}</title>
          </rect>;
        })}
      </svg>
      {place && <span className="trip-dist-mark" style={{ left: `${place.position * 100}%` }} aria-hidden="true" />}
    </span>
    <span className="trip-dist-ends" aria-hidden="true">
      <span>{format(dist.min)}</span><span>{format(dist.max)}{dist.overflow ? "+" : ""}</span>
    </span>
    {standing && <span key={standing} className="trip-dist-standing trip-anim-in">{standing}</span>}
  </div>;
}

/** A figure under its name, over how it spreads across the trips listed. */
function Stat({ stat, label, value, format, dist, noun, rating, hero = false }: {
  stat: StatKey; label: string; value: number | null; format: (value: number) => string;
  dist: Distribution | null; noun: string; rating?: Rating; hero?: boolean;
}) {
  const shown = value === null ? "–" : format(value);
  return <div className={`trip-stat${hero ? " hero" : ""}`}>
    <span className="trip-stat-label">{label}</span>
    {/* Keyed by what it says, so a new value slides in rather than just changing. */}
    <span key={shown} className="trip-stat-value trip-anim-in" data-rating={rating?.level} title={rating?.description}>{shown}</span>
    {dist && <DistributionChart stat={stat} label={label} dist={dist} value={value} format={format} noun={noun} />}
  </div>;
}

/**
 * One direction: its summary line, then its timeline with the time handles,
 * which zooms into a sideways scroll. `bare`: nothing matches, so the
 * timeline keeps its hours and handles but shows no flight.
 */
function DirectionView({ direction, leg, scale, timing, layoverRatings, rating, layover, times, onTimes, bare }: {
  direction: Direction; leg: Leg; scale: TimelineScale | null; timing: JourneyTiming | null | undefined;
  layoverRatings?: ReadonlyMap<number, Rating>; rating?: Rating; layover: number | null;
  times: DirectionTimes; onTimes: (direction: Direction, patch: TimesPatch) => void; bare?: boolean;
}) {
  const title = TITLES[direction];
  const [zoom, setZoom] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const resolved = timing ? timelineScaleFor(timing, scale, "shared") : null;
  const startShare = timing && resolved ? percent(timing.start, resolved) / 100 : 0;
  // Zoomed in, keep this trip's departure in view as the trips change.
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    node.scrollLeft = Math.max(0, startShare * node.scrollWidth - 48);
  }, [startShare, zoom]);
  // The share of the timeline in sight, so the handles can wait at its edges.
  const [view, setView] = useState<View>({ from: 0, to: 100 });
  const measure = () => {
    const node = scroller.current;
    if (!node || !node.scrollWidth) return;
    // Within a pixel or so of an end counts as the end, so rounding never leaves a handle "beyond" it.
    const share = (x: number) => x / node.scrollWidth * 100;
    const from = node.scrollLeft < 2 ? 0 : share(node.scrollLeft);
    const to = node.scrollWidth - node.scrollLeft - node.clientWidth < 2 ? 100 : share(node.scrollLeft + node.clientWidth);
    setView((was) => was.from === from && was.to === to ? was : { from, to });
  };
  useLayoutEffect(() => {
    measure();
    const node = scroller.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(measure);
    watch.observe(node);
    return () => watch.disconnect();
  }, [startShare, zoom]);
  return <section className="trip-direction" aria-label={title}>
    <div className="trip-direction-head">
      <h3>{title}</h3>
      {!bare && <><span key={leg.departure} className="trip-direction-day trip-anim-in">{wallDay(leg.departure)}</span>
      <span className="trip-direction-facts">
        <span>Duration <b key={leg.duration} className="trip-anim-in" data-rating={rating?.level} title={rating?.description}>
          {leg.duration || "–"}</b></span>
        <span>Layover <b key={String(layover)} className="trip-anim-in">{layover === null ? "–" : layover ? elapsed(layover) : "none"}</b></span>
        {leg.stops !== null && <span key={leg.stops} className="trip-anim-in">{stopsText(leg.stops)}</span>}
      </span></>}
      <span className="trip-zoom" role="group" aria-label={`Zoom the ${title.toLowerCase()} timeline`}>
        <button type="button" aria-label="Zoom out" title="Zoom out" disabled={zoom === 0} onClick={() => setZoom((z) => z - 1)}>−</button>
        <button type="button" aria-label="Zoom in" title="Zoom in" disabled={zoom === ZOOMS.length - 1} onClick={() => setZoom((z) => z + 1)}>+</button>
      </span>
    </div>
    <div className="trip-timeline-scroll" ref={scroller} data-zoomed={zoom > 0 || undefined} onScroll={measure}>
      <div className="trip-timeline" style={{ width: `${ZOOMS[zoom]! * 100}%` }}>
        <JourneyTimeline leg={leg} title={title} scale={scale} layoverRatings={layoverRatings} bare={bare} />
        {timing && resolved && <TimeHandles timing={timing} scale={resolved} times={times} title={title} view={view}
          onChange={(patch) => onTimes(direction, patch)} />}
      </div>
    </div>
  </section>;
}

/** The flight picked first, kept above the pairs it is sold in. */
function Pinned({ pinned, onChange }: { pinned: PickGroup; onChange: () => void }) {
  const leg = pinned.leg;
  return <div className="trip-pinned">
    <span className="trip-pinned-what">{TITLES[pinned.direction]} picked</span>
    <span className="trip-pinned-flight">{leg ? [wallDay(leg.departure),
      `${leg.origin_airport} ${clock(leg.departure)} → ${leg.destination_airport} ${clock(leg.arrival)}`, leg.flight_numbers]
      .filter(Boolean).join(" · ") : `Not detailed · ${pinned.date}`}</span>
    <button type="button" onClick={onChange} title="Pick another (Esc)">Change</button>
  </div>;
}

export function TripView({ rows, at, onStep, stage, figures, ratings, distributions, timelines, layoverRatings, times, onTimes,
  favorite, onToggleFavorite, onOpenBooking, queue, details, empty }: {
  rows: FlightRow[]; at: number; onStep: (index: number) => void;
  stage: TripStage;
  /** Each row's figures, from `tripStats`, in the order of `rows`. */
  figures: TripStats[];
  /** Each figure over every row, from `tripDistributions`. */
  distributions: TripDistributions;
  ratings: ReadonlyMap<string, JourneyRating>; timelines: FlightTimelines; layoverRatings: ConnectionRatings;
  /** The time filters, which the handles on each timeline set. */
  times: Record<Direction, DirectionTimes>; onTimes: (direction: Direction, patch: TimesPatch) => void;
  favorite: boolean; onToggleFavorite: (key: string) => void;
  /** Told after a booking page was handed to the browser. */
  onOpenBooking?: (seller: string) => void;
  /** The way to the search queue, which has no panel here. */
  queue?: ReactNode;
  /** Booking options and the itinerary, shown on request below the timelines. */
  details: ReactNode;
  /**
   * Set when the filters leave nothing: `rows` then holds the last trip shown,
   * drawn dimmed under this notice, its time handles still there to relax a limit with.
   */
  empty?: { title: string; body?: string; action?: { label: string; onClick: () => void } };
}) {
  const { money } = useCurrency();
  const [showDetails, setShowDetails] = useState(false);
  const [bookError, setBookError] = useState("");
  const touch = useRef<{ x: number; y: number; scrolls: boolean } | null>(null);
  const row = rows[at];
  if (!row) return null;
  // With nothing matching, the figures read as dashes: the trip drawn is only the last one seen.
  const stats: TripStats = empty ? { price: null, duration: null, layover: null, stops: null } : figures[at] ?? tripStats(row);
  const picking = stage.kind === "pick" ? stage : null;
  const group = picking?.groups.get(row.trip_key);
  const rating = picking ? undefined : ratings.get(row.trip_key);
  // What Prev and Next step through, named on the counter and in the charts.
  const noun = picking ? TITLES[picking.direction] : stage.kind === "pair" ? TITLES[otherDirection(stage.pinned.direction)] : "Trip";
  const nouns = `${noun.toLowerCase()}s`;
  const best = picking || empty ? undefined : [...row.offers].filter((offer) => offer.deeplink)
    .sort((a, b) => (a.price_base ?? Infinity) - (b.price_base ?? Infinity))[0];
  const step = (by: number) => {
    const to = at + by;
    if (to >= 0 && to < rows.length) onStep(to);
  };
  const format: Record<StatKey, (value: number) => string> = {
    price: (value) => money(value), duration: elapsed, layover: (value) => value ? elapsed(value) : "none",
    stops: (value) => String(value),
  };
  const onTouchStart = (event: TouchEvent) => {
    const finger = event.touches[0];
    // A zoomed timeline scrolls sideways under the finger, and a handle drags; neither is a swipe.
    const scrolls = Boolean((event.target as HTMLElement).closest(".trip-timeline-scroll[data-zoomed], .time-handle"));
    touch.current = finger && event.touches.length === 1 ? { x: finger.clientX, y: finger.clientY, scrolls } : null;
  };
  const onTouchEnd = (event: TouchEvent) => {
    const start = touch.current, finger = event.changedTouches[0];
    touch.current = null;
    if (!start || start.scrolls || !finger) return;
    const dx = finger.clientX - start.x, dy = finger.clientY - start.y;
    if (Math.abs(dx) >= SWIPE && Math.abs(dx) > 1.5 * Math.abs(dy)) step(dx < 0 ? 1 : -1);
  };
  const direction = (which: Direction) => {
    const leg = row[which];
    if (!leg) return which === "inbound" && row.return_date
      ? <p key={which} className="detail-missing-return">Return flight details unavailable. The seller priced the round trip without saying which flight comes back.</p>
      : null;
    // Timings are kept per leg object; a trip kept on from rows since reloaded has its own, worked out afresh.
    const timing = timelines.journeys.has(leg) ? timelines.journeys.get(leg) : journeyTiming(leg);
    return <DirectionView key={which} direction={which} leg={leg} scale={timelines[which]} timing={timing}
      layoverRatings={layoverRatings[which]} rating={rating?.[which]} layover={tripStats(row, which).layover}
      times={times[which]} onTimes={onTimes} bare={Boolean(empty)} />;
  };
  const other = picking ? TITLES[otherDirection(picking.direction)].toLowerCase() : "";
  return <section className="trip-view" aria-label="Trip" data-empty={empty ? true : undefined}
    onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
    {stage.kind === "pair" && <Pinned pinned={stage.pinned} onChange={stage.onChange} />}
    <nav className="trip-nav" aria-label={`Browse ${nouns}`}>
      <button type="button" className="trip-nav-first" aria-label={`First ${noun.toLowerCase()}`} title="First (Home)"
        disabled={Boolean(empty) || at === 0} onClick={() => onStep(0)}><Icon name="chevron-left" /><Icon name="chevron-left" /></button>
      <button type="button" aria-label={`Previous ${noun.toLowerCase()}`} title="Previous (←)" disabled={Boolean(empty) || at === 0}
        onClick={() => step(-1)}><Icon name="chevron-left" /><span className="trip-nav-text">Prev</span></button>
      <button type="button" aria-label={`Next ${noun.toLowerCase()}`} title="Next (→)" disabled={Boolean(empty) || at === rows.length - 1}
        onClick={() => step(1)}><span className="trip-nav-text">Next</span><Icon name="chevron-right" /></button>
      <span className="trip-counter" aria-live="polite">{empty ? <>No {nouns}</>
        : <>{noun} <b key={at} className="trip-anim-in">{(at + 1).toLocaleString()}</b> of {rows.length.toLocaleString()}</>}</span>
      <span className="trip-nav-end">
        {queue}
        {!picking && !empty && <FavoriteButton row={row} favorite={favorite} onToggle={onToggleFavorite} />}
        {picking && !empty && <button type="button" className="trip-book" onClick={() => picking.onPick(row.trip_key)}
          title={`See the ${other}s sold with this ${noun.toLowerCase()} (Enter)`}>
          Choose{group && <span className="trip-book-seller">{group.pairs.length} {other}{group.pairs.length === 1 ? "" : "s"}</span>}
          <Icon name="chevron-right" /></button>}
        {best && <button type="button" className="trip-book" title={`Book with ${sellerName(best)}`} onClick={() => {
          setBookError("");
          openExternal(best.deeplink).then(() => onOpenBooking?.(sellerName(best))).catch((e: Error) => setBookError(e.message));
        }}>Book<span className="trip-book-seller">{sellerName(best)}</span><Icon name="external" /></button>}
      </span>
    </nav>
    {bookError && <p className="detail-booking-error" role="alert">{bookError}</p>}
    {empty && <div className="trip-empty" role="status">
      <span className="trip-empty-text"><b>{empty.title}</b>{empty.body && <span>{empty.body}</span>}
        <span>Or drag a time handle back on a timeline below.</span></span>
      {empty.action && <button type="button" onClick={empty.action.onClick}>{empty.action.label}</button>}
    </div>}

    <div className="trip-stats">
      <Stat hero stat="price" label={picking ? "Price from" : "Price"} value={stats.price} format={format.price}
        dist={distributions.price} noun={nouns} rating={rating?.price} />
      <Stat stat="duration" label="Duration" value={stats.duration} format={format.duration} dist={distributions.duration} noun={nouns} />
      <Stat stat="layover" label="Layover" value={stats.layover} format={format.layover} dist={distributions.layover} noun={nouns} />
      <Stat stat="stops" label="Stops" value={stats.stops} format={format.stops} dist={distributions.stops} noun={nouns} />
    </div>

    {/* With nothing left, both directions' handles stay out, whichever limit ruled the trips out. */}
    {picking && !empty ? direction(picking.direction) : <>{direction("outbound")}{direction("inbound")}</>}

    {!picking && !empty && <div className="trip-details">
      <button type="button" className="trip-details-toggle" aria-expanded={showDetails} onClick={() => setShowDetails((open) => !open)}>
        <Icon name="chevron-right" className="caret" />Booking options and leg details</button>
      {showDetails && details}
    </div>}
  </section>;
}

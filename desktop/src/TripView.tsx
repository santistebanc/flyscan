/**
 * One trip across the whole window: its price, time and stops, then each
 * direction drawn to scale on one axis for every trip, stepped through with
 * Prev and Next, the arrow keys or a swipe.
 */
import { useLayoutEffect, useRef, useState, type ReactNode, type TouchEvent } from "react";
import type { FlightRow, Leg, Offer } from "./api";
import type { Rating } from "./flightRatings";
import type { ConnectionRatings } from "./connectionRatings";
import { elapsed, percent, timelineScaleFor, wallDay, type FlightTimelines, type TimelineScale } from "./flightTimeline";
import { JourneyTimeline } from "./JourneyTimeline";
import { FavoriteButton } from "./FavoriteButton";
import { Icon } from "./Icon";
import { useCurrency } from "./currency";
import { openExternal } from "./platform";
import { MANUAL_LABEL, isManual } from "./manualEntry";
import { tripStats, type StatKey } from "./tripStats";

type JourneyRating = { price?: Rating; outbound?: Rating; inbound?: Rating };
const ZOOMS = [1, 1.5, 2, 3, 4];
/** How far a finger travels sideways before a swipe turns the trip. */
const SWIPE = 60;
const sellerName = (offer: Offer) => offer.agent || (isManual(offer) ? MANUAL_LABEL : offer.source);
const stopsText = (stops: number) => stops === 0 ? "Nonstop" : `${stops} stop${stops === 1 ? "" : "s"}`;

/** A figure under its name; the filters above the trip are where the list is narrowed. */
function Stat({ label, value, format, rating, hero = false }: {
  label: string; value: number | null; format: (value: number) => string; rating?: Rating; hero?: boolean;
}) {
  return <div className={`trip-stat${hero ? " hero" : ""}`}>
    <span className="trip-stat-label">{label}</span>
    <span className="trip-stat-value" data-rating={rating?.level} title={rating?.description}>
      {value === null ? "–" : format(value)}</span>
  </div>;
}

/** One direction: its summary line, then its timeline, which zooms into a sideways scroll. */
function Direction({ title, leg, scale, timing, layoverRatings, rating, layover }: {
  title: string; leg: Leg; scale: TimelineScale | null; timing: ReturnType<FlightTimelines["journeys"]["get"]>;
  layoverRatings?: ReadonlyMap<number, Rating>; rating?: Rating; layover: number | null;
}) {
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
  return <section className="trip-direction" aria-label={title}>
    <div className="trip-direction-head">
      <h3>{title}</h3>
      <span className="trip-direction-day">{wallDay(leg.departure)}</span>
      <span className="trip-direction-facts">
        <span>Duration <b data-rating={rating?.level} title={rating?.description}>{leg.duration || "–"}</b></span>
        <span>Layover <b>{layover === null ? "–" : layover ? elapsed(layover) : "none"}</b></span>
        {leg.stops !== null && <span>{stopsText(leg.stops)}</span>}
      </span>
      <span className="trip-zoom" role="group" aria-label={`Zoom the ${title.toLowerCase()} timeline`}>
        <button type="button" aria-label="Zoom out" title="Zoom out" disabled={zoom === 0} onClick={() => setZoom((z) => z - 1)}>−</button>
        <button type="button" aria-label="Zoom in" title="Zoom in" disabled={zoom === ZOOMS.length - 1} onClick={() => setZoom((z) => z + 1)}>+</button>
      </span>
    </div>
    <div className="trip-timeline-scroll" ref={scroller} data-zoomed={zoom > 0 || undefined}>
      <div className="trip-timeline" style={{ width: `${ZOOMS[zoom]! * 100}%` }}>
        <JourneyTimeline leg={leg} title={title} scale={scale} layoverRatings={layoverRatings} />
      </div>
    </div>
  </section>;
}

export function TripView({ rows, at, onStep, ratings, timelines, layoverRatings, favorite, onToggleFavorite,
  onOpenBooking, queue, details }: {
  rows: FlightRow[]; at: number; onStep: (index: number) => void;
  ratings: ReadonlyMap<string, JourneyRating>; timelines: FlightTimelines;
  layoverRatings: ConnectionRatings; favorite: boolean; onToggleFavorite: (key: string) => void;
  /** Told after a booking page was handed to the browser. */
  onOpenBooking?: (seller: string) => void;
  /** The way to the search queue, which has no panel here. */
  queue?: ReactNode;
  /** Booking options and the itinerary, shown on request below the timelines. */
  details: ReactNode;
}) {
  const { money } = useCurrency();
  const [showDetails, setShowDetails] = useState(false);
  const [bookError, setBookError] = useState("");
  const touch = useRef<{ x: number; y: number; scrolls: boolean } | null>(null);
  const row = rows[at];
  if (!row) return null;
  const stats = tripStats(row);
  const rating = ratings.get(row.trip_key);
  const best = [...row.offers].filter((offer) => offer.deeplink)
    .sort((a, b) => (a.price_base ?? Infinity) - (b.price_base ?? Infinity))[0];
  const step = (by: number) => {
    const to = at + by;
    if (to >= 0 && to < rows.length) onStep(to);
  };
  const legLayover = (leg: Leg) => tripStats({ ...row, outbound: leg, inbound: null }).layover;
  const format: Record<StatKey, (value: number) => string> = {
    price: (value) => money(value), duration: elapsed, layover: (value) => value ? elapsed(value) : "none",
    stops: (value) => String(value),
  };
  const onTouchStart = (event: TouchEvent) => {
    const finger = event.touches[0];
    // A zoomed timeline scrolls sideways under the finger; it is not a swipe.
    const scrolls = Boolean((event.target as HTMLElement).closest(".trip-timeline-scroll[data-zoomed]"));
    touch.current = finger && event.touches.length === 1 ? { x: finger.clientX, y: finger.clientY, scrolls } : null;
  };
  const onTouchEnd = (event: TouchEvent) => {
    const start = touch.current, finger = event.changedTouches[0];
    touch.current = null;
    if (!start || start.scrolls || !finger) return;
    const dx = finger.clientX - start.x, dy = finger.clientY - start.y;
    if (Math.abs(dx) >= SWIPE && Math.abs(dx) > 1.5 * Math.abs(dy)) step(dx < 0 ? 1 : -1);
  };
  return <section className="trip-view" aria-label="Trip" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
    <nav className="trip-nav" aria-label="Browse trips">
      <button type="button" className="trip-nav-first" aria-label="First trip" title="First trip (Home)"
        disabled={at === 0} onClick={() => onStep(0)}><Icon name="chevron-left" /><Icon name="chevron-left" /></button>
      <button type="button" aria-label="Previous trip" title="Previous trip (←)" disabled={at === 0} onClick={() => step(-1)}>
        <Icon name="chevron-left" /><span className="trip-nav-text">Prev</span></button>
      <button type="button" aria-label="Next trip" title="Next trip (→)" disabled={at === rows.length - 1} onClick={() => step(1)}>
        <span className="trip-nav-text">Next</span><Icon name="chevron-right" /></button>
      <span className="trip-counter" aria-live="polite">Trip <b>{(at + 1).toLocaleString()}</b> of {rows.length.toLocaleString()}</span>
      <span className="trip-nav-end">
        {queue}
        <FavoriteButton row={row} favorite={favorite} onToggle={onToggleFavorite} />
        {best && <button type="button" className="trip-book" title={`Book with ${sellerName(best)}`} onClick={() => {
          setBookError("");
          openExternal(best.deeplink).then(() => onOpenBooking?.(sellerName(best))).catch((e: Error) => setBookError(e.message));
        }}>Book<span className="trip-book-seller">{sellerName(best)}</span><Icon name="external" /></button>}
      </span>
    </nav>
    {bookError && <p className="detail-booking-error" role="alert">{bookError}</p>}

    <div className="trip-stats">
      <Stat hero label="Price" value={stats.price} format={format.price} rating={rating?.price} />
      <Stat label="Duration" value={stats.duration} format={format.duration} />
      <Stat label="Layover" value={stats.layover} format={format.layover} />
      <Stat label="Stops" value={stats.stops} format={format.stops} />
    </div>

    <Direction title="Outbound" leg={row.outbound} scale={timelines.outbound} timing={timelines.journeys.get(row.outbound)}
      layoverRatings={layoverRatings.outbound} rating={rating?.outbound} layover={legLayover(row.outbound)} />
    {row.inbound ? <Direction title="Return" leg={row.inbound} scale={timelines.inbound} timing={timelines.journeys.get(row.inbound)}
      layoverRatings={layoverRatings.inbound} rating={rating?.inbound} layover={legLayover(row.inbound)} />
      : row.return_date && <p className="detail-missing-return">Return flight details unavailable. The seller priced the round trip without saying which flight comes back.</p>}

    <div className="trip-details">
      <button type="button" className="trip-details-toggle" aria-expanded={showDetails} onClick={() => setShowDetails((open) => !open)}>
        <Icon name="chevron-right" className="caret" />Booking options and leg details</button>
      {showDetails && details}
    </div>
  </section>;
}

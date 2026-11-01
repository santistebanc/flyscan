/** The selected journey: booking up front, then each leg in the list's carrier colors. */
import { useId, useState, type CSSProperties } from "react";
import type { FlightRow, Leg, Offer, Segment } from "./api";
import type { Rating } from "./flightRatings";
import type { ConnectionRatings } from "./connectionRatings";
import { openExternal } from "./platform";
import { useCurrency } from "./currency";
import { Icon } from "./Icon";
import { yearIfFar } from "./dates";
import { FavoriteButton } from "./FavoriteButton";
import { airlineColor, clock, dayOffset, elapsed, isOvernight, journeyTiming, partsOf, partLabel, timingNote } from "./flightTimeline";
import { AirportLabel } from "./AirportLabel";
import { OfferPriceEditor, type CorrectOfferPrice } from "./OfferPriceEditor";
import { formatCurrencyAmount } from "./currencyOptions";
import { MANUAL_LABEL, isManual, onlyManual } from "./manualEntry";
import { fullTime, timeAgo } from "./relativeTime";
import { PriceMark, priceMarks } from "./PriceMark";
import { ManualPriceForm, type ManualParty, type ManualPriceValues } from "./ManualPriceForm";

/** What the panel needs to add, change and remove prices typed in by hand. */
export interface ManualActions {
  party: ManualParty;
  add: (row: FlightRow, values: ManualPriceValues) => Promise<void>;
  update: (entryId: number, values: ManualPriceValues) => Promise<void>;
  remove: (entryId: number) => Promise<void>;
  editFlight: (row: FlightRow) => void;
}

const sellerName = (offer: Offer) => offer.agent || (isManual(offer) ? MANUAL_LABEL : offer.source);

type JourneyRating = { price?: Rating; outbound?: Rating; inbound?: Rating };
const dayOf = (iso: string) => (iso || "").slice(0, 10);
function dateLabel(iso: string, weekday = false) {
  const day = new Date(`${dayOf(iso)}T12:00:00Z`);
  return Number.isNaN(day.getTime()) ? "" : day.toLocaleDateString("en-US",
    { month: "short", day: "numeric", ...(weekday ? { weekday: "short" } : {}), ...yearIfFar(iso), timeZone: "UTC" });
}
const later = (from: string, to: string) => {
  const days = dayOffset(from, to);
  return days > 0 ? `+${days} day${days === 1 ? "" : "s"}` : "";
};

function FlightSegment({ segment, summary = false }: { segment: Segment; summary?: boolean }) {
  const who = summary ? `${segment.carrier_name || "Airline unavailable"} · Flight details unavailable`
    : [segment.carrier_name || segment.carrier || "Airline unavailable", segment.flight_number].filter(Boolean).join(" ")
      // A codeshare names who actually flies it, as the seller's page does.
      + (segment.operating_carrier_name || segment.operating_flight_number
        ? ` · operated by ${segment.operating_carrier_name || segment.operating_flight_number}` : "")
      + (segment.duration ? ` · ${segment.duration}` : "");
  const arrives = later(segment.departure, segment.arrival);
  return <div className={`detail-flight${summary ? " summary" : ""}`}
    style={{ "--airline": airlineColor(segment.carrier) } as CSSProperties}>
    <span className="detail-times">
      <time dateTime={segment.departure} title={`${dateLabel(segment.departure, true)} · Local airport time`}>{clock(segment.departure)}</time>
      <time dateTime={segment.arrival} title={`${dateLabel(segment.arrival, true)} · Local airport time`}>{clock(segment.arrival)}</time>
    </span>
    <span className="detail-rail" aria-hidden="true" />
    <span className="detail-stops">
      <span><AirportLabel code={segment.origin} showCountry /></span>
      <span className="detail-carrier">{who}</span>
      <span><AirportLabel code={segment.destination} showCountry />{arrives && <span className="detail-later"> {arrives}</span>}</span>
    </span>
  </div>;
}

function LegView({ leg, title, rating, layoverRatings }: { leg: Leg | null; title: string; rating?: Rating; layoverRatings?: ReadonlyMap<number, Rating> }) {
  if (!leg) return null;
  const segments = leg.segments ?? [];
  const connections = partsOf(leg).filter((part) => part.kind === "layover");
  const timing = journeyTiming(leg);
  const note = timing ? timingNote(timing) : undefined;
  const stops = leg.stops === 0 ? "Nonstop" : leg.stops == null ? "" : `${leg.stops} stop${leg.stops === 1 ? "" : "s"}`;
  return <section className="detail-journey" aria-label={`${title} itinerary`}>
    <div className="detail-journey-head">
      <h3>{title} <span>{[dateLabel(leg.departure, true), stops].filter(Boolean).join(" · ")}</span></h3>
      <span className="detail-leg-duration" data-rating={rating?.level} title={rating?.description}>{leg.duration}</span>
    </div>
    {note && <p className="detail-warning">{note}</p>}
    <ol className="detail-segments">
      {segments.length ? segments.map((segment, index) => {
        const gap = connections[index - 1];
        return <li key={index}>
          {gap?.kind === "layover" && <div className={`detail-connection${gap.transfer ? " transfer" : ""}`} title={partLabel(gap)}>
            <span className="detail-connection-what">{gap.transfer
              ? `Change airports ${gap.before.destination} → ${gap.after.origin}` : `Connect in ${gap.before.destination}`}</span>
            {" · "}
            <span className="detail-connection-duration" data-rating={gap.minutes === null ? undefined : layoverRatings?.get(gap.minutes)?.level}
              title={gap.minutes === null ? undefined : layoverRatings?.get(gap.minutes)?.description}>{gap.minutes !== null ? elapsed(gap.minutes) : "–"}</span>
            {isOvernight(gap) && <span className="detail-overnight"> · Overnight ☾</span>}
          </div>}
          <FlightSegment segment={segment} />
        </li>;
      }) : <li><FlightSegment summary segment={{
        origin: leg.origin_airport, destination: leg.destination_airport,
        departure: leg.departure, arrival: leg.arrival, duration: leg.duration,
        carrier: "", carrier_name: leg.airlines, flight_number: leg.flight_numbers,
      }} /></li>}
    </ol>
  </section>;
}

function Booking({ trip, offer, cheapest, onCorrectPrice, onOpen, manual }: {
  trip: string; offer: Offer; cheapest: boolean; onCorrectPrice?: CorrectOfferPrice; onOpen: (offer: Offer) => Promise<void>;
  manual?: ManualActions;
}) {
  const { money, nativeMoney } = useCurrency();
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const native = nativeMoney(offer.price, offer.currency);
  const original = offer.manual_price ? (offer.price == null ? money(offer.original_price_base) : formatCurrencyAmount(offer.price, offer.currency)) : "";
  const typed = isManual(offer);
  const entry = typed && manual && offer.entry_id != null ? offer.entry_id : null;
  const seller = offer.agent || (typed ? MANUAL_LABEL : offer.source);
  const stale = offer.stale_price_base;
  const changed = typed && Date.parse(offer.seen_at ?? "") - Date.parse(offer.added_at ?? "") > 60_000;
  const via = !typed && offer.agent && offer.agent !== offer.source ? offer.source : "";
  // Each phrase stays whole: a narrow panel breaks the line between them, and
  // the separating dot is drawn by CSS so one starting a line can be hidden.
  const meta = (typed ? [offer.agent ? MANUAL_LABEL : null, when("added", offer.added_at), changed ? when("changed", offer.seen_at) : null]
    : [!offer.manual_price && native ? `quoted ${native}` : null,
      offer.manual_price ? when("corrected", offer.corrected_at) : when("seen", offer.seen_at)])
    .filter(Boolean).map((part, index) => <span key={index} className="detail-meta-part">{part}</span>);
  if (entry !== null && editing) {
    return <div className="detail-booking">
      <ManualPriceForm initial={{ eur: offer.price_base, agent: offer.agent, deeplink: offer.deeplink }}
        party={manual!.party} partyEditable={false} submitLabel="Save price"
        onSubmit={async (values) => { await manual!.update(entry, values); setEditing(false); }}
        onCancel={() => setEditing(false)} />
    </div>;
  }
  return <div className="detail-booking">
    <div className="detail-booking-row">
      <span className="detail-seller">
        <span>{seller}{via && <span className="detail-booking-via"> via {via}</span>}</span>
        {meta.length > 0 && <span className="detail-booking-meta"><span className="detail-meta-parts">{meta}</span></span>}
        {error && <span className="detail-booking-error" role="alert">{error}</span>}
      </span>
      <span className="detail-booking-end">
        {original && <s className="detail-booking-original" title={`Source quote${offer.seen_at ? `, seen ${timeAgo(offer.seen_at)}` : ""}`}><span className="sr-only">Original source quote: </span>{original}</s>}
        {stale !== undefined && <s className="detail-booking-stale"
          title={`Your correction${offer.corrected_at ? ` from ${timeAgo(offer.corrected_at)}` : ""}. The source quoted again after it.`}>
          <span className="sr-only">Your earlier correction: </span>{money(stale)}</s>}
        <span className="detail-booking-price" data-cheapest={cheapest || undefined}>{money(offer.price_base)}</span>
        {offer.manual_price && <PriceMark kind="corrected" note={`Your corrected price. The source quoted ${original}.`} />}
        {stale !== undefined && <PriceMark kind="requoted"
          note={`The source quoted this after you corrected it to ${money(stale)}. Use the price button to reapply it.`} />}
        {entry !== null ? <button type="button" className="detail-icon-button" aria-label={`Edit the price you added for ${seller}`}
          title="Edit this price" onClick={() => setEditing(true)}><Icon name="edit" /></button>
          : onCorrectPrice && !typed && <button type="button" className="detail-icon-button" aria-label={`Correct price for ${seller}`}
          title={stale !== undefined ? `Reapply or replace your correction for ${seller}` : `Correct price for ${seller}`} aria-expanded={editing} onClick={() => setEditing((value) => !value)}><Icon name="price" /></button>}
        {entry !== null && <button type="button" className="detail-icon-button" aria-label={`Delete the price you added for ${seller}`}
          title="Delete this price" aria-expanded={confirming} onClick={() => setConfirming((value) => !value)}><Icon name="trash" /></button>}
        {offer.deeplink ? <button type="button" className="detail-icon-button"
          aria-label={`Open booking with ${seller}`} title={`Open booking with ${seller}`}
          onClick={() => onOpen(offer).catch((e: Error) => setError(e.message))}>
          <Icon name="external" />
        </button> : <span className="detail-icon-button unavailable" title="Booking link unavailable"><Icon name="input" /></span>}
      </span>
    </div>
    {editing && onCorrectPrice && !typed && <OfferPriceEditor trip={trip} offer={offer} onSave={onCorrectPrice} onClose={() => setEditing(false)} />}
    {confirming && entry !== null && <div className="detail-confirm" role="group" aria-label="Delete this price">
      <span>Delete this price? Stored prices from other sellers stay.</span>
      <button type="button" className="danger" onClick={() => {
        setError("");
        manual!.remove(entry).catch((e: Error) => { setError(e.message); setConfirming(false); });
      }}>Delete</button>
      <button type="button" onClick={() => setConfirming(false)}>Keep</button>
    </div>}
  </div>;
}

/** "seen 3 hours ago", with the exact time on hover. */
function when(label: string, iso: string | undefined) {
  const ago = timeAgo(iso);
  return ago ? <time key={label} dateTime={iso} title={fullTime(iso)}>{label} {ago}</time> : null;
}

/** "Add a price" under the sellers, and the form it opens. */
function AddPrice({ row, manual }: { row: FlightRow; manual: ManualActions }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return <div className="detail-manual-actions">
      <button type="button" onClick={() => setOpen(true)}><Icon name="plus" />Add a price</button>
      {onlyManual(row) && <button type="button" onClick={() => manual.editFlight(row)}><Icon name="edit" />Edit flight</button>}
    </div>;
  }
  return <div className="detail-booking">
    <ManualPriceForm party={manual.party} partyEditable submitLabel="Add price"
      note="Found it cheaper somewhere? It is listed as another seller for this flight."
      onSubmit={async (values) => { await manual.add(row, values); setOpen(false); }}
      onCancel={() => setOpen(false)} />
  </div>;
}

export function Details({ row, partyLabel, favorite, onToggleFavorite, rating, layoverRatings, onCorrectPrice, onOpenBooking, manual, summary = true }: {
  row: FlightRow | null; partyLabel: string; favorite: boolean;
  onToggleFavorite: (key: string) => void; rating?: JourneyRating;
  layoverRatings?: ConnectionRatings; onCorrectPrice?: CorrectOfferPrice;
  manual?: ManualActions;
  /** Told after a booking page was handed to the browser. */
  onOpenBooking?: (seller: string) => void;
  /** The route, price and Book button on top; the Trip view shows its own. */
  summary?: boolean;
}) {
  const { money } = useCurrency();
  const [bookError, setBookError] = useState("");
  // Collapsed when a flight is first opened in the panel, kept as left while
  // browsing others; open in the Trip view, where they were asked for.
  const [bookingsOpen, setBookingsOpen] = useState(!summary);
  const bookingsId = useId();
  if (!row) return null;
  const [from, to] = row.route.split("-");
  const departureDate = row.depart_date || dayOf(row.outbound?.departure || "");
  const returnDate = row.return_date || dayOf(row.inbound?.departure || "");
  const dates = [departureDate, returnDate && returnDate !== departureDate ? returnDate : ""]
    .filter(Boolean).map((day) => dateLabel(day)).join(" – ");
  // Cheapest first whatever order the sources arrived in; unpriced offers last.
  const offers = [...row.offers].sort((a, b) => (a.price_base ?? Infinity) - (b.price_base ?? Infinity));
  const best = offers.find((offer) => offer.deeplink);
  const open = async (offer: Offer) => {
    await openExternal(offer.deeplink);
    onOpenBooking?.(sellerName(offer));
  };
  return <section className="detail" aria-label="Selected journey">
    {summary && <div className="detail-summary">
      <div className="detail-summary-line">
        <div className="detail-summary-trip">
          {/* A round trip goes both ways, and its arrow says so. */}
          <span className="detail-route">{from} {returnDate ? "↔" : "→"} {to}</span>
          <span>{[dates, partyLabel].filter(Boolean).join(" · ")}</span>
        </div>
        <FavoriteButton row={row} favorite={favorite} onToggle={onToggleFavorite} />
      </div>
      <div className="detail-fare">
        <span className="detail-price-line">
          <h2 className="detail-price" data-rating={rating?.price?.level} title={rating?.price?.description}>{money(row.best?.price_base) || "Price unavailable"}</h2>
          {priceMarks(row, money).map((mark) => <PriceMark key={mark.kind} {...mark} />)}
        </span>
        {best && <button type="button" className="detail-book" onClick={() => {
        setBookError("");
        open(best).catch((e: Error) => setBookError(e.message));
        }}>
          <span className="detail-book-title">Book<Icon name="external" /></span>
          <span className="detail-book-source">{sellerName(best)}{!isManual(best) && best.agent && best.agent !== best.source ? ` via ${best.source}` : ""}</span>
        </button>}
      </div>
      {bookError && <p className="detail-booking-error" role="alert">{bookError}</p>}
    </div>}
    <div className="detail-bookings">
      <h3 className="detail-bookings-title">
        <button type="button" aria-expanded={bookingsOpen} aria-controls={bookingsId} onClick={() => setBookingsOpen((was) => !was)}>
          <Icon name="chevron-right" className="caret" />Booking options<span>{row.offers.length}</span>
        </button>
      </h3>
      <div id={bookingsId} hidden={!bookingsOpen}>
        {offers.map((offer, index) => <Booking key={`${row.trip_key}-${offer.source}-${offer.agent}-${offer.entry_id ?? ""}`} trip={row.trip_key}
          offer={offer} cheapest={index === 0 && offer.price_base != null} onCorrectPrice={onCorrectPrice} onOpen={open} manual={manual} />)}
        {row.offers.length === 0 && <p className="detail-booking-meta">No booking options available</p>}
        {manual && <AddPrice key={row.trip_key} row={row} manual={manual} />}
      </div>
    </div>
    <LegView leg={row.outbound} title="Outbound" rating={rating?.outbound} layoverRatings={layoverRatings?.outbound} />
    <LegView leg={row.inbound} title="Return" rating={rating?.inbound} layoverRatings={layoverRatings?.inbound} />
    {row.return_date && !row.inbound && <p className="detail-missing-return">Return flight details unavailable. The seller priced the round trip without saying which flight comes back.</p>}
  </section>;
}

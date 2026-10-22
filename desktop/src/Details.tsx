/** The selected journey, using the same carrier colors and timing as the list. */
import { useState, type CSSProperties } from "react";
import type { FlightRow, Leg, Offer, Segment } from "./api";
import type { Rating } from "./flightRatings";
import { openExternal } from "./platform";
import { useCurrency } from "./currency";
import { Icon } from "./Icon";
import { FavoriteButton } from "./FavoriteButton";
import { airlineColor, clock, elapsed, isOvernight, partsOf, partLabel } from "./flightTimeline";
import { AirportLabel } from "./AirportLabel";
import { OfferPriceEditor, type CorrectOfferPrice } from "./OfferPriceEditor";
import { formatCurrencyAmount } from "./currencyOptions";

type JourneyRating = { price?: Rating; outbound?: Rating; inbound?: Rating };
const dayOf = (iso: string) => (iso || "").slice(0, 10);
const shortDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const weekdayDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", weekday: "short", timeZone: "UTC" });
const summaryDate = new Intl.DateTimeFormat("en-GB", { month: "short", day: "numeric", timeZone: "UTC" });
function summaryDateLabel(iso: string) {
  const day = new Date(`${iso}T12:00:00Z`);
  return Number.isNaN(day.getTime()) ? iso : summaryDate.format(day);
}
function dateLabel(iso: string, weekday = false) {
  const day = new Date(`${dayOf(iso)}T12:00:00Z`);
  return Number.isNaN(day.getTime()) ? "" : (weekday ? weekdayDate : shortDate).format(day);
}

function Endpoint({ airport, at, showDate }: { airport: string; at: string; showDate?: boolean }) {
  return <div className="detail-endpoint">
    <time dateTime={at} title={`${dateLabel(at, true)} · Local airport time`}>{clock(at)}</time>
    <span className="detail-node" aria-hidden="true" />
    <span className="detail-airport"><AirportLabel code={airport} showCountry />{showDate && <span className="detail-endpoint-date">{dateLabel(at)}</span>}</span>
  </div>;
}

function FlightSegment({ segment, showDepartureDate, summary = false }: {
  segment: Segment; showDepartureDate?: boolean; summary?: boolean;
}) {
  return <div className={`detail-flight${summary ? " detail-flight-summary" : ""}`}
    style={{ "--airline": airlineColor(segment.carrier) } as CSSProperties}>
    <span className="detail-flight-rail" aria-hidden="true" />
    <Endpoint airport={segment.origin} at={segment.departure} showDate={showDepartureDate} />
    <div className="detail-flight-info">
      <span className="detail-flight-duration">{segment.duration}</span>
      <div className="detail-carrier">
        <span>{segment.carrier_name || segment.carrier || "Airline unavailable"}</span>
        {segment.flight_number && <span className="detail-flight-number">{segment.flight_number}</span>}
        {summary && <span className="detail-flight-number">Flight details unavailable</span>}
      </div>
    </div>
    <Endpoint airport={segment.destination} at={segment.arrival}
      showDate={dayOf(segment.departure) !== dayOf(segment.arrival)} />
  </div>;
}

function LegView({ leg, title, rating, layoverRatings }: { leg: Leg | null; title: string; rating?: Rating; layoverRatings?: ReadonlyMap<number, Rating> }) {
  if (!leg) return null;
  const segments = leg.segments ?? [];
  const connections = partsOf(leg).filter((part) => part.kind === "layover");
  const arrivesLater = dayOf(leg.departure) !== dayOf(leg.arrival);
  const stops = leg.stops === 0 ? "Nonstop" : leg.stops == null ? "" : `${leg.stops} stop${leg.stops === 1 ? "" : "s"}`;
  return <section className="detail-journey" aria-label={`${title} itinerary`}>
    <div className="detail-journey-head">
      <h3 className="detail-leg-title">{title}</h3>
      <span className="detail-leg-duration" data-rating={rating?.level} title={rating?.description}>{leg.duration}</span>
    </div>
    <div className="detail-journey-date">
      <span>{dateLabel(leg.departure, true)}{arrivesLater && <> → {dateLabel(leg.arrival, true)}</>}</span>
      {stops && <span>{stops}</span>}
    </div>
    <ol className="detail-segments">
      {segments.length ? segments.map((segment, index) => {
        const gap = connections[index - 1];
        return <li key={index}>
          {gap && <div className={`detail-connection${gap.transfer ? " detail-transfer" : ""}`} title={partLabel(gap)}>
            <span className="detail-connection-duration" data-rating={gap.minutes === null ? undefined : layoverRatings?.get(gap.minutes)?.level}
              title={gap.minutes === null ? undefined : layoverRatings?.get(gap.minutes)?.description}>{gap.minutes !== null ? elapsed(gap.minutes) : "–"}</span>
            <span className="detail-connection-rail" aria-hidden="true" />
            <div className="detail-connection-info">
              {(gap.transfer || isOvernight(gap)) && <span>{gap.transfer && "Change airports"}
                {isOvernight(gap) && <span className="detail-overnight" role="img" aria-label="Overnight connection" title="Overnight connection"><Icon name="moon" /></span>}
              </span>}
            </div>
          </div>}
          <FlightSegment segment={segment}
            showDepartureDate={index > 0 && dayOf(segments[index - 1]!.arrival) !== dayOf(segment.departure)} />
        </li>;
      }) : <li><FlightSegment summary segment={{
        origin: leg.origin_airport, destination: leg.destination_airport,
        departure: leg.departure, arrival: leg.arrival, duration: leg.duration,
        carrier: "", carrier_name: leg.airlines, flight_number: leg.flight_numbers,
      }} /></li>}
    </ol>
  </section>;
}

function Booking({ trip, offer, cheapest, onCorrectPrice }: { trip: string; offer: Offer; cheapest: boolean; onCorrectPrice?: CorrectOfferPrice }) {
  const { money, nativeMoney } = useCurrency();
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const native = nativeMoney(offer.price, offer.currency);
  const original = offer.manual_price ? (offer.price == null ? money(offer.original_price_base) : formatCurrencyAmount(offer.price, offer.currency)) : "";
  const seller = offer.agent || offer.source;
  return <div className="detail-booking">
    <div className="detail-booking-row">
    <div className="detail-seller">
      <span>{seller}</span>
      {offer.agent && offer.agent !== offer.source && <span className="detail-booking-meta">via {offer.source}</span>}
      {!offer.manual_price && native && <span className="detail-booking-meta">Quoted {native}</span>}
      {error && <span className="detail-booking-error" role="alert">{error}</span>}
    </div>
    <span className="detail-booking-prices">
      {original && <s className="detail-booking-original" title="Original source quote"><span className="sr-only">Original source quote: </span>{original}</s>}
      <span className="detail-booking-price" data-cheapest={cheapest || undefined}>{money(offer.price_base)}</span>
    </span>
    {onCorrectPrice && <button type="button" className="detail-price-edit" aria-label={`Correct price for ${seller}`}
      title={`Correct price for ${seller}`} onClick={() => setEditing((value) => !value)}><Icon name="price" /></button>}
    {offer.deeplink ? <button type="button" className="detail-booking-link"
      aria-label={`Open booking with ${seller}`} title={`Open booking with ${seller}`}
      onClick={() => openExternal(offer.deeplink).catch((e: Error) => setError(e.message))}>
      <Icon name="external" />
    </button> : <span className="detail-no-link" title="Booking link unavailable"><Icon name="input" /></span>}
    </div>
    {editing && onCorrectPrice && <OfferPriceEditor trip={trip} offer={offer} onSave={onCorrectPrice} onClose={() => setEditing(false)} />}
  </div>;
}

export function Details({ row, partyLabel, favorite, onToggleFavorite, rating, layoverRatings, onCorrectPrice }: {
  row: FlightRow | null; partyLabel: string; favorite: boolean;
  onToggleFavorite: (key: string) => void; rating?: JourneyRating;
  layoverRatings?: ReadonlyMap<number, Rating>; onCorrectPrice?: CorrectOfferPrice;
}) {
  const { money } = useCurrency();
  if (!row) return null;
  const [from, to] = row.route.split("-");
  const departureDate = row.depart_date || dayOf(row.outbound?.departure || "");
  const returnDate = row.return_date || dayOf(row.inbound?.departure || "");
  // Cheapest first whatever order the sources arrived in; unpriced offers last.
  const offers = [...row.offers].sort((a, b) => (a.price_base ?? Infinity) - (b.price_base ?? Infinity));
  return <section className="side-section detail" aria-label="Selected journey">
    <div className="detail-summary">
      <div className="detail-route-heading">
        <span><AirportLabel code={from || ""} showCity={false} /> <Icon name="arrow-right" /> <AirportLabel code={to || ""} showCity={false} /></span>
        <FavoriteButton row={row} favorite={favorite} onToggle={onToggleFavorite} />
      </div>
      {departureDate && <div className="detail-summary-date">
        <time dateTime={departureDate}>{summaryDateLabel(departureDate)}</time>
        {returnDate && returnDate !== departureDate && <> – <time dateTime={returnDate}>{summaryDateLabel(returnDate)}</time></>}
      </div>}
      <div className="detail-fare">
        <h2 className="detail-price" data-rating={rating?.price?.level} title={rating?.price?.description}>{money(row.best?.price_base) || "Price unavailable"}</h2>
        <span>{partyLabel}</span>
      </div>
    </div>
    <LegView leg={row.outbound} title="Outbound" rating={rating?.outbound} layoverRatings={layoverRatings} />
    <LegView leg={row.inbound} title="Return" rating={rating?.inbound} layoverRatings={layoverRatings} />
    {row.return_date && !row.inbound && <p className="detail-missing-return">Return flight details unavailable</p>}
    <section className="detail-bookings" aria-label="Booking options">
      <h3 className="detail-leg-title">Booking options{row.offers.length > 1 && <span>{row.offers.length}</span>}</h3>
      {offers.map((offer, index) => <Booking key={`${row.trip_key}-${offer.source}-${offer.agent}`} trip={row.trip_key} offer={offer} cheapest={index === 0 && offer.price_base != null} onCorrectPrice={onCorrectPrice} />)}
      {row.offers.length === 0 && <p className="detail-booking-meta">No booking options available</p>}
    </section>
  </section>;
}

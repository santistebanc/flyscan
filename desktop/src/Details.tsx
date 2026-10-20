/**
 * The detail panel: the full itinerary and every seller's price for it.
 *
 * It replaces the queue in the side panel when a flight is selected.
 * Read-only on purpose: the party and cabin are
 * part of the search itself, so every price here is already for the travellers
 * that were asked about, and there is nothing to re-price from inside it.
 */

import { useState } from "react";
import type { FlightRow, Leg, Offer } from "./api";
import { openExternal } from "./platform";
import { useCurrency } from "./currency";
import { Icon } from "./Icon";

const clock = (iso: string) => (iso || "").slice(11, 16);
const dayOf = (iso: string) => (iso || "").slice(0, 10);

function prettyGap(from: string, to: string): string {
  const start = Date.parse(from), end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "";
  const minutes = Math.round((end - start) / 60000);
  if (minutes <= 0) return "";
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return hours ? `${hours}h ${String(rest).padStart(2, "0")}m` : `${rest}m`;
}

function LegView({ leg, title }: { leg: Leg | null; title: string }) {
  if (!leg) return null;
  const segments = leg.segments ?? [];
  return (
    <>
      <h3>
        {title} · {leg.duration}
        {leg.stops ? ` · ${leg.stops} stop${leg.stops > 1 ? "s" : ""}` : " · nonstop"}
      </h3>
      <div className="leg">
        {segments.length === 0 ? (
          // Some sources give the leg but no connection detail.
          <div className="seg">
            <span className="times">{clock(leg.departure)} <Icon name="arrow-right" /> {clock(leg.arrival)}</span>
            <span>
              {leg.origin_airport} <Icon name="arrow-right" /> {leg.destination_airport}
              <div className="who">{leg.airlines}</div>
            </span>
          </div>
        ) : segments.map((segment, index) => {
          const previous = segments[index - 1];
          const gap = previous ? prettyGap(previous.arrival, segment.departure) : "";
          return (
            <div key={`${segment.flight_number}-${index}`}>
              {gap && (
                <div className="layover">{gap} in {previous!.destination}</div>
              )}
              <div className="seg">
                <span className="times">
                  {clock(segment.departure)}<br />{clock(segment.arrival)}
                </span>
                <span>
                  {segment.origin} <Icon name="arrow-right" /> {segment.destination}
                  <div className="who">
                    {segment.carrier_name || segment.carrier}
                    {segment.flight_number ? ` ${segment.flight_number}` : ""}
                    {segment.duration ? ` · ${segment.duration}` : ""}
                  </div>
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function Booking({ offer, cheapest }: { offer: Offer; cheapest: boolean }) {
  const { money, nativeMoney } = useCurrency();
  const [error, setError] = useState("");
  const native = nativeMoney(offer.price, offer.currency);

  return (
    <div className={cheapest ? "book cheapest" : "book"}>
      <span className="amount">{money(offer.price_base)}</span>
      <span className="who">
        {offer.source}
        {offer.agent && <div className="native">{offer.agent}</div>}
        {native && <div className="native">quoted {native}</div>}
        {error && <div className="native err">{error}</div>}
      </span>
      {offer.deeplink ? (
        // No href: the URL is scraped, and an unescaped quote in an attribute
        // is an injection. A webview also ignores target="_blank" entirely.
        <a
          className="book-link"
          role="button"
          onClick={() => {
            openExternal(offer.deeplink).catch((e: Error) => setError(e.message));
          }}
        >
          open
        </a>
      ) : (
        <span className="native">no link</span>
      )}
    </div>
  );
}

export function Details(
  { row, partyLabel }: { row: FlightRow | null; partyLabel: string },
) {
  const { money, roundedIn } = useCurrency();

  // Nothing picked, nothing to show. An empty panel headed "Flight" is a
  // promise of content that is not coming; the space goes to the queue, which
  // opens to fill it.
  if (!row) return null;

  const arrivesLater = dayOf(row.arrival) !== row.depart_date;

  return (
    <section className="side-section detail">
      <div className="section-head static">
        <span className="section-title">Flight</span>
      </div>

      <h2>{money(row.best?.price_base)}</h2>
      <div className="sub">
        {row.route} · {row.depart_date}
        {arrivesLater ? ` · arrives ${dayOf(row.arrival)}` : ""}
      </div>

      <LegView leg={row.outbound} title="Outbound" />
      <LegView leg={row.inbound} title="Return" />

      <h3>Booking options ({row.offers.length}) · {partyLabel}</h3>
      {row.offers.map((offer, index) => (
        <Booking
          key={`${offer.source}-${offer.agent}-${index}`}
          offer={offer}
          cheapest={index === 0}
        />
      ))}
      {roundedIn(row.spread) >= 1 && (
        <p className="sub spread">
          Cheapest and dearest differ by {money(row.spread)} for the same seat.
        </p>
      )}
    </section>
  );
}

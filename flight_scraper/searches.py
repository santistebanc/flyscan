"""Search execution: source results, replayable progress, and file exports.

Job owns startup/cancellation/terminal transitions; this runner supplies the
scraping and export adapters and always executes inside Job.run.
"""
from datetime import timedelta
from pathlib import Path
from typing import Any, Dict, List

from .aggregate import Aggregator, MergedItinerary, merge
from .jobs import Job
from .models import Offer, SearchQuery, pretty_duration, trip_pairs
from .places import resolve
from .store import default_output_stem, offer_to_row, write_csv, write_json

OUT_DIR = Path("out")
ROW_LIMIT = 60


def _offer_row(offer: Offer) -> Dict[str, Any]:
    """One seller's price: EUR for comparing, plus what they actually quoted.

    No formatted string — the client formats, so changing the display currency
    is a re-render rather than another scrape.
    """
    return {
        "source": offer.source,
        "agent": offer.agent,
        "price": offer.price,
        "currency": offer.currency,
        "price_base": offer.price_eur,
        "deeplink": offer.deeplink,
    }


def _leg_row(leg) -> Dict[str, Any]:
    """One direction, with its connections — what a detail view needs."""
    return {
        "origin_airport": leg.origin_airport,
        "destination_airport": leg.destination_airport,
        "departure": leg.departure,
        "arrival": leg.arrival,
        "duration": pretty_duration(leg.duration_minutes),
        "stops": leg.stops,
        "airlines": leg.airlines,
        "flight_numbers": leg.flight_numbers,
        "segments": [
            {
                "carrier": s.carrier,
                "carrier_name": s.carrier_name or s.carrier,
                "flight_number": s.flight_number,
                "origin": s.origin,
                "destination": s.destination,
                "departure": s.departure,
                "arrival": s.arrival,
                "duration": pretty_duration(s.duration_minutes),
            }
            for s in leg.segments
        ],
    }


def _merged_row(item: MergedItinerary) -> Dict[str, Any]:
    """One flight and every quote for it. All money is EUR; the client formats."""
    best = item.best
    leg = best.itinerary.outbound
    inbound = best.itinerary.inbound
    return {
        "trip_key": item.trip_key,
        "depart_date": best.itinerary.query.depart.isoformat(),
        "route": f"{leg.origin_airport}-{leg.destination_airport}",
        "departure": leg.departure,
        "arrival": leg.arrival,
        "duration": pretty_duration(leg.duration_minutes),
        "stops": leg.stops,
        "airlines": leg.airlines,
        "flight_numbers": leg.flight_numbers,
        # The return date *searched for*, which is not always the same thing as
        # a described inbound leg: some sellers price a round trip without
        # saying which flight comes back. With a range of returns on screen at
        # once, it is the only thing telling two such rows apart.
        "return_date": (
            best.itinerary.query.ret.isoformat() if best.itinerary.query.ret else ""
        ),
        "return_departure": inbound.departure if inbound else "",
        "return_arrival": inbound.arrival if inbound else "",
        "return_duration": pretty_duration(inbound.duration_minutes) if inbound else "",
        # Carried on every row so the detail panel opens with no round trip.
        "outbound": _leg_row(leg),
        "inbound": _leg_row(inbound) if inbound else None,
        "best": _offer_row(best),
        "sources": item.sources,
        "source_count": len(item.sources),
        "spread": item.spread,
        "offers": [_offer_row(o) for o in item.offers],
    }


def execute_search(job: Job, params: Dict[str, Any]) -> None:
    """Background worker: scrape the range and stream progress into the job."""
    base_currency = params["base_currency"]

    origin = resolve(params["origin"], prefer=params["prefer"])
    destination = resolve(params["destination"], prefer=params["prefer"])
    if job.cancelled:
        return
    job.emit("resolved", origin=str(origin), destination=str(destination),
             origin_code=origin.code, destination_code=destination.code)
    query = SearchQuery(
        origin=origin.code, destination=destination.code, depart=params["start"], ret=params["ret"],
        adults=params["adults"], children=params["children"], infants=params["infants"],
        cabin=params["cabin"], currency=params["currency"],
    )

    def on_progress(event: str, data: Dict[str, Any]) -> None:
        identity = {
            "day": str(data.get("day", "")),
            "ret": str(data["ret"]) if data.get("ret") else None,
            "scrape_id": data.get("scrape_id"), "attempt": data.get("attempt", 0),
        }
        if event == "start":
            job.emit("start", days=data["days"], sources=data["sources"],
                     jobs=data.get("jobs", 0))
        elif event == "day_start":
            job.emit("day_start", **identity, sources=data["sources"])
        elif event == "source_start":
            job.emit("source_start", source=data["source"], **identity)
        elif event == "source_done":
            job.emit(
                "source_done",
                source=data["source"], **identity, count=data["count"],
                error=data["error"], elapsed=round(data["elapsed"], 1),
                origin=data.get("origin", "scrape"), age_hours=data.get("age_hours"),
                url=data.get("url", ""),
            )
        elif event == "day_partial":
            # Results as they land, not when the slowest source finishes.
            rows = [_merged_row(m) for m in data["merged"][:ROW_LIMIT]]
            job.record_day(f"{data['day']}/{data.get('ret') or ''}", {
                "day": str(data["day"]),
                "ret": str(data["ret"]) if data.get("ret") else None,
                "offers": data["offers"],
                "itineraries": len(data["merged"]),
                "errors": {},
                "rows": rows,
                "complete": False,
            })
            job.emit(
                "day_partial",
                day=str(data["day"]),
                ret=str(data["ret"]) if data.get("ret") else None,
                offers=data["offers"],
                itineraries=len(data["merged"]),
                sources_done=data["sources_done"],
                sources_total=data["sources_total"],
                shown=len(rows),
                rows=rows,
            )
        elif event == "source_retry":
            job.emit("source_retry", source=data["source"], **identity, message=data["error"])
        elif event == "challenge_required":
            # A person has to clear this one; the frontend just needs the link.
            job.emit("challenge_required", source=data["source"], **identity, url=data["url"])

    aggregator = Aggregator(
        sources=params["sources"],
        base_currency=base_currency,
        timeout=params["timeout"],
        retries=params["retries"],
        max_workers=params["workers"],
        db_path=params["db"] or None,
        ttl=timedelta(hours=params["cache_hours"]),
        refresh=params["refresh"],
        on_progress=on_progress,
        owner=job.id,
    )
    offers: List[Offer] = []
    errors = 0
    itineraries = 0

    # Every departure day against every return day: the search is a rectangle
    # of trips, not a span. Five trips out of three departures and two returns.
    trips = trip_pairs(
        params["start"], params["end"], params["ret"], params["ret_end"]
    )
    total_days = len(trips)

    try:
        if not job.attach(aggregator):
            return
        for index, day in enumerate(aggregator.search_trips(query, trips), start=1):
            if job.cancelled:
                break
            errors += len(day.errors)
            # The scheduler writes each source's findings as it completes, and
            # a skipped source wrote its own the first time it answered. Either
            # way the complete picture is in the database, not in hand.
            stored = aggregator.stored_offers(day.query)
            if stored is not None:
                day_offers = stored
                day_merged = merge(day_offers, base_currency)
            else:
                day_offers, day_merged = day.offers, day.merged
            offers.extend(day_offers)
            itineraries += len(day_merged)
            job.update_results(offers=len(offers), itineraries=itineraries, errors=errors)

            row_payload = [_merged_row(m) for m in day_merged[:ROW_LIMIT]]
            trip_key = f"{day.day}/{day.query.ret or ''}"
            job.record_day(trip_key, {
                "day": str(day.day),
                "ret": str(day.query.ret) if day.query.ret else None,
                "offers": len(day_offers),
                "itineraries": len(day_merged),
                "errors": day.errors,
                "rows": row_payload,
                "complete": True,
            })
            job.emit(
                "day_done",
                day=str(day.day),
                ret=str(day.query.ret) if day.query.ret else None,
                index=index,
                total=total_days,
                offers=len(day_offers),
                itineraries=len(day_merged),
                elapsed=round(day.elapsed, 1),
                errors=day.errors,
                shown=min(len(day_merged), ROW_LIMIT),
                rows=row_payload,
            )
    finally:
        aggregator.close()

    csv_name = json_name = None
    if offers and not job.cancelled:
        rows = [offer_to_row(o, base_currency) for o in offers]
        rows.sort(key=lambda r: (r["depart_date"], r["price_base"] or float("inf")))
        stem = default_output_stem(query.origin, query.destination)
        csv_name = write_csv(rows, OUT_DIR / f"{stem}.csv").name
        json_name = write_json(rows, OUT_DIR / f"{stem}.json").name
    job.update_results(offers=len(offers), itineraries=itineraries, errors=errors,
                       csv=csv_name, json=json_name)

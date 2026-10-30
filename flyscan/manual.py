"""Flights and prices a person types in, turned into what the store keeps.

Nothing here is asked of a source. A typed flight becomes the same
:class:`Itinerary` a scraper would produce, so it lands on the same stored row
when it describes the same flight and is compared like any other.

There is no airport time-zone table, so a flight's duration is taken from the
person when they give one and otherwise from the clock times, which is wrong by
the zone difference. Connections are always right: both ends of a layover are
in the same airport.
"""

from __future__ import annotations

import re
from datetime import date, datetime
from typing import Any, Dict, List, Optional

from .models import Itinerary, Leg, SearchQuery, Segment, leg_duration

_FLIGHT_NUMBER = re.compile(r"^([A-Z0-9]{2})\s*(\d{1,4}[A-Z]?)$")
_AIRPORT = re.compile(r"^[A-Z]{3}$")


def _stamp(value: Any, what: str) -> str:
    text = str(value or "").strip()
    try:
        return datetime.fromisoformat(text).isoformat(timespec="minutes")
    except ValueError:
        raise ValueError(f"{what} needs a date and time") from None


def segment_from(data: Dict[str, Any], label: str) -> Segment:
    """One typed flight, checked."""
    number = re.sub(r"\s+", "", str(data.get("flight_number") or "")).upper()
    origin = str(data.get("origin") or "").strip().upper()
    destination = str(data.get("destination") or "").strip().upper()
    for code, what in ((origin, "departure airport"), (destination, "arrival airport")):
        if not _AIRPORT.match(code):
            raise ValueError(f"{label}: the {what} needs a three-letter code")
    departure = _stamp(data.get("departure"), f"{label}: the departure")
    arrival = _stamp(data.get("arrival"), f"{label}: the arrival")
    minutes = data.get("duration_minutes")
    if minutes in (None, ""):
        minutes = leg_duration(departure, arrival)
    try:
        minutes = int(minutes)
    except (TypeError, ValueError):
        raise ValueError(f"{label}: the flight time is not a number of minutes") from None
    if minutes <= 0:
        raise ValueError(f"{label}: the arrival is before the departure; enter the flight time")
    match = _FLIGHT_NUMBER.match(number)
    carrier = match.group(1) if match else ""
    return Segment(
        carrier=carrier,
        carrier_name=str(data.get("carrier_name") or "").strip() or carrier,
        flight_number=number,
        origin=origin,
        destination=destination,
        departure=departure,
        arrival=arrival,
        duration_minutes=minutes,
    )


def leg_from(segments: List[Segment]) -> Leg:
    """One direction from its flights; stops and layovers follow from them."""
    total = 0
    for index, segment in enumerate(segments):
        total += segment.duration_minutes or 0
        if index:
            wait = leg_duration(segments[index - 1].arrival, segment.departure)
            if wait is None or wait < 0:
                raise ValueError(f"flight {index + 1} leaves before flight {index} lands")
            total += wait
    airlines: List[str] = []
    for segment in segments:
        if segment.carrier_name and segment.carrier_name not in airlines:
            airlines.append(segment.carrier_name)
    return Leg(
        origin_airport=segments[0].origin,
        destination_airport=segments[-1].destination,
        departure=segments[0].departure,
        arrival=segments[-1].arrival,
        duration_minutes=total,
        stops=len(segments) - 1,
        airlines=", ".join(airlines),
        flight_numbers=",".join(s.flight_number for s in segments if s.flight_number),
        segments=segments,
    )


def itinerary_from(payload: Dict[str, Any], party: Dict[str, Any]) -> Itinerary:
    """A typed trip. Its dates are the days its first flights leave."""
    outbound = payload.get("outbound") or []
    inbound = payload.get("inbound") or []
    if not isinstance(outbound, list) or not outbound:
        raise ValueError("the outbound needs at least one flight")
    if not isinstance(inbound, list):
        raise ValueError("the return must be a list of flights")
    out = leg_from([segment_from(s, f"Outbound flight {i + 1}") for i, s in enumerate(outbound)])
    back = (
        leg_from([segment_from(s, f"Return flight {i + 1}") for i, s in enumerate(inbound)])
        if inbound
        else None
    )
    query = query_from(
        {
            **party,
            "depart": out.departure[:10],
            "ret": back.departure[:10] if back else None,
        }
    )
    return Itinerary(query=query, outbound=out, inbound=back)


def query_from(payload: Dict[str, Any]) -> SearchQuery:
    """The search an entry belongs to: route as searched, dates, party, cabin."""
    origin = str(payload.get("origin") or "").strip()
    destination = str(payload.get("destination") or "").strip()
    if not origin or not destination:
        raise ValueError("the search's origin and destination are required")

    def day(value: Any) -> Optional[date]:
        return date.fromisoformat(str(value)[:10]) if value else None

    try:
        depart = day(payload.get("depart"))
        ret = day(payload.get("ret"))
        if depart is None:
            raise ValueError("a departure date is required")
        return SearchQuery(
            origin=origin,
            destination=destination,
            depart=depart,
            ret=ret,
            adults=int(payload.get("adults") or 1),
            children=int(payload.get("children") or 0),
            infants=int(payload.get("infants") or 0),
            cabin=str(payload.get("cabin") or "economy"),
        )
    except (TypeError, ValueError) as exc:
        raise ValueError(str(exc)) from None

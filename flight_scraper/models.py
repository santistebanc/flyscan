"""Source-agnostic data model.

Every source is reduced to the same three things: a :class:`SearchQuery` that
says what to look for, an :class:`Itinerary` describing a way to fly it, and an
:class:`Offer` quoting a price for that itinerary from one source.

The split matters because the same physical flight is sold by every
source at different prices. Keeping the itinerary separate from the price is
what lets the store hold each flight once and hang many offers off it.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

CABIN_CLASSES = ("economy", "premiumeconomy", "business", "first")

#: Age sent for every child. Only the Kayak engine asks for one, and it insists
#: on a number per child, so a count alone has to be filled in somehow. Ten sits
#: inside every airline's child fare band.
#:
#: Real ages are deliberately not modelled. They would change the price on one
#: source out of five while being invisible to the other four and to the stored
#: schema, so a search keyed on them would look distinct while producing results
#: that could not be told apart.
DEFAULT_CHILD_AGE = 10


# -- the search ------------------------------------------------------------


@dataclass
class SearchQuery:
    """One route on one date, in the terms every source understands.

    Places are IATA codes: either an airport (``TXL``) or a city metacode
    (``LON``, ``NYC``). Every source accepts both.
    """

    origin: str
    destination: str
    depart: date
    ret: Optional[date] = None
    adults: int = 1
    children: int = 0
    infants: int = 0           # infants on a lap, under 2
    cabin: str = "economy"
    currency: str = "EUR"

    def __post_init__(self) -> None:
        self.origin = self.origin.strip().upper()
        self.destination = self.destination.strip().upper()
        self.currency = self.currency.strip().upper()
        if self.cabin not in CABIN_CLASSES:
            raise ValueError(
                f"cabin must be one of {', '.join(CABIN_CLASSES)}, got {self.cabin!r}"
            )
        if self.adults < 1:
            raise ValueError("at least one adult is required")
        if self.ret and self.ret < self.depart:
            raise ValueError("return date is before the departure date")

    @property
    def round_trip(self) -> bool:
        return self.ret is not None

    @property
    def passengers(self) -> int:
        return self.adults + self.children + self.infants

    def replace_date(self, day: date) -> "SearchQuery":
        """Same search, different departure date, keeping any trip length."""
        ret = None
        if self.ret is not None:
            ret = day + (self.ret - self.depart)
        return SearchQuery(**{**asdict(self), "depart": day, "ret": ret})

    def replace_trip(self, depart: date, ret: Optional[date]) -> "SearchQuery":
        """Same search, on exactly these two dates.

        Unlike :meth:`replace_date` this keeps no trip length: the two dates
        are chosen independently, which is the point of searching a departure
        range against a return range.
        """
        return SearchQuery(**{**asdict(self), "depart": depart, "ret": ret})

    def label(self) -> str:
        trip = f"{self.origin}-{self.destination} {self.depart}"
        return f"{trip} / {self.ret}" if self.ret else trip


# -- what a source found ---------------------------------------------------


@dataclass
class Segment:
    """A single flight number within a leg."""

    carrier: str = ""            # IATA airline code, e.g. "FR"
    carrier_name: str = ""       # e.g. "Ryanair"
    flight_number: str = ""      # e.g. "FR146"
    origin: str = ""
    destination: str = ""
    departure: str = ""          # local ISO, "2026-08-22T16:40"
    arrival: str = ""
    duration_minutes: Optional[int] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Segment":
        fields = {f: data.get(f) for f in cls.__dataclass_fields__}
        return cls(**{k: (v if v is not None else "") if k != "duration_minutes" else v
                      for k, v in fields.items()})


@dataclass
class Leg:
    """One direction of the trip."""

    origin_airport: str = ""
    destination_airport: str = ""
    departure: str = ""
    arrival: str = ""
    duration_minutes: Optional[int] = None
    stops: Optional[int] = None
    airlines: str = ""           # comma-separated display names
    flight_numbers: str = ""     # comma-separated, e.g. "FR146"
    segments: List[Segment] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {**asdict(self), "segments": [s.to_dict() for s in self.segments]}

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Leg":
        return cls(
            origin_airport=data.get("origin_airport") or "",
            destination_airport=data.get("destination_airport") or "",
            departure=data.get("departure") or "",
            arrival=data.get("arrival") or "",
            duration_minutes=data.get("duration_minutes"),
            stops=data.get("stops"),
            airlines=data.get("airlines") or "",
            flight_numbers=data.get("flight_numbers") or "",
            segments=[Segment.from_dict(s) for s in (data.get("segments") or [])],
        )


@dataclass
class Itinerary:
    """A way of flying the search, independent of who sells it."""

    query: SearchQuery
    outbound: Leg
    inbound: Optional[Leg] = None

    @property
    def trip_key(self) -> str:
        """Stable identity for this flight, shared across sources.

        Deliberately built from airports and clock times rather than flight
        numbers. Sources disagree on the operating carrier: the same easyJet
        service comes back as EC7336 from one and U27336 from another, so a key
        made of flight numbers splits matches that are really the same seat.
        Connection schedules belong to identity too: two itineraries can share
        their first departure, final arrival and stop count while taking
        different connecting flights. The per-flight airports and minutes
        distinguish those without splitting operating/marketing codeshares.
        The return date is part of the key whenever one was searched for.
        """
        parts = [
            self.query.depart.isoformat(),
            self.query.origin,
            self.query.destination,
            self.outbound.origin_airport,
            self.outbound.destination_airport,
            _minute(self.outbound.departure),
            _minute(self.outbound.arrival),
            str(self.outbound.stops if self.outbound.stops is not None else "?"),
        ]
        # The searched return date, not just the inbound legs. A source that
        # prices a round trip without fixing which flight comes back yields an
        # itinerary with no inbound at all, and without this its key would be
        # identical to a plain one-way's — the two then merge, and a one-way fare
        # ends up at the top of a round-trip list being compared against
        # round-trip prices. That is not hypothetical; it happened.
        # Appended only when set, so one-way keys keep their existing value.
        if self.query.ret:
            parts.append(self.query.ret.isoformat())
        if self.inbound:
            parts += [
                _minute(self.inbound.departure),
                _minute(self.inbound.arrival),
                str(self.inbound.stops if self.inbound.stops is not None else "?"),
            ]
        # Keep existing nonstop identities. Connecting journeys need the full
        # schedule; endpoint-only keys once merged AA81 with AA6950 and copied
        # one flight's duration into the other flight's clock times.
        for direction, leg in (("outbound", self.outbound), ("inbound", self.inbound)):
            if leg and len(leg.segments) > 1:
                parts.append(direction)
                for segment in leg.segments:
                    parts.extend((segment.origin, segment.destination,
                                  _minute(segment.departure), _minute(segment.arrival)))
        return hashlib.sha1("|".join(parts).encode()).hexdigest()

    def to_row(self) -> Dict[str, Any]:
        """Flatten to the ``itineraries`` table's columns."""
        q, out, back = self.query, self.outbound, self.inbound
        return {
            "trip_key": self.trip_key,
            "search_origin": q.origin,
            "search_destination": q.destination,
            "depart_date": q.depart.isoformat(),
            "return_date": q.ret.isoformat() if q.ret else None,
            "adults": q.adults,
            "children": q.children,
            "infants": q.infants,
            "cabin": q.cabin,
            "origin_airport": out.origin_airport,
            "destination_airport": out.destination_airport,
            "departure": out.departure,
            "arrival": out.arrival,
            "duration_minutes": out.duration_minutes,
            "stops": out.stops,
            "airlines": out.airlines,
            "flight_numbers": out.flight_numbers,
            "return_departure": back.departure if back else None,
            "return_arrival": back.arrival if back else None,
            "return_duration_minutes": back.duration_minutes if back else None,
            "return_stops": back.stops if back else None,
            "return_airlines": back.airlines if back else None,
            "segments": [s.to_dict() for s in out.segments],
            "return_segments": [s.to_dict() for s in back.segments] if back else [],
        }


@dataclass
class Offer:
    """One source's price for one itinerary."""

    itinerary: Itinerary
    source: str
    price: float
    currency: str
    agent: str = ""              # booking provider, when the source names one
    deeplink: str = ""
    source_id: str = ""          # the source's own id, kept for debugging
    price_eur: Optional[float] = None

    @property
    def trip_key(self) -> str:
        return self.itinerary.trip_key


# -- helpers ---------------------------------------------------------------


def _minute(iso: str) -> str:
    """``2026-08-22T16:40:00`` -> ``2026-08-22T16:40``; blank stays blank."""
    if not iso:
        return "?"
    return iso[:16]


def leg_duration(departure: str, arrival: str) -> Optional[int]:
    """Minutes between two local ISO timestamps, or ``None`` if unparseable.

    Local-to-local across a timezone change is wrong by the offset, so this is
    only a fallback for sources that give no duration of their own.
    """
    try:
        start = datetime.fromisoformat(departure)
        end = datetime.fromisoformat(arrival)
    except (TypeError, ValueError):
        return None
    return int((end - start).total_seconds() // 60)


_DURATION_RE = re.compile(
    r"(?:(?P<d>\d+)\s*d)?\s*(?:(?P<h>\d+)\s*h(?:r|ours?)?)?\s*(?:(?P<m>\d+)\s*m)?",
    re.I,
)


def parse_duration(text: str) -> Optional[int]:
    """Read ``1h 50``, ``14 hr 5 min``, ``2d 3h`` as a minute count."""
    if not text:
        return None
    text = text.strip()
    # "1h 50" — a bare trailing number after the hours means minutes.
    compact = re.fullmatch(r"(\d+)\s*h(?:r)?\s+(\d+)\s*$", text, re.I)
    if compact:
        return int(compact.group(1)) * 60 + int(compact.group(2))
    m = _DURATION_RE.match(text)
    if not m or not any(m.groupdict().values()):
        return None
    days = int(m.group("d") or 0)
    hours = int(m.group("h") or 0)
    mins = int(m.group("m") or 0)
    total = days * 1440 + hours * 60 + mins
    return total or None


def daterange(start: date, end: date) -> List[date]:
    """Inclusive list of dates from ``start`` to ``end``."""
    if end < start:
        raise ValueError(f"end date {end} is before start date {start}")
    return [start + timedelta(days=i) for i in range((end - start).days + 1)]


def trip_pairs(
    depart_from: date,
    depart_to: Optional[date] = None,
    ret_from: Optional[date] = None,
    ret_to: Optional[date] = None,
) -> List[Tuple[date, Optional[date]]]:
    """Every trip a search stands for: each departure day against each return day.

    Two independent ranges, not one span. Flexible plans are usually shaped
    like "leave some time next weekend, come back some time the weekend after",
    and that is a rectangle of possible trips rather than a sliding one of
    fixed length — which is what searching a departure range while dragging the
    return along with it would give you.

    A return before its departure is not a trip and is left out. That is why
    departures 23–25 against returns 24–25 is five trips and not six: 25→24
    never existed.

    One-way searches (no ``ret_from``) are one trip per departure day.
    """
    departures = daterange(depart_from, depart_to or depart_from)
    if ret_from is None:
        return [(day, None) for day in departures]
    returns = daterange(ret_from, ret_to or ret_from)
    return [(day, back) for day in departures for back in returns if back >= day]


def parse_date(value: str) -> date:
    """Accept YYYY-MM-DD, DD/MM/YYYY, ``today``/``tomorrow``, or an offset like ``+14``."""
    value = (value or "").strip()
    if value.startswith("+") and value[1:].isdigit():
        return date.today() + timedelta(days=int(value[1:]))
    if value.casefold() == "today":
        return date.today()
    if value.casefold() == "tomorrow":
        return date.today() + timedelta(days=1)
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%Y/%m/%d", "%d-%m-%Y"):
        try:
            return datetime.strptime(value, fmt).date()
        except ValueError:
            continue
    raise ValueError(f"could not read {value!r} as a date (try YYYY-MM-DD or +14)")


def pretty_duration(minutes: Optional[int]) -> str:
    if minutes is None:
        return ""
    h, m = divmod(int(minutes), 60)
    return f"{h}h {m:02d}m"

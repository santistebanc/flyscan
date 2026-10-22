"""FlightsFinder's two meta-search portals: ``/portal/sky`` and ``/portal/kiwi``.

Both run the same front-end ("CFFLive"): the search page ships a jQuery block
holding a CSRF token and a server-side session id, and the results arrive from
a POST to that block's endpoint as a pipe-delimited string whose seventh field
is a chunk of rendered HTML.

Rather than hard-code the POST body, we lift the whole ``data: { ... }`` object
straight out of the page. The session token there is minted per page load and
cannot be guessed, and reading it this way means a new parameter appearing
upstream travels with us for free.
"""

from __future__ import annotations

import html
import re
import time
from concurrent.futures import CancelledError
from datetime import date, timedelta
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlencode

from lxml import html as lxml_html

from ..models import Itinerary, Leg, Offer, SearchQuery, Segment, parse_duration
from ..task_queue import JobTimeout, RateLimited
from .base import Source, SourceError

BASE = "https://www.flightsfinder.com"

# The poll block: `$.ajax({type: 'POST', url: '...', ... data: { ... }})`.
_AJAX_RE = re.compile(
    r"\$\.ajax\(\{\s*type:\s*'POST',\s*url:\s*'([^']+)'.*?data:\s*\{(.*?)\}\s*\}\s*\)",
    re.S,
)
_KV_RE = re.compile(r"'([^']+)'\s*:\s*'([^']*)'")

# Field 0 is the done flag, 1 the result count, 6 the results HTML.
_DONE, _COUNT, _HTML = 0, 1, 6


def _extract_poll(page_html: str) -> Tuple[str, Dict[str, str]]:
    """Endpoint path and POST body carried by the page's polling block."""
    match = _AJAX_RE.search(page_html)
    if not match:
        raise SourceError("search page carried no polling block")
    endpoint, blob = match.group(1), match.group(2)
    data = {key: html.unescape(value) for key, value in _KV_RE.findall(blob)}
    if not data:
        raise SourceError("polling block carried no parameters")
    return endpoint, data


def _text(node) -> str:
    return re.sub(r"\s+", " ", (node.text_content() or "")).strip()


def _minutes_to_clock(minutes: Optional[int]) -> str:
    if minutes is None:
        return ""
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def _modal_id(item, index: int) -> str:
    """Follow the card's details link; source IDs can skip list positions.

    Sky copies a numbered modal into ``myModalX`` with inline jQuery. Read
    that reference as text, without executing it. Older markup without a
    reference retains the positional fallback; a missing *referenced* modal
    must never fall back to the neighboring flight's details.
    """
    for node in item.iter():
        for attr in ("data-target", "data-bs-target", "href", "onclick"):
            match = re.search(r"\bmyModal\d+\b", node.get(attr, ""))
            if match:
                return match.group()
    return f"myModal{index}"


class _CFFLiveParser:
    """Reads the rendered result list both portals emit.

    Each ``.list-item`` carries the numbers as data attributes (price in
    cents, stop count, departure as minutes past midnight) and the matching
    ``#myModalN`` carries the per-segment detail. The data attributes are the
    trustworthy part; the modal fills in flight numbers and the arrival date.
    """

    def __init__(self, source_name: str, query: SearchQuery, currency: str):
        self.source_name = source_name
        self.query = query
        self.currency = currency

    def parse(self, markup: str) -> List[Offer]:
        tree = lxml_html.fromstring(f"<div>{markup}</div>")
        modals = {node.get("id"): node for node in tree.cssselect("div.modal") if node.get("id")}
        offers: List[Offer] = []
        for index, item in enumerate(tree.cssselect("div.list-item")):
            try:
                offer = self._one(item, modals.get(_modal_id(item, index)))
            except Exception:
                continue  # one malformed card must not lose the other 150
            if offer is not None:
                offers.append(offer)
        return offers

    # -- per card ----------------------------------------------------------

    def _one(self, item, modal) -> Optional[Offer]:
        price = self._price(item)
        if price is None:
            return None

        # A round trip renders one .stops block per direction; a one-way, one.
        blocks = item.cssselect("div.stops")
        if not blocks:
            return None

        detail = _ModalDetail.read(modal) if modal is not None else _ModalDetail()
        airline_nodes = item.cssselect("p.airlines-name")
        card_airlines = _text(airline_nodes[0]) if airline_nodes else ""

        legs: List[Leg] = []
        for index, block in enumerate(blocks[:2]):
            base_day = self.query.depart if index == 0 else (self.query.ret or self.query.depart)
            fallback_minutes = _int(
                item.get("data-outboundmins" if index == 0 else "data-returnmins")
            )
            legs.append(
                self._leg(
                    block,
                    base_day.isoformat(),
                    fallback_minutes,
                    detail.leg(index),
                    card_airlines if index == 0 else "",
                )
            )

        links = item.cssselect("a.modal_responsive")
        deeplink = links[0].get("href", "") if links else ""

        itinerary = Itinerary(
            query=self.query,
            outbound=legs[0],
            inbound=legs[1] if len(legs) > 1 else None,
        )
        return Offer(
            itinerary=itinerary,
            source=self.source_name,
            price=price,
            currency=self.currency,
            agent=detail.agent,
            deeplink=deeplink,
            source_id=item.get("data-best", "") or "",
        )

    def _leg(
        self, block, base_day: str, fallback_minutes, panel: "_LegDetail", card_airlines: str
    ) -> Leg:
        endpoints = block.cssselect("p")
        depart_clock = arrive_clock = ""
        origin_airport = destination_airport = ""
        arrive_offset = 0
        if len(endpoints) >= 2:
            depart_clock, _, origin_airport = _clock_and_code(endpoints[0])
            arrive_clock, arrive_offset, destination_airport = _clock_and_code(endpoints[-1])
        if not depart_clock:
            depart_clock = _minutes_to_clock(fallback_minutes)

        spans = block.cssselect("div.stop-arrow span")
        duration = parse_duration(_text(spans[0])) if spans else None
        stops = None
        for span in spans:
            stops = _stop_count(_text(span))
            if stops is not None:
                break

        # The card's own "+1" is the reliable signal; the modal's arrival date
        # only fills in when the card did not carry one.
        arrival_day = base_day if arrive_offset else (panel.arrival_date or base_day)

        _date_segments(panel.segments, base_day)

        return Leg(
            origin_airport=origin_airport,
            destination_airport=destination_airport,
            departure=_iso(base_day, depart_clock),
            arrival=_iso(arrival_day, arrive_clock, arrive_offset),
            duration_minutes=duration,
            stops=stops if stops is not None else _fallback_stops(panel),
            airlines=card_airlines or panel.airlines,
            flight_numbers=", ".join(s.flight_number for s in panel.segments if s.flight_number),
            segments=panel.segments,
        )

    def _price(self, item) -> Optional[float]:
        cents = _int(item.get("data-price"))
        if cents is not None:
            return round(cents / 100.0, 2)
        nodes = item.cssselect("p.prices")
        if not nodes:
            return None
        digits = re.sub(r"[^\d.,]", "", _text(nodes[0])).replace(",", "")
        try:
            return float(digits)
        except ValueError:
            return None


class _LegDetail:
    """One direction's worth of detail from a result's modal."""

    def __init__(self) -> None:
        self.segments: List[Segment] = []
        self.arrival_date: str = ""
        self.airlines: str = ""


class _ModalDetail:
    """Per-leg, per-segment detail lifted from a result's modal.

    The modal holds one ``._panel`` per direction, each containing one
    ``._panel_body`` per flight number, so panel index and leg index line up.
    """

    def __init__(self) -> None:
        self.legs: List[_LegDetail] = []
        self.agent: str = ""

    def leg(self, index: int) -> _LegDetail:
        return self.legs[index] if index < len(self.legs) else _LegDetail()

    @classmethod
    def read(cls, modal) -> "_ModalDetail":
        detail = cls()
        try:
            detail._read(modal)
        except Exception:
            pass  # detail is a bonus; the card already carries the essentials
        return detail

    def _read(self, modal) -> None:
        for panel in modal.cssselect("div._panel"):
            leg = _LegDetail()
            names = panel.cssselect("p._ahn")
            if names:
                leg.airlines = _text(names[0])

            for body in panel.cssselect("div._panel_body"):
                heads = body.cssselect("div._head small")
                carrier_name, carrier, number = _split_flight(_text(heads[0]) if heads else "")

                times = [_text(p) for p in body.cssselect("div.c3 p")]
                places = [_text(p) for p in body.cssselect("div.c4 p")]
                durations = [_text(p) for p in body.cssselect("div.c1 p")]

                leg.segments.append(
                    Segment(
                        carrier=carrier,
                        carrier_name=carrier_name,
                        flight_number=number,
                        origin=places[0].split(" ")[0] if places else "",
                        destination=places[-1].split(" ")[0] if len(places) > 1 else "",
                        departure=times[0] if times else "",
                        arrival=times[-1] if len(times) > 1 else "",
                        duration_minutes=parse_duration(durations[0]) if durations else None,
                    )
                )

            summaries = panel.cssselect("p._summary span")
            if summaries:
                leg.arrival_date = _date_from_words(_text(summaries[0]))
            self.legs.append(leg)

        agents = modal.cssselect("div._similar > div > p")
        if agents:
            self.agent = _text(agents[0])


_STOPS_RE = re.compile(r"^(?:(direct|non-?stop)|(\d+)\s*stops?)$", re.I)


def _stop_count(text: str) -> Optional[int]:
    match = _STOPS_RE.match((text or "").strip())
    if not match:
        return None
    return 0 if match.group(1) else int(match.group(2))


def _fallback_stops(panel: "_LegDetail") -> Optional[int]:
    return max(0, len(panel.segments) - 1) if panel.segments else None


# -- shared helpers --------------------------------------------------------

# Two shapes of airline code, and the order of the alternation is load-bearing.
#
# This portal is Skyscanner-fed, and Skyscanner prints the three-letter ICAO
# code for some carriers: `easyJet EZY5159`, not `easyJet U2 5159`. Matching
# only two characters missed those entirely, and since a miss returns the text
# unsplit, the name kept the digits and the flight number came back empty —
# 547 stored segments in this database, every one of them easyJet.
#
# Three letters are tried first because they are *always* letters, while a
# two-character IATA code may contain a digit (`W6`, `U2`, `4U`). The tempting
# single-class version, `[A-Z][A-Z0-9]{1,2}`, is not equivalent: being greedy
# it reads `KLM KL1405` as code `KL1`, and being letter-first it fails to match
# `Germanwings 4U 8425` at all.
_FLIGHT_RE = re.compile(r"^(?P<name>.*?)\s+(?P<code>[A-Z]{3}|[A-Z0-9]{2})\s?(?P<num>\d{1,4})\s*$")


def _split_flight(text: str) -> Tuple[str, str, str]:
    """``Wizz Air W6 2318`` -> ``('Wizz Air', 'W6', 'W62318')``.

    Anything that is not a name followed by a flight number keeps its text and
    comes back with neither — a ground leg reading `Bus service` is not a
    parse failure worth raising over.
    """
    match = _FLIGHT_RE.match(text.strip())
    if not match:
        return text.strip(), "", ""
    code, num = match.group("code"), match.group("num")
    return match.group("name").strip(), code, f"{code}{num}"


_MONTHS = {
    m: i
    for i, m in enumerate(
        ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
        start=1,
    )
}


def _date_from_words(text: str) -> str:
    """``Mon, 24 Aug 2026`` -> ``2026-08-24``."""
    match = re.search(r"(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})", text or "")
    if not match:
        return ""
    day, month, year = match.groups()
    number = _MONTHS.get(month.title())
    return f"{year}-{number:02d}-{int(day):02d}" if number else ""


def _date_segments(segments: List[Segment], base_day: str) -> None:
    """Give the modal's clock-only times a date, in place.

    The result cards show a segment as ``21:45`` with no date, which is fine on
    screen and useless to anything computing a layover. Walking the segments in
    order and rolling the date forward whenever the clock goes backwards
    recovers it — a connection never departs before the flight that fed it.
    """
    try:
        current = date.fromisoformat(base_day)
    except ValueError:
        return
    previous = ""
    for segment in segments:
        for field in ("departure", "arrival"):
            clock = getattr(segment, field)
            if not clock or "T" in clock:
                continue  # already dated, or missing entirely
            if previous and clock < previous:
                current += timedelta(days=1)
            previous = clock
            setattr(segment, field, _iso(current.isoformat(), clock))


_CLOCK_RE = re.compile(r"^(\d{1,2}):(\d{2})(?:\+(\d))?$")


def _clock_and_code(node) -> Tuple[str, int, str]:
    """``09:00+1`` in a result card means "next day"; return the offset with it."""
    spans = [_text(s) for s in node.cssselect("span")]
    clock, offset = "", 0
    for span in spans:
        match = _CLOCK_RE.match(span)
        if match:
            clock = f"{match.group(1)}:{match.group(2)}"
            offset = int(match.group(3) or 0)
            break
    code = next((s for s in spans if re.fullmatch(r"[A-Z]{3}", s)), "")
    return clock, offset, code


def _iso(day: str, clock: str, day_offset: int = 0) -> str:
    if not day or not clock:
        return ""
    hour, _, minute = clock.partition(":")
    if day_offset:
        try:
            day = (date.fromisoformat(day) + timedelta(days=day_offset)).isoformat()
        except ValueError:
            return ""
    return f"{day}T{int(hour):02d}:{int(minute):02d}"


def _int(value: Any) -> Optional[int]:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def _float(value: Any) -> Optional[float]:
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return None


# -- the two portals -------------------------------------------------------


class _FlightsFinderPortal(Source):
    """Shared driver; subclasses only differ in how they spell the search."""

    portal = ""

    def page_params(self, query: SearchQuery) -> Dict[str, str]:
        raise NotImplementedError

    def search_url(self, query: SearchQuery) -> str:
        return f"{BASE}/portal/{self.portal}?{urlencode(self.page_params(query))}"

    def search(self, query: SearchQuery) -> List[Offer]:
        session = self.session()
        page_url = self.search_url(query)

        response = self.request(session, "get", page_url, timeout=self.timeout)
        if response.status_code != 200:
            raise SourceError(f"search page returned HTTP {response.status_code}")

        endpoint, body = _extract_poll(self.text_of(response))
        headers = {"X-Requested-With": "XMLHttpRequest", "Referer": page_url}
        parser = _CFFLiveParser(self.name, query, self.currency_for(query))

        offers: List[Offer] = []
        deadline = time.monotonic() + 45
        # What the last poll said, and how many polls have said the same thing.
        # See the settle check at the bottom of the loop.
        settled, last = 0, None
        while time.monotonic() < deadline:
            try:
                poll = self.request(
                    session,
                    "post",
                    BASE + endpoint,
                    data=body,
                    headers=headers,
                    timeout=self.timeout,
                )
            except (RateLimited, JobTimeout, CancelledError):
                raise
            except Exception:
                # A slow endpoint, not a failed search. This host times out
                # roughly one poll in four, and the retry in `Source.run`
                # restarts `search` from the top — a fresh search page, a fresh
                # session, the whole poll cycle again — so letting a timeout
                # escape here throws away every offer already collected and
                # pays for the search twice. With results in hand, stop and
                # keep them; with none, there is nothing to salvage.
                if offers:
                    return offers
                raise
            if poll.status_code != 200:
                raise SourceError(f"poll returned HTTP {poll.status_code}")

            parts = self.text_of(poll).split("|")
            if len(parts) <= _HTML:
                raise SourceError("poll response was not the expected pipe-delimited payload")

            if parts[_HTML].strip():
                offers = parser.parse(parts[_HTML])
            if parts[_DONE].strip() == "Y":
                break

            # The done flag is not dependable on every portal. `/portal/kiwi`
            # answers "Y" on its first poll; `/portal/sky` was measured over
            # two live searches saying "N" to all of them — 5 polls and 8 —
            # while the result count sat unchanged at 161 and 181 from the
            # third poll on. Left to the deadline alone, every sky search
            # spends its full 45 seconds re-fetching a 2.5 MB payload that
            # stopped changing 25 seconds ago, and usually meets a timeout
            # doing it.
            #
            # So a count that has not moved for three polls running is treated
            # as finished. Deliberately *not* the length of the markup, which
            # the sketch for this fix suggested: those same runs showed it
            # drifting by ~200 bytes between polls carrying identical results
            # (2,526,256 → 2,526,428 → 2,526,628), so byte equality never
            # settles. The count and the offers actually parsed out of it both
            # hold still, and they are what we are waiting for anyway.
            heard = (parts[_COUNT].strip(), len(offers))
            settled = settled + 1 if heard == last else 0
            last = heard
            if settled >= 2 and offers:
                break
            self.pause(0.8)

        return offers


class FlightsFinderSky(_FlightsFinderPortal):
    """FlightsFinder's Skyscanner-fed portal."""

    name = "ff-sky"
    label = "FlightsFinder (Sky)"
    portal = "sky"

    CABINS = {
        "economy": "Economy",
        "premiumeconomy": "PremiumEconomy",
        "business": "Business",
        "first": "First",
    }

    def page_params(self, query: SearchQuery) -> Dict[str, str]:
        return {
            "originplace": query.origin,
            "destinationplace": query.destination,
            "outbounddate": query.depart.isoformat(),
            "inbounddate": query.ret.isoformat() if query.ret else "",
            "cabinclass": self.CABINS[query.cabin],
            "adults": str(query.adults),
            "children": str(query.children),
            "infants": str(query.infants),
            "currency": query.currency,
        }


class FlightsFinderKiwi(_FlightsFinderPortal):
    """FlightsFinder's Kiwi-fed portal, which reaches the low-cost carriers."""

    name = "ff-kiwi"
    label = "FlightsFinder (Kiwi)"
    portal = "kiwi"

    CABINS = {"economy": "M", "premiumeconomy": "W", "business": "C", "first": "F"}

    def page_params(self, query: SearchQuery) -> Dict[str, str]:
        return {
            "currency": query.currency,
            "type": "return" if query.round_trip else "oneway",
            "cabinclass": self.CABINS[query.cabin],
            "originplace": query.origin,
            "destinationplace": query.destination,
            # This portal wants day-first dates, unlike its sibling.
            "outbounddate": query.depart.strftime("%d/%m/%Y"),
            "inbounddate": query.ret.strftime("%d/%m/%Y") if query.ret else "",
            "adults": str(query.adults),
            "children": str(query.children),
            "infants": str(query.infants),
        }

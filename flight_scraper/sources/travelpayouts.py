"""Jetradar / Aviasales inventory, via the Travelpayouts white-label API.

``jetradeu.cheapflightsfinder.com`` is a Travelpayouts storefront, and its API
is a clean three-step JSON flow:

1. ``POST /whitelabels/web/flights/v1/search/sign`` returns a signature for the
   exact search payload you intend to run;
2. ``POST /search/wl/start`` replays that payload plus the signature and hands
   back a search id and the region host that will hold the results;
3. ``POST /search/wl/results`` on that host returns tickets, polled until the
   feed stops growing.

The signature is computed server-side, so there is no secret to reproduce — but
both calls are rejected without the ``affiliate-marker`` and
``x-whitelabel-version`` headers the storefront sends.
"""

from __future__ import annotations

import time
import uuid
import math
from typing import Any, Dict, List, Optional

from ..models import Itinerary, Leg, Offer, SearchQuery, Segment
from .base import Source, SourceError

HOST = "jetradeu.cheapflightsfinder.com"
MARKER = "148729"
SIGN_URL = "https://api.apistp.com/whitelabels/web/flights/v1/search/sign"
START_URL = "https://tickets-api.apistp.com/search/wl/start"

_CABINS = {"economy": "Y", "premiumeconomy": "W", "business": "C", "first": "F"}

# What the shareable link token can express, which is less than the API can
# search. Lowercase matters; see :meth:`Travelpayouts.search_url`.
_LINK_CABINS = {"economy": "", "premiumeconomy": "", "business": "b", "first": "b"}


class Travelpayouts(Source):
    name = "jetradar"
    label = "Jetradar"

    def search_url(self, query: SearchQuery) -> str:
        """The storefront's own compact search token.

        Parsed strictly positionally::

            ORIGIN + DDMM + DESTINATION + [DDMM return] + [cabin] + adults +
            children + infants

        The cabin letter is lowercase and case-sensitive — an uppercase one is
        silently ignored and the search falls back to economy. Only two cabins
        survive the round trip through this token: ``b`` (or ``c``) sends
        ``trip_class=C``, and everything else, ``w`` and ``f`` included, sends
        ``Y``. First class therefore links as business, the nearest cabin the
        storefront can express.

        This affects only the link. The search itself posts ``trip_class``
        straight to the API, so premium economy and first are searched properly
        even when the link cannot say so.
        """
        return f"https://{HOST}/flights/{self._link_token(query)}"

    def _link_token(self, query: SearchQuery) -> str:
        """The token itself, shared by the search link and the ticket link."""
        parts = [query.origin, query.depart.strftime("%d%m"), query.destination]
        if query.ret:
            parts.append(query.ret.strftime("%d%m"))
        parts.append(_LINK_CABINS[query.cabin])
        parts.append(f"{query.adults}{query.children}{query.infants}")
        return "".join(parts)

    def ticket_url(self, query: SearchQuery, ticket_id: str) -> str:
        """A link to one specific deal, rather than the search that found it.

        The storefront reads ``ticketId`` off the query string and re-runs the
        search with that ticket highlighted — it even reports whether the fare
        moved in the meantime.

        This is deliberately **not** the airline's own booking URL. That one
        exists (``GET /searches/{search_id}/clicks/{proposal_id}`` hands it
        over) but it expires roughly 15 minutes after it is minted, which is
        also the lifetime of the search behind it. A link that dies a quarter
        of an hour after the scrape is worse than useless in a database that
        is meant to be queried days later, and resolving one on demand means
        running a fresh search before the browser can even open. A stable link
        that re-prices itself on arrival beats a direct link that is usually
        dead.

        Ticket ids are stable across searches — the same id comes back for the
        same itinerary on a later run — which is what makes storing this safe.
        """
        if not ticket_id:
            return self.search_url(query)
        return f"https://{HOST}/?flightSearch={self._link_token(query)}&ticketId={ticket_id}"

    # -- the search payload ------------------------------------------------

    def _payload(self, query: SearchQuery) -> Dict[str, Any]:
        directions = [{
            "origin": query.origin,
            "destination": query.destination,
            "date": query.depart.isoformat(),
            "is_origin_airport": len(query.origin) == 3 and query.origin.isalpha(),
            "is_destination_airport": False,
        }]
        if query.ret:
            directions.append({
                "origin": query.destination,
                "destination": query.origin,
                "date": query.ret.isoformat(),
                "is_origin_airport": False,
                "is_destination_airport": False,
            })
        # The marker is per-visitor; a fresh one each run keeps searches from
        # being folded together upstream.
        marker = f"{MARKER}.Z{uuid.uuid4().hex[:24]}-{MARKER}"
        return {
            "citizenship": "DE",
            "client_features": {"badges": True},
            "currency_code": query.currency,
            "host": HOST,
            "languages": {"en": 1},
            "marker": marker,
            "market_code": "DE",
            "search_params": {
                "directions": directions,
                "passengers": {
                    "adults": query.adults,
                    "children": query.children,
                    "infants": query.infants,
                },
                "trip_class": _CABINS[query.cabin],
            },
        }

    @property
    def _headers(self) -> Dict[str, str]:
        return {
            "Content-Type": "application/json",
            "Accept": "application/json, text/plain, */*",
            "Origin": f"https://{HOST}",
            "Referer": f"https://{HOST}/",
            "accept-language": "en-GB",
            "affiliate-marker": MARKER,
            "x-whitelabel-version": "v2",
        }

    # -- driving -----------------------------------------------------------

    def search(self, query: SearchQuery) -> List[Offer]:
        session = self.session()
        headers = self._headers
        payload = self._payload(query)

        signed = self.request(session, "post", SIGN_URL, json=payload, headers=headers, timeout=self.timeout)
        if signed.status_code != 200:
            raise SourceError(f"signing returned HTTP {signed.status_code}")
        payload["signature"] = (signed.json() or {}).get("signature")
        if not payload["signature"]:
            raise SourceError("signing returned no signature")

        started = self.request(session, "post", START_URL, json=payload, headers=headers, timeout=self.timeout)
        if started.status_code != 200:
            raise SourceError(f"search start returned HTTP {started.status_code}")
        opening = started.json()

        search_id = opening.get("search_id")
        results_host = opening.get("results_url")
        if not search_id or not results_host:
            raise SourceError("search start returned no results endpoint")

        results_url = f"https://{results_host}/search/wl/results"
        interval = (opening.get("polling_interval_ms") or 1000) / 1000.0

        collected: Dict[str, Offer] = {}
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            poll = self.request(session, "post", 
                results_url, json={"search_id": search_id}, headers=headers, timeout=self.timeout
            )
            if poll.status_code == 204:
                self.pause(interval)
                continue
            if poll.status_code != 200:
                break

            chunks = poll.json()
            if not isinstance(chunks, list):
                break
            finished = False
            for chunk in chunks:
                if not isinstance(chunk, dict):
                    continue
                for offer in self._parse_chunk(chunk, query):
                    collected.setdefault(offer.source_id, offer)
                if chunk.get("last_result"):
                    finished = True
            if finished or not chunks:
                break
            self.pause(interval)

        return list(collected.values())

    # -- parsing -----------------------------------------------------------

    def _parse_chunk(self, chunk: Dict[str, Any], query: SearchQuery) -> List[Offer]:
        tickets = chunk.get("tickets") or []
        if not tickets:
            return []

        flight_legs = chunk.get("flight_legs") or []
        airlines = chunk.get("airlines") or {}
        agents = chunk.get("agents") or {}

        offers: List[Offer] = []
        for ticket in tickets:
            if not isinstance(ticket, dict):
                continue
            proposal = self._cheapest_proposal(ticket)
            if proposal is None:
                continue
            price_block = proposal.get("price") or {}
            price = price_block.get("value")
            if price is None:
                continue

            legs = [
                self._leg(segment, flight_legs, airlines, proposal)
                for segment in (ticket.get("segments") or [])
            ]
            legs = [leg for leg in legs if leg is not None]
            if not legs:
                continue

            agent = agents.get(str(proposal.get("agent_id"))) or {}
            agent_name = ((agent.get("label") or {}).get("en") or {}).get("default") \
                or agent.get("gate_name", "")

            itinerary = Itinerary(
                query=query, outbound=legs[0], inbound=legs[1] if len(legs) > 1 else None
            )
            offers.append(
                Offer(
                    itinerary=itinerary,
                    source=self.name,
                    price=float(price),
                    currency=(price_block.get("currency_code") or query.currency).upper(),
                    agent=agent_name,
                    deeplink=self.ticket_url(query, str(ticket.get("id") or "")),
                    source_id=f"{ticket.get('id', '')}:{proposal.get('id', '')}",
                )
            )
        return offers

    @staticmethod
    def _cheapest_proposal(ticket: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        proposals = [p for p in (ticket.get("proposals") or []) if isinstance(p, dict)]
        if not proposals:
            return None
        return min(
            proposals, key=lambda p: (p.get("price") or {}).get("value", float("inf"))
        )

    @staticmethod
    def _leg(segment: Dict[str, Any], flight_legs, airlines, proposal) -> Optional[Leg]:
        indices = segment.get("flights") or []
        raw_flights = [
            flight_legs[i] for i in indices
            if isinstance(i, int) and 0 <= i < len(flight_legs)
        ]
        if not raw_flights:
            return None

        terms = proposal.get("flight_terms") or {}
        segments: List[Segment] = []
        for index, raw in zip(indices, raw_flights):
            # Prefer the marketing carrier from the fare terms; the leg itself
            # names the operating carrier, which is often a wet-lease subsidiary.
            term = terms.get(str(index)) or {}
            designator = term.get("marketing_carrier_designator") \
                or raw.get("operating_carrier_designator") or {}
            code = designator.get("carrier", "")
            segments.append(
                Segment(
                    carrier=code,
                    carrier_name=((airlines.get(code) or {}).get("name") or {})
                    .get("en", {}).get("default", "") if airlines else "",
                    flight_number=f"{code}{designator.get('number', '')}".strip(),
                    origin=raw.get("origin", ""),
                    destination=raw.get("destination", ""),
                    departure=_iso(raw.get("local_departure_date_time", "")),
                    arrival=_iso(raw.get("local_arrival_date_time", "")),
                    duration_minutes=_elapsed_minutes(raw.get("departure_unix_timestamp"), raw.get("arrival_unix_timestamp")),
                )
            )

        names, seen = [], set()
        for item in segments:
            display = item.carrier_name or item.carrier
            if display and display not in seen:
                seen.add(display)
                names.append(display)

        first, last = raw_flights[0], raw_flights[-1]
        duration = _elapsed_minutes(first.get("departure_unix_timestamp"), last.get("arrival_unix_timestamp"))

        return Leg(
            origin_airport=first.get("origin", ""),
            destination_airport=last.get("destination", ""),
            departure=_iso(first.get("local_departure_date_time", "")),
            arrival=_iso(last.get("local_arrival_date_time", "")),
            duration_minutes=duration,
            stops=max(0, len(segments) - 1),
            airlines=", ".join(names),
            flight_numbers=", ".join(s.flight_number for s in segments if s.flight_number),
            segments=segments,
        )


def _elapsed_minutes(departure, arrival) -> Optional[int]:
    """Use absolute timestamps; local airport clocks have different offsets."""
    if isinstance(departure, bool) or isinstance(arrival, bool):
        return None
    try:
        start, end = float(departure), float(arrival)
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(start) or not math.isfinite(end) or end <= start:
        return None
    minutes = int((end - start) // 60)
    return minutes if minutes > 0 else None


def _iso(value: str) -> str:
    """``2026-08-22 18:40`` -> ``2026-08-22T18:40``."""
    return (value or "").replace(" ", "T")

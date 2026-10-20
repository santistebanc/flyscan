"""The Kayak search engine, reached through two of its front ends.

``ie-kayak.flightsfinder.com`` and ``www.momondo.ie`` are the same software
with different paint, so one adapter drives both: fetch the search page for a
session cookie and a form token, then POST the search to
``/i/api/search/dynamic/flights/poll`` until it reports itself complete.

Two details make it work. The poll rejects anything without an ``X-CSRF``
header, and the token for it is the ``formtoken`` embedded in the search page.
And the poll answers incrementally — each response is a page of results for the
state of the search at that moment, not a superset of the last — so results are
accumulated across polls by id rather than taken from the final response.

Polling to completion still only ever re-reads the first page. The real result
count is in ``filteredCount``, and the rest is reached by walking
``searchMetaData.pageNumber``.
"""

from __future__ import annotations

import re
import time
from typing import Any, Dict, List, Optional

from ..models import (
    DEFAULT_CHILD_AGE, Itinerary, Leg, Offer, SearchQuery, Segment,
)
from .base import ChallengeRequired, Source, SourceError
from ..task_queue import RateLimited, JobTimeout
from concurrent.futures import CancelledError

_FORMTOKEN_RE = re.compile(r'"formtoken"\s*:\s*"([^"]+)"')

# A real airline code is two alphanumerics with at least one letter (FR, U2, 4U).
# Kayak also sells coaches and trains on this endpoint, and those come back with
# an all-numeric operator code and "---" where the flight number should be.
_AIRLINE_CODE_RE = re.compile(r"^(?=.*[A-Z])[A-Z0-9]{2}$")

# Bound on how far to page through results, so one very broad search
# cannot spend the whole run here.
MAX_PAGES = 8

#: Pause between page requests. Paging multiplies the POSTs per search several
#: times over, and this engine answers a burst of them with
#: ``BOT_CAPTCHA_REDIRECT`` — a 403 that is scoped to the IP, not the session,
#: so opening a fresh one does not clear it. Pacing is cheaper than being
#: blocked for the rest of the run.
PAGE_DELAY = 0.6

# Passenger type codes, in the order the site itself lists them: adults, then
# lap infants, then children. A lap infant is INL, not INF, and a child carries
# its age — the search is rejected or silently mispriced without it.
_ADULT, _INFANT_LAP, _CHILD = "ADT", "INL", "CHD"

# Cabin rides inside each leg, and economy is expressed by leaving it out —
# sending it explicitly, under any spelling, is a validation error. Premium
# economy is hyphenated in the request body but a bare "premium" in the URL
# path, and every other spelling of it is a 400.
_CABINS = {
    "economy": "", "premiumeconomy": "premium-economy",
    "business": "business", "first": "first",
}
_URL_CABINS = {
    "economy": "", "premiumeconomy": "premium", "business": "business", "first": "first",
}


class _KayakEngine(Source):
    """Base for any Kayak-powered host.

    Currency here follows the host's domain rather than any request parameter —
    both of these are ``.ie`` sites and quote EUR no matter what you ask for.
    Subclasses declare that, so the UI stops promising a currency this engine
    will not honour. The parser still reads each offer's own currency from the
    response, so pointing this at a non-EUR host would still store the truth.
    """

    host = ""
    #: Path segment the host puts its results under; the two brands differ.
    search_path = "flights"
    sort_mode = "price_a"

    # The strictest limits of any source here. One search at a time, spaced:
    # a single search already costs a page fetch plus a poll per phase plus a
    # request per result page, and overlapping two of those is what earns the
    # IP-scoped bot block.
    max_concurrency = 1
    min_interval = 2.5
    challenge_statuses = (403,)

    # -- URLs --------------------------------------------------------------

    def search_url(self, query: SearchQuery) -> str:
        legs = f"{query.origin}-{query.destination}/{query.depart.isoformat()}"
        if query.ret:
            legs += f"/{query.ret.isoformat()}"
        else:
            legs += "/"
        travellers = f"{query.adults}adults"
        # Everyone who is not an adult goes in one "children" segment: a lap
        # infant is the literal "1L", a child is its age. Lap infants first,
        # e.g. 2 adults, 3 children and 2 lap infants ->
        # "2adults/children-1L-1L-10-10-10". This engine is the only one that
        # wants an age at all, so every child is sent as DEFAULT_CHILD_AGE.
        minors = ["1L"] * query.infants + [str(DEFAULT_CHILD_AGE)] * query.children
        if minors:
            travellers += "/children-" + "-".join(minors)
        cabin = _URL_CABINS[query.cabin]
        path = f"{legs}/{cabin}/{travellers}" if cabin else f"{legs}/{travellers}"
        return f"https://{self.host}/{self.search_path}/{path}?sort={self.sort_mode}"

    @property
    def poll_url(self) -> str:
        return f"https://{self.host}/i/api/search/dynamic/flights/poll"

    # -- request body ------------------------------------------------------

    def _legs(self, query: SearchQuery) -> List[Dict[str, Any]]:
        cabin = _CABINS[query.cabin]

        def leg(origin: str, destination: str, day) -> Dict[str, Any]:
            built = {
                "origin": {"airports": [origin], "locationType": "airports"},
                "destination": {"airports": [destination], "locationType": "airports"},
                "date": day.isoformat(),
                "flex": "exact",
            }
            if cabin:
                built["cabinClass"] = cabin
            return built

        legs = [leg(query.origin, query.destination, query.depart)]
        if query.ret:
            legs.append(leg(query.destination, query.origin, query.ret))
        return legs

    def _body(self, query: SearchQuery) -> Dict[str, Any]:
        passengers = (
            [_ADULT] * query.adults
            + [_INFANT_LAP] * query.infants
            + [_CHILD] * query.children
        )
        details: List[Dict[str, Any]] = [{"ptc": _ADULT}] * query.adults
        details += [{"ptc": _INFANT_LAP}] * query.infants
        details += [{"ptc": _CHILD, "age": DEFAULT_CHILD_AGE}] * query.children

        return {
            "filterParams": {},
            "userSearchParams": {
                "legs": self._legs(query),
                "passengers": passengers,
                "passengerDetails": details,
                "sortMode": self.sort_mode,
            },
            "searchMetaData": {"pageNumber": 1, "searchTypes": []},
        }

    # -- driving the search ------------------------------------------------

    def search(self, query: SearchQuery) -> List[Offer]:
        session = self.session()
        page_url = self.search_url(query)

        page = self.request(session, "get", page_url, timeout=self.timeout)
        if page.status_code != 200:
            raise SourceError(f"search page returned HTTP {page.status_code}")
        token_match = _FORMTOKEN_RE.search(self.text_of(page))
        if not token_match:
            # A block arrives here as a *page*, not a 403: the search URL
            # redirects to /security/check and answers 200 with markup that has
            # no form token in it. Reported as an ordinary parse failure it
            # reads like the site changed its HTML, and — far worse — it is
            # retried, because `SourceError` is retryable. One search of eight
            # trips then becomes twenty-eight attempts aimed at a host that has
            # just asked for a human, which is the exact thing
            # `ChallengeRequired` exists to prevent.
            self._raise_if_security_page(page)
            raise SourceError("search page carried no form token")

        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Origin": f"https://{self.host}",
            "Referer": page_url,
            "X-Requested-With": "XMLHttpRequest",
            "X-CSRF": token_match.group(1),
        }

        body = self._body(query)
        first = self.request(session, "post", self.poll_url, json=body, headers=headers, timeout=self.timeout)
        self._raise_if_challenged(first)
        if first.status_code != 200:
            raise SourceError(f"poll returned HTTP {first.status_code}")
        opening = first.json()
        search_id = opening.get("searchId")
        if not search_id:
            raise SourceError("poll returned no search id")

        body["userSearchParams"]["searchId"] = search_id
        body["searchMetaData"]["skipResultsInSecondPhase"] = False

        collected: Dict[str, Offer] = {}
        payload: Dict[str, Any] = {}
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            try:
                poll = self.request(session, "post", 
                    self.poll_url, json=body, headers=headers, timeout=self.timeout
                )
            except (RateLimited, JobTimeout, CancelledError):
                raise
            except Exception:
                # Same reasoning as the non-200 break below, for the case the
                # status check never gets to see: a timeout mid-poll is this
                # endpoint being slow, and `Source.run` would answer it by
                # re-running the whole search from the page fetch. Anything
                # already accumulated is worth more than a second attempt.
                if collected:
                    return list(collected.values())
                raise
            self._raise_if_challenged(poll)
            if poll.status_code != 200:
                break
            payload = poll.json()
            for offer in self._parse(payload, query):
                collected.setdefault(offer.source_id, offer)
            if str(payload.get("status", "")).lower() == "complete":
                break
            self.pause(1.2)

        self._collect_pages(session, headers, body, query, payload, collected)

        return list(collected.values())

    def _raise_if_security_page(self, response) -> None:
        """The same block, served as a page instead of a 403.

        Only called once the form token is already missing, so a page that
        merely mentions the security path in a script somewhere cannot be
        mistaken for one.
        """
        landed = str(getattr(response, "url", "") or "")
        body = self.text_of(response)
        markers = ("/security/check", "recaptcha", "unusual traffic",
                   "are you a robot")
        looks_blocked = "/security/check" in landed or any(
            marker in body.lower() for marker in markers
        )
        if not looks_blocked:
            return
        raise ChallengeRequired(
            landed if "/security/check" in landed
            else f"https://{self.host}/security/check",
            self.name,
        )

    @staticmethod
    def _raise_if_challenged(response) -> None:
        """Turn this engine's bot 403 into a challenge a person can clear.

        The body names the page to send them to, which is a real Continue
        button in front of reCAPTCHA — not the static "you look like a bot"
        explainer the search path redirects to. Worth reading rather than
        treating the 403 as a dead end.
        """
        if response.status_code != 403:
            return
        url = ""
        try:
            payload = response.json() or {}
            url = payload.get("captchaRedirectUrl") or ""
        except Exception:
            payload = {}
        if url:
            raise ChallengeRequired(url, source="kayak")
        raise SourceError("blocked by the bot check, with no challenge offered")

    def _collect_pages(
        self,
        session,
        headers: Dict[str, str],
        body: Dict[str, Any],
        query: SearchQuery,
        payload: Dict[str, Any],
        collected: Dict[str, Offer],
    ) -> None:
        """Walk past the first page of results.

        The poll answers one ``pageSize`` page at a time and reports the real
        total in ``filteredCount``. Polling alone only ever re-reads page one,
        so without this these two sources contributed about a quarter of what
        they actually found — 50 results out of 194 on a typical search.
        """
        page_size = int(payload.get("pageSize") or 0)
        expected = int(payload.get("filteredCount") or 0)
        if not page_size or len(collected) >= expected:
            return

        deadline = time.monotonic() + 45
        for page_number in range(2, MAX_PAGES + 1):
            if time.monotonic() > deadline or len(collected) >= expected:
                return
            self.pause(PAGE_DELAY)
            body["searchMetaData"]["pageNumber"] = page_number
            try:
                poll = self.request(session, "post", 
                    self.poll_url, json=body, headers=headers, timeout=self.timeout
                )
            except (RateLimited, JobTimeout, CancelledError):
                raise
            except Exception:
                # Page-walking is already best-effort — it gives up quietly on
                # a non-200 or a short page — and a timeout is the same story.
                # `collected` is the caller's dict and keeps what got there.
                return
            self._raise_if_challenged(poll)
            if poll.status_code != 200:
                return
            page = poll.json()
            results = page.get("results") or []
            before = len(collected)
            for offer in self._parse(page, query):
                collected.setdefault(offer.source_id, offer)
            # A short page is the last one; no new ids means we are going in circles.
            if len(results) < page_size or len(collected) == before:
                return

    # -- parsing -----------------------------------------------------------

    def _parse(self, payload: Dict[str, Any], query: SearchQuery) -> List[Offer]:
        results = payload.get("results") or []
        if not results:
            return []

        legs_index = payload.get("legs") or {}
        segments_index = payload.get("segments") or {}
        airlines = payload.get("airlines") or {}
        providers = payload.get("providers") or {}
        currency = self.currency_for(query)

        offers: List[Offer] = []
        for result in results:
            if not isinstance(result, dict):
                continue
            # The feed also carries UI cards such as price-alert prompts.
            if result.get("type") != "core":
                continue
            legs = result.get("legs") or []
            if not legs:
                continue

            built = [
                self._leg(leg, legs_index, segments_index, airlines)
                for leg in legs
            ]
            if any(not leg.segments for leg in built):
                continue  # a coach or train, not a flight
            booking = self._cheapest_booking(result)
            if booking is None:
                continue
            price_block = self._total_price(booking)
            price = price_block.get("price")
            if price is None:
                continue

            provider_code = booking.get("providerCode", "")
            provider = providers.get(provider_code) or {}
            url = ((booking.get("bookingUrl") or {}).get("url") or "")
            if url.startswith("/"):
                url = f"https://{self.host}{url}"

            itinerary = Itinerary(
                query=query,
                outbound=built[0],
                inbound=built[1] if len(built) > 1 else None,
            )
            offers.append(
                Offer(
                    itinerary=itinerary,
                    source=self.name,
                    price=float(price),
                    currency=(price_block.get("currency") or currency).upper(),
                    agent=provider.get("displayName") or provider_code,
                    deeplink=url,
                    source_id=result.get("resultId", ""),
                )
            )
        return offers

    @staticmethod
    def _total_price(booking: Dict[str, Any]) -> Dict[str, Any]:
        """The whole trip's price, not one traveller's share.

        This engine reports ``priceMode: "per-person"``: ``displayPrice`` is
        what one passenger pays, while ``fees.totalPrice`` covers the party. For
        a single adult the two are equal, so the difference only shows up on
        multi-passenger searches — where taking ``displayPrice`` would have made
        these two sources look about a third the price of the other five, which
        all quote trip totals.
        """
        total = (booking.get("fees") or {}).get("totalPrice") or {}
        if total.get("price") is not None:
            return total
        return booking.get("displayPrice") or {}

    @classmethod
    def _cheapest_booking(cls, result: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        options = [o for o in (result.get("bookingOptions") or []) if isinstance(o, dict)]
        if not options:
            return None
        return min(
            options,
            key=lambda o: cls._total_price(o).get("price", float("inf")),
        )

    @staticmethod
    def _leg(leg: Dict[str, Any], legs_index, segments_index, airlines) -> Leg:
        detail = legs_index.get(leg.get("id"), {}) if isinstance(legs_index, dict) else {}

        segments: List[Segment] = []
        for ref in leg.get("segments") or []:
            raw = segments_index.get(ref.get("id"), {}) if isinstance(segments_index, dict) else {}
            if not raw:
                continue
            code = raw.get("airline", "")
            number = str(raw.get("flightNumber", ""))
            if not _AIRLINE_CODE_RE.match(code.upper()) or not number.isdigit():
                return Leg()  # ground transport; the caller drops the whole result
            segments.append(
                Segment(
                    carrier=code,
                    carrier_name=(airlines.get(code) or {}).get("name", "") if airlines else "",
                    flight_number=f"{code}{number}",
                    origin=raw.get("origin", ""),
                    destination=raw.get("destination", ""),
                    departure=raw.get("departure", ""),
                    arrival=raw.get("arrival", ""),
                    duration_minutes=raw.get("duration"),
                )
            )

        names, seen = [], set()
        for segment in segments:
            display = segment.carrier_name or segment.carrier
            if display and display not in seen:
                seen.add(display)
                names.append(display)

        return Leg(
            origin_airport=segments[0].origin if segments else "",
            destination_airport=segments[-1].destination if segments else "",
            departure=detail.get("departure", "") or (segments[0].departure if segments else ""),
            arrival=detail.get("arrival", "") or (segments[-1].arrival if segments else ""),
            duration_minutes=detail.get("duration"),
            stops=max(0, len(segments) - 1),
            airlines=", ".join(names),
            flight_numbers=", ".join(s.flight_number for s in segments if s.flight_number),
            segments=segments,
        )


class FlightsFinderKayak(_KayakEngine):
    """FlightsFinder's Kayak white-label."""

    name = "ff-kayak"
    label = "FlightsFinder (Kayak)"
    host = "ie-kayak.flightsfinder.com"
    fixed_currency = "EUR"


class Momondo(_KayakEngine):
    """Momondo, which runs the same engine on its own inventory deals."""

    name = "momondo"
    label = "Momondo"
    host = "www.momondo.ie"
    fixed_currency = "EUR"
    # Momondo serves results under /flight-search/; /flights/ currently
    # redirects there, but the canonical path is the one to link people to.
    search_path = "flight-search"

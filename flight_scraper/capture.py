"""Keep the response that broke a parse.

When a site changes its markup, what survives today is an error string and a
count that dropped — the bytes that caused it are gone, and the only way to see
them again is to run another live search and hope the site is still in the same
mood. Scrapers are the case where the input is not under our control and not
reproducible, which is exactly the case fixtures exist for.

So: a recorder that writes every exchange one real search makes, and a player
that answers from those recordings and **never** touches the network. A suite
that quietly reaches the internet when a recording is incomplete passes on a
good day and fails in CI for reasons nobody can reproduce, so a missing or
exhausted recording is an error here, not a fetch.

Three things make a recording worth keeping:

*Whole exchanges.* Method, URL, request headers and body, status, response
headers and body — enough to replay the parse exactly as it ran.

*A truncation flag.* Bodies are capped, and a clipped JSON body replays as a
parse error that looks precisely like a scraper bug. If we cut it, the
recording says so and the player refuses to pretend otherwise.

*The expected outcome, beside the bytes.* Not just how many offers came out:
a digest of the parsed values too. Markup that still parses but yields empty
flight numbers or wrong prices is the failure that matters, and a count alone
sails straight past it.
"""

from __future__ import annotations

import hashlib
import json
import re
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

from lxml import html as lxml_html

from .models import Offer, SearchQuery
from .sources import REGISTRY, Source

#: Bodies larger than this are cut. One ff-sky poll answers with 2.7 MB and a
#: full search is 32 MB of near-identical payloads — not something to commit.
MAX_BODY = 2 * 1024 * 1024

INDEX = "index.json"


# -- what a recording holds ------------------------------------------------


@dataclass
class Exchange:
    """One request and its answer."""

    method: str
    url: str
    request_headers: Dict[str, str] = field(default_factory=dict)
    request_body: Optional[str] = None
    status: int = 200
    response_headers: Dict[str, str] = field(default_factory=dict)
    body_file: str = ""
    #: True when the body was cut to `MAX_BODY`. Replaying a truncated body is
    #: refused rather than silently handed to a parser.
    truncated: bool = False
    bytes: int = 0

    @property
    def key(self) -> str:
        return f"{self.method.upper()} {self.url}"

    def to_dict(self) -> Dict[str, Any]:
        return {
            "method": self.method, "url": self.url,
            "request_headers": self.request_headers, "request_body": self.request_body,
            "status": self.status, "response_headers": self.response_headers,
            "body": self.body_file, "truncated": self.truncated, "bytes": self.bytes,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Exchange":
        return cls(
            method=data["method"], url=data["url"],
            request_headers=data.get("request_headers") or {},
            request_body=data.get("request_body"),
            status=data.get("status", 200),
            response_headers=data.get("response_headers") or {},
            body_file=data.get("body", ""),
            truncated=bool(data.get("truncated")),
            bytes=int(data.get("bytes") or 0),
        )


class RecordingMissing(RuntimeError):
    """The player was asked for something the recording does not hold.

    Deliberately loud. The alternative — falling through to the network — is a
    test that passes locally and fails in CI with no way to tell why.
    """


# -- the digest ------------------------------------------------------------


def digest_offers(offers: List[Offer]) -> str:
    """A fingerprint of what was parsed, not merely how much of it.

    Covers the fields a markup change quietly ruins: the price, who is selling
    it, and every segment's carrier, flight number, airports and times. A
    count alone would not have noticed easyJet losing its flight number for
    547 stored segments.
    """
    rows: List[str] = []
    for offer in offers:
        legs = [offer.itinerary.outbound, offer.itinerary.inbound]
        parts = [
            f"{offer.price:.2f}", offer.currency, offer.agent or "",
            offer.itinerary.trip_key,
        ]
        for leg in legs:
            if leg is None:
                continue
            parts.append(f"{leg.origin_airport}>{leg.destination_airport}")
            parts.append(f"{leg.departure}/{leg.arrival}")
            for segment in leg.segments:
                parts.append(
                    f"{segment.carrier}:{segment.flight_number}:"
                    f"{segment.origin}>{segment.destination}:"
                    f"{segment.departure}/{segment.arrival}"
                )
        rows.append("|".join(parts))
    rows.sort()
    return "sha256:" + hashlib.sha256("\n".join(rows).encode()).hexdigest()[:32]


# -- fake responses --------------------------------------------------------


class Replayed:
    """Stands in for a curl_cffi response, from bytes on disk."""

    def __init__(self, status: int, headers: Dict[str, str], content: bytes, url: str):
        self.status_code = status
        self.headers = headers
        self.content = content
        self.url = url

    @property
    def text(self) -> str:
        return self.content.decode("utf-8", errors="replace")

    def json(self) -> Any:
        return json.loads(self.content.decode("utf-8", errors="replace"))


class _Cookies:
    """Enough of a cookie jar for `Source.session` to write into."""

    def __init__(self) -> None:
        self.jar: Dict[str, str] = {}

    def set(self, name: str, value: str, **kwargs: Any) -> None:
        self.jar[name] = value


# -- recording -------------------------------------------------------------


class RecordingSession:
    """Wraps a real session and writes down everything that passes through."""

    def __init__(self, inner: Any, directory: Path, cap: int = MAX_BODY):
        self._inner = inner
        self._dir = directory
        self._cap = cap
        self.exchanges: List[Exchange] = []
        self.cookies = inner.cookies

    def get(self, url: str, **kwargs: Any) -> Any:
        return self._record("GET", url, self._inner.get(url, **kwargs), kwargs)

    def post(self, url: str, **kwargs: Any) -> Any:
        return self._record("POST", url, self._inner.post(url, **kwargs), kwargs)

    def _record(self, method: str, url: str, response: Any, kwargs: Dict[str, Any]) -> Any:
        raw = response.content if isinstance(response.content, (bytes, bytearray)) else b""
        truncated = len(raw) > self._cap
        body = bytes(raw[: self._cap])

        name = f"{len(self.exchanges) + 1:03d}.body"
        (self._dir / name).write_bytes(body)

        sent = kwargs.get("data") or kwargs.get("json")
        self.exchanges.append(Exchange(
            method=method, url=url,
            request_headers=dict(kwargs.get("headers") or {}),
            request_body=(
                sent if isinstance(sent, str)
                else json.dumps(sent, default=str) if sent is not None else None
            ),
            status=response.status_code,
            response_headers={
                k: v for k, v in dict(getattr(response, "headers", {}) or {}).items()
                if k.lower() in ("content-type", "content-encoding", "location")
            },
            body_file=name, truncated=truncated, bytes=len(raw),
        ))
        return response


# -- replaying -------------------------------------------------------------


class PlayerSession:
    """Answers from a recording, in order, and never opens a socket.

    These sources poll one endpoint many times, so the same key has to walk
    forward through its recorded answers rather than repeat the first one —
    otherwise a poll loop replays its own first response until the deadline.
    """

    def __init__(self, recording: "Recording"):
        self._recording = recording
        self._cursor: Dict[str, int] = {}
        self.cookies = _Cookies()

    def get(self, url: str, **kwargs: Any) -> Replayed:
        return self._answer("GET", url)

    def post(self, url: str, **kwargs: Any) -> Replayed:
        return self._answer("POST", url)

    def _answer(self, method: str, url: str) -> Replayed:
        key = f"{method.upper()} {url}"
        matches = self._recording.by_key.get(key)
        if not matches:
            raise RecordingMissing(
                f"no recorded answer for {key}\n"
                f"  recorded: {sorted(self._recording.by_key)}"
            )
        index = self._cursor.get(key, 0)
        if index >= len(matches):
            # Walking off the end means the code under test asked more times
            # than the recording covers — re-record rather than let it repeat
            # the last answer, which would loop forever on a poll.
            raise RecordingMissing(
                f"{key} was recorded {len(matches)} time(s) and asked for "
                f"{index + 1}; re-record this case"
            )
        self._cursor[key] = index + 1
        exchange = matches[index]
        if exchange.truncated:
            raise RecordingMissing(
                f"{key} was truncated at {len(self._recording.body(exchange)):,} of "
                f"{exchange.bytes:,} bytes; replaying it would look like a parse bug"
            )
        return Replayed(
            exchange.status, exchange.response_headers,
            self._recording.body(exchange), url,
        )


@dataclass
class Recording:
    """One captured search: its exchanges, and what they should parse to."""

    directory: Path
    source: str
    query: Dict[str, Any]
    exchanges: List[Exchange]
    expect: Dict[str, Any] = field(default_factory=dict)
    recorded_at: str = ""

    @property
    def by_key(self) -> Dict[str, List[Exchange]]:
        grouped: Dict[str, List[Exchange]] = {}
        for exchange in self.exchanges:
            grouped.setdefault(exchange.key, []).append(exchange)
        return grouped

    def body(self, exchange: Exchange) -> bytes:
        return (self.directory / exchange.body_file).read_bytes()

    def search_query(self) -> SearchQuery:
        data = dict(self.query)
        return SearchQuery(
            origin=data["origin"], destination=data["destination"],
            depart=_as_date(data["depart"]),
            ret=_as_date(data["ret"]) if data.get("ret") else None,
            adults=data.get("adults", 1), children=data.get("children", 0),
            infants=data.get("infants", 0), cabin=data.get("cabin", "economy"),
            currency=data.get("currency", "EUR"),
        )

    @classmethod
    def load(cls, directory: Path) -> "Recording":
        data = json.loads((directory / INDEX).read_text(encoding="utf-8"))
        return cls(
            directory=directory, source=data["source"], query=data["query"],
            exchanges=[Exchange.from_dict(e) for e in data["exchanges"]],
            expect=data.get("expect") or {}, recorded_at=data.get("recorded_at", ""),
        )

    def save(self) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        (self.directory / INDEX).write_text(
            json.dumps({
                "source": self.source,
                "recorded_at": self.recorded_at,
                "query": self.query,
                "expect": self.expect,
                "exchanges": [e.to_dict() for e in self.exchanges],
            }, indent=2) + "\n",
            encoding="utf-8",
        )


def _as_date(value: str):
    from datetime import date
    return date.fromisoformat(value)


def _query_dict(query: SearchQuery) -> Dict[str, Any]:
    return {
        "origin": query.origin, "destination": query.destination,
        "depart": query.depart.isoformat(),
        "ret": query.ret.isoformat() if query.ret else None,
        "adults": query.adults, "children": query.children, "infants": query.infants,
        "cabin": query.cabin, "currency": query.currency,
    }


# -- the two modes ---------------------------------------------------------


@contextmanager
def _sessions_from(build) -> Iterator[None]:
    """Point every `Source.session()` at something else for the duration."""
    original = Source.session
    Source.session = build          # type: ignore[assignment]
    try:
        yield
    finally:
        Source.session = original   # type: ignore[assignment]


def record(source_name: str, query: SearchQuery, directory: Path,
           cap: int = MAX_BODY) -> Recording:
    """Run one source for real, and write down every exchange it makes."""
    directory.mkdir(parents=True, exist_ok=True)
    source = REGISTRY[source_name]()
    holder: Dict[str, RecordingSession] = {}
    # Held before the patch goes on, or `build` would find itself.
    real_session = Source.session

    def build(self, impersonate: str = "chrome"):
        session = RecordingSession(real_session(self, impersonate), directory, cap)
        holder["session"] = session
        return session

    # A search that *fails* is the one worth keeping most of all — a 404 from a
    # poll, a challenge page, markup that no longer parses. Letting the
    # exception escape before saving would throw away the exact bytes this
    # whole module exists to preserve, so the outcome is recorded either way
    # and the caller is told what happened afterwards.
    offers: List[Offer] = []
    error = ""
    try:
        with _sessions_from(build):
            offers = source.search(query)
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"

    session = holder.get("session")
    expect: Dict[str, Any] = {
        "offers": len(offers), "digest": digest_offers(offers),
    }
    if error:
        expect["error"] = error

    recording = Recording(
        directory=directory, source=source_name, query=_query_dict(query),
        exchanges=session.exchanges if session else [],
        expect=expect,
        recorded_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
    )
    recording.save()
    return recording


def replay(recording: Recording) -> List[Offer]:
    """Run the source against the recording. No network, at all.

    A recording of a failed search replays as that same failure — the point of
    keeping one is to be able to run the parser at the bytes that broke it.
    """
    source = REGISTRY[recording.source]()
    player = PlayerSession(recording)

    def build(self, impersonate: str = "chrome"):
        return player

    with _sessions_from(build):
        return source.search(recording.search_query())


# -- trimming --------------------------------------------------------------

_MODAL_RE = re.compile(r"myModal(\d+)")


def trim_cffi_payload(body: bytes, keep: int = 3) -> bytes:
    """Cut a FlightsFinder poll body down to a few result cards.

    A full capture of one ff-sky search is 32 MB of near-identical payloads,
    which is not worth committing; three cards exercise every branch of the
    parser. The card and its modal are joined by position — the parser reads
    ``myModalN`` for the Nth ``.list-item`` — so the ids are renumbered to keep
    that promise after the ones in between are dropped.
    """
    text = body.decode("utf-8", errors="replace")
    parts = text.split("|")
    if len(parts) <= 6:
        return body

    tree = lxml_html.fromstring(f"<div>{parts[6]}</div>")
    cards = tree.cssselect("div.list-item")
    modals = {node.get("id"): node for node in tree.cssselect("div.modal") if node.get("id")}

    kept: List[str] = []
    for new_index, (old_index, card) in enumerate(list(enumerate(cards))[:keep]):
        modal = modals.get(f"myModal{old_index}")
        chunk = lxml_html.tostring(card, encoding="unicode")
        if modal is not None:
            chunk += lxml_html.tostring(modal, encoding="unicode")
        # Every reference moves together: the modal's own id, and the card's
        # data-target / href pointing at it.
        kept.append(_MODAL_RE.sub(f"myModal{new_index}", chunk))

    parts[6] = "".join(kept)
    if len(parts) > 1 and parts[1].strip().isdigit():
        parts[1] = str(min(int(parts[1]), len(kept)))
    return "|".join(parts).encode()


def trim_recording(recording: Recording, keep: int = 3) -> int:
    """Trim every oversized body in place, and re-state what it parses to."""
    trimmed = 0
    for exchange in recording.exchanges:
        path = recording.directory / exchange.body_file
        body = path.read_bytes()
        if len(body) < 200_000:
            continue                       # the search page is small; leave it
        smaller = trim_cffi_payload(body, keep)
        if len(smaller) < len(body):
            path.write_bytes(smaller)
            exchange.bytes = len(smaller)
            exchange.truncated = False     # cut deliberately, and still valid
            trimmed += 1

    try:
        offers = replay(recording)
        recording.expect = {"offers": len(offers), "digest": digest_offers(offers)}
    except Exception as exc:
        # Trimming a recording of a failure is still useful; what it should
        # reproduce is the failure.
        recording.expect = {
            "offers": 0, "digest": digest_offers([]),
            "error": f"{type(exc).__name__}: {exc}",
        }
    recording.save()
    return trimmed

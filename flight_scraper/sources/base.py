"""What every source has to provide, and the bits they all need.

A source is anything that can turn a :class:`SearchQuery` into a list of
:class:`Offer`. Most of them are a polling HTTP API behind a search page, so
the shared session helper below covers the common ground: browser-shaped TLS
and headers via curl_cffi, plus a decode that does not mangle currency symbols.
"""

from __future__ import annotations

import random
import math
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from curl_cffi import requests

from .. import errorlog
from ..challenge import STORE as CHALLENGE_STORE
from ..models import Offer, SearchQuery
from ..task_queue import PermanentError, RateLimited, RetryableError, current_context

# Cabin names differ per source; this is the vocabulary they map from.
CABIN_ALIASES = {
    "economy": "economy",
    "premiumeconomy": "premiumeconomy",
    "business": "business",
    "first": "first",
}


class SourceError(PermanentError):
    """A source could not answer. Never fatal: the others still run."""


class ChallengeRequired(SourceError):
    """The source wants a person to prove they are one, and said where.

    Distinct from an ordinary failure because the response is different:
    retrying is not just useless but actively harmful — it is more unattended
    traffic aimed at a host that has just asked for a human. The run stops
    asking this source and surfaces the URL instead.
    """

    def __init__(self, url: str, source: str = ""):
        super().__init__(
            f"{source or 'source'} needs a human to clear a challenge: {url}"
        )
        self.url = url
        self.source = source


ProgressHook = Callable[[str, Dict[str, Any]], None]


def _noop(event: str, data: Dict[str, Any]) -> None:
    pass


@dataclass
class SourceResult:
    """Outcome of asking one source for one query."""

    source: str
    offers: List[Offer] = field(default_factory=list)
    error: str = ""
    elapsed: float = 0.0
    url: str = ""
    #: What this source found, even when ``offers`` is empty because it was not
    #: asked. A skipped source still contributed its stored offers to the run,
    #: so counting only what came back over the wire would report zero for a
    #: search that in fact has hundreds of results.
    found: Optional[int] = None

    @property
    def ok(self) -> bool:
        return not self.error

    @property
    def count(self) -> int:
        """How many offers this source stands for, fetched or skipped."""
        return len(self.offers) if self.found is None else self.found


class Source:
    """Base class for a flight source.

    Subclasses implement :meth:`search`. :meth:`run` wraps it so a failing
    source reports an error instead of taking the whole scrape down with it.
    """

    name: str = "base"
    label: str = "Base"
    #: Currency the source quotes in regardless of what you ask for, if any.
    fixed_currency: Optional[str] = None

    #: How many searches of this source may be in flight at once, and the
    #: minimum gap between starting them. Searching many dates at once is the
    #: whole point of the aggregator, but every one of these hosts will take a
    #: burst personally, so each declares what it tolerates rather than being
    #: governed by one global guess.
    max_concurrency: int = 2
    min_interval: float = 0.5

    #: Wall-clock budget for a complete queue attempt, including every poll.
    job_timeout: float = 180.0
    challenge_statuses: tuple = ()

    def __init__(self, timeout: int = 60, retries: int = 2, on_progress: ProgressHook = _noop):
        self.timeout = timeout
        self.retries = max(1, retries)
        self.on_progress = on_progress

    # -- to implement ------------------------------------------------------

    def search(self, query: SearchQuery) -> List[Offer]:
        raise NotImplementedError

    def search_url(self, query: SearchQuery) -> str:
        """The human-visitable page for this search, for the UI to link to."""
        return ""

    # -- plumbing ----------------------------------------------------------

    def currency_for(self, query: SearchQuery) -> str:
        return self.fixed_currency or query.currency

    def run(self, query: SearchQuery) -> SourceResult:
        started = time.monotonic()
        result = SourceResult(source=self.name)
        last_error = ""

        try:
            result.url = self.search_url(query)
        except Exception as exc:
            # A source may refuse a query it cannot express faithfully rather
            # than answer it with the wrong cabin or passenger count.
            result.error = f"{type(exc).__name__}: {exc}"
            result.elapsed = time.monotonic() - started
            return result

        for attempt in range(1, self.retries + 1):
            try:
                result.offers = self.search(query)
                last_error = ""
                break
            except ChallengeRequired:
                raise           # the caller decides; retrying only digs the hole
            except (PermanentError, RateLimited) as exc:
                last_error = f"{type(exc).__name__}: {exc}"
                break
            except Exception as exc:
                last_error = f"{type(exc).__name__}: {exc}"
                self.on_progress(
                    "source_retry",
                    {"source": self.name, "attempt": attempt, "error": last_error},
                )
                if attempt < self.retries:
                    # Jittered, because the failures that matter are the
                    # correlated ones. A dropped network or a throttled IP
                    # fails every source at once, and a fixed backoff has them
                    # all come back at the same instant to fail together
                    # again. The random factor spreads a retry across
                    # 0.5x–1.5x of its slot, which is enough to decorrelate
                    # six sources without lengthening the wait on average.
                    time.sleep(1.5 * attempt * (0.5 + random.random()))

        if last_error:
            # Written down with the question that produced it: the same message
            # means different things on different routes, dates and parties,
            # and by the time anyone reads this the query is long gone.
            errorlog.record(
                f"source.{self.name}", last_error,
                route=f"{query.origin}-{query.destination}",
                depart=query.depart, ret=query.ret,
                adults=query.adults, children=query.children,
                infants=query.infants, cabin=query.cabin,
                currency=query.currency, attempts=self.retries,
                url=result.url, replay=(
                    f"flight-scraper capture {self.name} {query.origin} "
                    f"{query.destination} {query.depart}"
                    + (f" --ret {query.ret}" if query.ret else "")
                    + " --out tests/recordings/<name>"
                ),
            )
        result.error = last_error
        result.elapsed = time.monotonic() - started
        return result

    def run_once(self, query: SearchQuery) -> SourceResult:
        """One queue attempt. Retry scheduling belongs to the queue, without sleeps."""
        started = time.monotonic()
        try:
            url = self.search_url(query)
            offers = self.search(query)
        except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as exc:
            raise RetryableError(str(exc)) from exc
        return SourceResult(source=self.name, url=url, offers=offers,
                            elapsed=time.monotonic() - started)

    def request(self, session, method: str, url: str, **kwargs):
        """Apply the attempt's remaining budget and classify HTTP failures once."""
        context = current_context()
        if context:
            kwargs["timeout"] = min(kwargs.get("timeout") or self.timeout, context.remaining())
        response = getattr(session, method)(url, **kwargs)
        status = response.status_code
        if status == 429 or (status == 503 and getattr(response, "headers", {}).get("Retry-After")):
            raw = getattr(response, "headers", {}).get("Retry-After", "60")
            try:
                delay = float(raw)
            except (ValueError, TypeError):
                try:
                    when = parsedate_to_datetime(raw)
                    if when.tzinfo is None:
                        when = when.replace(tzinfo=timezone.utc)
                    delay = max(0, (when - datetime.now(timezone.utc)).total_seconds())
                except (ValueError, TypeError, OverflowError):
                    delay = 60
            if not math.isfinite(delay) or delay < 0:
                delay = 60
            raise RateLimited(delay)
        if context:
            context.check()
        if status >= 500 or status == 408:
            raise RetryableError(f"HTTP {status}: {url}")
        # Kayak's 403 carries the actual human challenge URL; let its adapter read it.
        if status >= 400 and status not in self.challenge_statuses:
            raise SourceError(f"HTTP {status}: {url}")
        return response

    @staticmethod
    def pause(seconds: float) -> None:
        context = current_context()
        if context:
            context.sleep(seconds)
        else:
            time.sleep(seconds)

    # -- HTTP helpers ------------------------------------------------------

    def session(self, impersonate: str = "chrome") -> requests.Session:
        """A browser-shaped session, carrying any challenge this source has cleared."""
        session = requests.Session(impersonate=impersonate)
        for name, value in CHALLENGE_STORE.load(self.name).items():
            session.cookies.set(name, value)
        return session

    @staticmethod
    def text_of(response) -> str:
        """Decode a response as UTF-8 regardless of a missing charset header.

        Several of these sites serve UTF-8 without declaring it, which turns
        every ``€`` into a replacement character if you trust the header.
        """
        raw = response.content
        if isinstance(raw, (bytes, bytearray)):
            return raw.decode("utf-8", errors="replace")
        return response.text

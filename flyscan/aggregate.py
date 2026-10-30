"""Run every source across every date at once, and merge what they find.

Sources are independent and almost entirely I/O-bound — they sit waiting on a
poll far longer than they compute — so the unit of work is one *(source, date)*
pair, not one date. Six sources over fourteen days is 84 independent jobs, and
running them date-by-date would idle every fast source until the slowest one on
that date finished.

The pacing is not this module's business. Every job goes to the process-wide
:class:`~flyscan.scheduler.Scheduler`, which owns the per-source gates,
the worker pool and the store — so two searches running at once share one set
of rate limits instead of each inventing its own, and two callers asking the
same question at the same moment share one scrape.

Merging happens on :attr:`Itinerary.trip_key`, so the same flight found by
every source becomes one itinerary carrying one offer each. That is where the
real value is: the spread between what those sellers want for an identical seat.
"""

from __future__ import annotations

import threading
import uuid
from concurrent.futures import as_completed
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any, Callable, Dict, Iterator, List, Optional, Sequence, Tuple

from . import fx
from .models import Offer, SearchQuery, daterange
from .scheduler import DEFAULT_MAX_WORKERS, Scheduler, default_scheduler
from .sources import DEFAULT_SOURCES, Source, SourceResult, build

ProgressHook = Callable[[str, Dict[str, Any]], None]

#: A departure date and, for a round trip, the return it is being priced
#: against. The unit of work: one trip asked of one source.
Trip = Tuple[date, Optional[date]]


def _noop(event: str, data: Dict[str, Any]) -> None:
    pass


@dataclass
class MergedItinerary:
    """One flight and every offer found for it, cheapest first."""

    trip_key: str
    offers: List[Offer] = field(default_factory=list)

    @property
    def best(self) -> Offer:
        return self.offers[0]

    @property
    def sources(self) -> List[str]:
        seen, out = set(), []
        for offer in self.offers:
            if offer.source not in seen:
                seen.add(offer.source)
                out.append(offer.source)
        return out

    @property
    def spread(self) -> Optional[float]:
        """Gap between the cheapest and dearest quote, in the base currency."""
        priced = [o.price_eur for o in self.offers if o.price_eur is not None]
        return round(max(priced) - min(priced), 2) if len(priced) > 1 else None


@dataclass
class DayResult:
    """Everything found for one departure date, across every source."""

    query: SearchQuery
    results: List[SourceResult] = field(default_factory=list)
    merged: List[MergedItinerary] = field(default_factory=list)
    elapsed: float = 0.0

    @property
    def offers(self) -> List[Offer]:
        return [offer for result in self.results for offer in result.offers]

    @property
    def found(self) -> int:
        """Offers this date stands for, including sources that were skipped."""
        return sum(result.count for result in self.results)

    @property
    def skipped(self) -> bool:
        """True when a source was not asked because the ledger said so."""
        return any(r.found is not None for r in self.results)

    @property
    def errors(self) -> Dict[str, str]:
        return {r.source: r.error for r in self.results if r.error}

    @property
    def cheapest(self) -> Optional[Offer]:
        return self.merged[0].best if self.merged else None

    @property
    def day(self) -> date:
        return self.query.depart


def merge(offers: Sequence[Offer], base_currency: str = "EUR") -> List[MergedItinerary]:
    """Group offers by flight and sort everything by converted price.

    Offers whose currency has no rate available sort last rather than being
    dropped: an unconvertible price is still a real price someone can click.
    """
    rates = fx.get_rates(base_currency)
    grouped: Dict[str, MergedItinerary] = {}

    for offer in offers:
        if offer.price_eur is None:
            offer.price_eur = rates.convert(offer.price, offer.currency)
        grouped.setdefault(offer.trip_key, MergedItinerary(offer.trip_key)).offers.append(offer)

    unpriced = float("inf")
    for item in grouped.values():
        item.offers.sort(key=lambda o: o.price_eur if o.price_eur is not None else unpriced)

    return sorted(
        grouped.values(),
        key=lambda m: m.best.price_eur if m.best.price_eur is not None else unpriced,
    )


class Aggregator:
    """Fans a search out across every source and date, and merges the answers."""

    def __init__(
        self,
        sources: Optional[Sequence[str]] = None,
        base_currency: str = "EUR",  # what offers are converted to; always EUR
        timeout: int = 60,
        retries: int = 2,
        max_workers: int = DEFAULT_MAX_WORKERS,
        db_path: Optional[str] = "flights.db",
        ttl: Optional[timedelta] = None,
        scheduler: Optional[Scheduler] = None,
        refresh: bool = False,
        on_progress: ProgressHook = _noop,
        owner: str = "",
    ):
        self.source_names = list(sources or DEFAULT_SOURCES)
        self.base_currency = base_currency.upper()
        self.timeout = timeout
        self.retries = retries
        self.ttl = ttl
        self.on_progress = on_progress
        #: Identifies this search's jobs in the queue, so they can be promoted
        #: or dropped together.
        self.owner = owner or uuid.uuid4().hex
        #: Ask the sources again even if the ledger says they answered recently.
        self.refresh = refresh
        self._cancelled = threading.Event()
        # The scheduler is shared on purpose: its gates are the rate limits, and
        # a second set of them would simply be a second allowance.
        self.scheduler = scheduler or default_scheduler(
            max_workers=max_workers,
            db_path=db_path,
        )

    @property
    def store(self):
        """The scheduler's store — also the ledger of what has been asked."""
        return self.scheduler.store

    def stored_offers(self, query):
        return self.scheduler.stored_offers(query)

    def _sources(self) -> List[Source]:
        return build(
            self.source_names,
            timeout=self.timeout,
            retries=self.retries,
            on_progress=self.on_progress,
        )

    def cancel(self) -> None:
        self._cancelled.set()
        # Anything still waiting is dropped outright rather than left to reach
        # the front of the queue only to find it was cancelled. What is already
        # running is left to finish: it has cost what it costs, and its answer
        # is seconds from the database, where it counts for whoever asks next.
        if self.owner:
            self.scheduler.cancel_owner(self.owner)

    def close(self) -> None:
        """Release this search's subscriptions; the shared scheduler stays alive."""
        self.cancel()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    # -- a range of dates --------------------------------------------------

    def search_range(self, query: SearchQuery, end: date) -> Iterator[DayResult]:
        """Yield a :class:`DayResult` per departure date, in date order.

        A range of departures with the trip length held fixed: a return, if
        there is one, slides along with the outbound. :meth:`search_trips` is
        the general form, where the two dates vary independently.
        """
        return self.search_trips(
            query,
            [
                (day, (day + (query.ret - query.depart)) if query.ret else None)
                for day in daterange(query.depart, end)
            ],
        )

    def search_trips(self, query: SearchQuery, trips: Sequence[Trip]) -> Iterator[DayResult]:
        """Own all subscriptions until exhaustion, cancellation, or iterator close."""
        try:
            yield from self._search_trips(query, trips)
        finally:
            self.scheduler.cancel_owner(self.owner)

    def _search_trips(self, query: SearchQuery, trips: Sequence[Trip]) -> Iterator[DayResult]:
        """Yield a :class:`DayResult` per trip, in the order given.

        Every (source, trip) pair is handed to the scheduler up front, so a
        fast source is never left waiting on a slow one from an earlier trip.
        Trips are still handed back in order, so output stays readable — a
        finished later one waits its turn rather than holding anything up.

        A "trip" is a departure date and, for a round trip, the return date it
        is being priced against. The two are independent: searching three
        departures against two returns is six separate questions to every
        source, not three.
        """
        sources = self._sources()
        self.on_progress(
            "start",
            {
                "days": len(trips),
                "sources": [s.name for s in sources],
                "jobs": len(trips) * len(sources),
            },
        )

        queries = {trip: query.replace_trip(*trip) for trip in trips}
        started = {trip: datetime.now() for trip in trips}
        collected: Dict[Trip, List[SourceResult]] = {trip: [] for trip in trips}
        remaining = {trip: len(sources) for trip in trips}
        next_day = 0

        futures = {}
        for trip in trips:
            for source in sources:
                if self._cancelled.is_set():
                    return
                future = self.scheduler.submit(
                    source,
                    queries[trip],
                    self.on_progress,
                    self._cancelled,
                    self.refresh,
                    owner=self.owner,
                    ttl=self.ttl,
                )
                futures[future] = (trip, source)
                if self._cancelled.is_set():
                    return
        # Submitted last, so wanted first: this is the search someone is
        # looking at, and whatever was queued before it can wait.
        if self.owner:
            self.scheduler.focus(self.owner)

        for trip in trips:
            self.on_progress(
                "day_start",
                {
                    "day": trip[0],
                    "ret": trip[1],
                    "sources": [s.name for s in sources],
                    "query": queries[trip].label(),
                },
            )

        for future in as_completed(futures):
            trip, source = futures[future]
            try:
                result = future.result()
            except Exception as exc:  # a job must never take the run down
                result = SourceResult(source=source.name, error=f"{type(exc).__name__}: {exc}")
            collected[trip].append(result)
            remaining[trip] -= 1

            # Re-merge and publish straight away rather than waiting for the
            # day. One slow source should not hold back five fast ones: the
            # cheapest flights are usually visible from the first result set,
            # and a partial answer now beats a complete one in a minute.
            if result.offers:
                self.on_progress(
                    "day_partial",
                    {
                        "day": trip[0],
                        "ret": trip[1],
                        "merged": merge(
                            [o for r in collected[trip] for o in r.offers],
                            self.base_currency,
                        ),
                        "sources_done": len(collected[trip]),
                        "sources_total": len(sources),
                        "offers": sum(len(r.offers) for r in collected[trip]),
                    },
                )

            # Release finished trips in order, so output stays readable.
            while next_day < len(trips) and remaining[trips[next_day]] == 0:
                ready = trips[next_day]
                next_day += 1
                yield self._finish_day(queries[ready], collected[ready], started[ready])

        self.on_progress("finish", {"days": len(trips), "cancelled": self._cancelled.is_set()})

    def _finish_day(
        self, query: SearchQuery, results: List[SourceResult], started: datetime
    ) -> DayResult:
        day = DayResult(query=query, results=sorted(results, key=lambda r: r.source))
        day.merged = merge(day.offers, self.base_currency)
        day.elapsed = (datetime.now() - started).total_seconds()
        self.on_progress(
            "day_done",
            {
                "day": query.depart,
                "offers": day.found,
                # None when a source was served from the ledger: its offers are
                # in the database, not in hand, so there is nothing here to
                # merge and any count would be a guess.
                "itineraries": None if day.skipped else len(day.merged),
                "errors": day.errors,
                "elapsed": day.elapsed,
            },
        )
        return day

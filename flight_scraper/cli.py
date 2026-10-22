"""Command line interface."""

from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import fx
from .aggregate import (
    DEFAULT_MAX_WORKERS,
    Aggregator,
    DayResult,
    MergedItinerary,
    merge,
)
from .challenge import (
    STORE as CHALLENGE_STORE,
)
from .models import CABIN_CLASSES, SearchQuery, pretty_duration
from .models import parse_date as _parse_date
from .places import PlaceLookupError, resolve, search_places
from .sources import DEFAULT_SOURCES, REGISTRY
from .store import (
    DEFAULT_TTL,
    FlightStore,
    default_output_stem,
    offer_to_row,
    write_csv,
    write_json,
)

OUT_DIR = Path("out")


def parse_date(value: str) -> date:
    """argparse adapter around :func:`flight_scraper.models.parse_date`."""
    try:
        return _parse_date(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from exc


def _configure_console(verbose: bool) -> None:
    """Windows consoles default to a code page that cannot print ``€``."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure:
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except (ValueError, OSError):
                pass
    level = logging.DEBUG if verbose else logging.WARNING
    for noisy in ("scrapling", "curl_cffi", "urllib3"):
        logging.getLogger(noisy).setLevel(level)


# -- reporting -------------------------------------------------------------


def _make_reporter(quiet: bool, base_currency: str):
    """Progress printer for a run where every date is in flight at once.

    Lines arrive interleaved across dates, so each one names its date rather
    than sitting under a heading that may be several dates old by now.
    """
    def report(event: str, data: Dict[str, Any]) -> None:
        if quiet:
            return
        if event == "start":
            print(
                f"Sources: {', '.join(data['sources'])}\n"
                f"{data['jobs']} searches across {data['days']} day(s)\n",
                flush=True,
            )
        elif event == "source_done":
            day = data.get("day", "")
            if data["error"]:
                print(f"  {day}  {data['source']:<12} FAILED  {data['error'][:80]}", flush=True)
            elif data.get("origin") in ("cache", "shared"):
                age = data.get("age_hours")
                note = (
                    f"cached, {age:.1f}h old" if data["origin"] == "cache" and age is not None
                    else "cached" if data["origin"] == "cache"
                    else "shared with another search"
                )
                print(f"  {day}  {data['source']:<12} {data['count']:>4} offers  ({note})",
                      flush=True)
            else:
                print(
                    f"  {day}  {data['source']:<12} {data['count']:>4} offers "
                    f"in {data['elapsed']:.0f}s",
                    flush=True,
                )
        elif event == "challenge_required":
            print("", flush=True)
            print(f"  {data['source']} wants a human to confirm you are one:", flush=True)
            print(f"    {data['url']}", flush=True)
            print(
                f"    open it, or run:  flight-scraper unblock {data['source']}\n",
                flush=True,
            )
        elif event == "day_done":
            flights = data.get("itineraries")
            across = f"across {flights} distinct flights " if flights is not None else ""
            print(
                f"  {data['day']}  -> {data['offers']} offers {across}"
                f"in {data['elapsed']:.0f}s",
                flush=True,
            )
    return report


def _print_table(merged: List[MergedItinerary], base_currency: str, limit: int) -> None:
    if not merged:
        print("  no flights found")
        return

    symbol = fx.SYMBOLS.get(base_currency, base_currency)
    header = (
        f"  {'price':>10}  {'route':<9} {'depart':<16} {'dur':>7} {'stp':>3}  "
        f"{'airlines':<26} {'best source':<12} {'srcs':>4} {'spread':>8}"
    )
    print(header)
    print("  " + "-" * (len(header) - 2))

    for item in merged[:limit]:
        best = item.best
        leg = best.itinerary.outbound
        price = f"{symbol}{best.price_eur:,.2f}" if best.price_eur is not None else "n/a"
        native = "" if (best.currency == base_currency) else f" ({best.price:,.0f} {best.currency})"
        spread = f"{item.spread:,.0f}" if item.spread is not None else "-"
        print(
            f"  {price:>10}  {leg.origin_airport}-{leg.destination_airport:<5} "
            f"{leg.departure[:16]:<16} {pretty_duration(leg.duration_minutes):>7} "
            f"{leg.stops if leg.stops is not None else '?':>3}  "
            f"{(leg.airlines or '')[:26]:<26} {best.source:<12} "
            f"{len(item.sources):>4} {spread:>8}{native}"
        )


# -- commands --------------------------------------------------------------


def cmd_places(args: argparse.Namespace) -> int:
    _configure_console(False)
    try:
        matches = search_places(args.query)
    except PlaceLookupError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    if not matches:
        print("no matches")
        return 1
    for place in matches:
        print(f"  {place.code:<5} {place.kind:<8} {place.name} — {place.country}")
    return 0


def cmd_sources(args: argparse.Namespace) -> int:
    _configure_console(False)
    print(f"  {'name':<12} {'label':<24} currency")
    print("  " + "-" * 50)
    for name, cls in REGISTRY.items():
        currency = cls.fixed_currency or "as requested"
        print(f"  {name:<12} {cls.label:<24} {currency}")
    return 0


def cmd_scrape(args: argparse.Namespace) -> int:
    _configure_console(args.verbose)

    try:
        origin = resolve(args.origin, prefer=args.prefer)
        destination = resolve(args.destination, prefer=args.prefer)
    except PlaceLookupError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    if not args.quiet:
        print(f"\n  {origin}  ->  {destination}\n")

    try:
        query = SearchQuery(
            origin=origin.code,
            destination=destination.code,
            depart=args.start,
            ret=args.ret,
            adults=args.adults,
            children=args.children,
            infants=args.infants,
            cabin=args.cabin,
            currency=args.currency,
        )
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    sources = list(args.sources or DEFAULT_SOURCES)
    store = FlightStore(args.db) if args.db else None

    # The ledger only says "do not ask this source again yet" — the answer it is
    # standing in for lives in the database. With no database there is nowhere to
    # read it back from, so skipping a source would silently drop it from the
    # output. No storage, no cache.
    cache_hours = args.cache_hours if store else 0
    if store is None and args.cache_hours and not args.quiet:
        print("  --db '' skips storage, so nothing is cached: every source is asked")

    aggregator = Aggregator(
        sources=sources,
        base_currency=args.base_currency,
        timeout=args.timeout,
        retries=args.retries,
        max_workers=args.workers,
        db_path=args.db or None,
        ttl=timedelta(hours=cache_hours),
        on_progress=_make_reporter(args.quiet, args.base_currency),
    )
    days: List[DayResult] = []
    #: (day, every stored offer for it, merged) — complete, cache hits included.
    collected: List[tuple] = []
    errors = 0

    try:
        for day in aggregator.search_range(query, args.end or args.start):
            days.append(day)
            errors += len(day.errors)
            # A source served from the ledger returns nothing; its offers are
            # already stored. Read the day back once this run's own findings are
            # saved, so the output is whole either way.
            # The scheduler already wrote this run's findings as it went; a
            # skipped source wrote its own the first time. Read the day back to
            # get both.
            if store:
                day_offers = store.offers_for_search(day.query)
                day_merged = merge(day_offers, args.base_currency)
            else:
                day_offers, day_merged = day.offers, day.merged
            collected.append((day, day_offers, day_merged))
            # A single-date search prints its table; a range prints the
            # per-date summary at the end instead of one table per day.
            if not args.quiet and args.end is None:
                _print_table(day_merged, args.base_currency, args.top)
                print()
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)
        aggregator.cancel()

    all_offers = [o for _, offers, _ in collected for o in offers]
    if not all_offers:
        print("no offers found", file=sys.stderr)
        if store:
            store.close()
        aggregator.close()
        return 1

    if args.end and not args.quiet:
        print("\nCheapest per departure date:")
        for day, _, day_merged in collected:
            best = day_merged[0].best if day_merged else None
            if best is None:
                print(f"  {day.day}  no flights")
                continue
            leg = best.itinerary.outbound
            symbol = fx.SYMBOLS.get(args.base_currency, "")
            print(
                f"  {day.day}  {symbol}{best.price_eur:>9,.2f}  {best.source:<12} "
                f"{leg.origin_airport}-{leg.destination_airport} {leg.airlines[:30]}"
            )

    rows = [offer_to_row(o, args.base_currency) for o in all_offers]
    rows.sort(key=lambda r: (r["depart_date"], r["price_base"] or float("inf")))

    stem = args.output or default_output_stem(query.origin, query.destination)
    csv_path = write_csv(rows, OUT_DIR / f"{stem}.csv")
    json_path = write_json(rows, OUT_DIR / f"{stem}.json")

    counts = aggregator.scheduler.stats
    if counts["cached"] and not args.quiet:
        asked = counts["cached"] + counts["scraped"]
        print("")
        print(
            f"  {counts['cached']} of {asked} source searches skipped "
            f"(answered within {args.cache_hours}h)"
        )

    if store:
        store.close()
    aggregator.close()

    if not args.quiet:
        print(f"\n  wrote {csv_path} and {json_path}")
        if errors:
            print(f"  {errors} source failure(s) — see the log above")
    return 0


def cmd_query(args: argparse.Namespace) -> int:
    _configure_console(False)
    store = FlightStore(args.db)
    try:
        stored_base = store.stored_base()
        if args.summary:
            print(f"  prices in {stored_base}, as stored")
            print(f"  {'source':<12} {'offers':>7} {'flights':>8} {'cheapest':>10} {'average':>10}")
            print("  " + "-" * 52)
            for row in store.source_summary():
                print(
                    f"  {row['source']:<12} {row['offers']:>7} {row['itineraries']:>8} "
                    f"{row['cheapest']:>10,.2f} {row['average']:>10,.2f}"
                )
            print(f"\n  totals: {store.stats()}")
            return 0

        rows = store.cheapest(
            origin=args.origin,
            destination=args.destination,
            depart_from=args.start.isoformat() if args.start else None,
            depart_to=args.end.isoformat() if args.end else None,
            max_stops=args.max_stops,
            sources=args.sources,
            limit=args.top,
        )
        if not rows:
            print("  nothing stored for that filter")
            return 1
        rows = store.display_in(rows, args.base_currency)
        symbol = fx.SYMBOLS.get(args.base_currency, "")
        if stored_base != args.base_currency:
            print(f"  converted from {stored_base} at today's rate")
        print(f"  {'price':>10}  {'date':<11} {'route':<9} {'depart':<16} {'stp':>3}  "
              f"{'airlines':<26} source")
        print("  " + "-" * 88)
        for row in rows:
            print(
                f"  {symbol}{row['price_base']:>9,.2f}  {row['depart_date']:<11} "
                f"{row['origin_airport']}-{row['destination_airport']:<5} "
                f"{(row['departure'] or '')[:16]:<16} "
                f"{row['stops'] if row['stops'] is not None else '?':>3}  "
                f"{(row['airlines'] or '')[:26]:<26} {row['source']}"
            )
        return 0
    finally:
        store.close()


def cmd_prune(args: argparse.Namespace) -> int:
    """Forget flights that have already departed."""
    _configure_console(False)
    store = FlightStore(args.db)
    try:
        removed = store.purge_past(args.before)
        left = store.stats()
    finally:
        store.close()

    print(f"  dropped {removed['fetches']} fetch(es) and {removed['trips']} trip(s)")
    print(f"  left: {left['fetches']} fetches, {left['trips']} trips, {left['offers']} offers")
    return 0


def cmd_unblock(args: argparse.Namespace) -> int:
    """Open a source's challenge for the person sitting here to clear."""
    _configure_console(False)

    if args.status:
        rows = CHALLENGE_STORE.status()
        if not rows:
            print("  no challenges have been cleared")
            return 0
        print(f"  {'source':<12} {'cookies':>8} {'age':>8}  cleared at")
        print("  " + "-" * 52)
        for row in rows:
            mark = "" if row["fresh"] else "  (stale)"
            print(f"  {row['source']:<12} {row['cookies']:>8} {row['age_hours']:>7.1f}h  "
                  f"{row['solved_at'][:16]}{mark}")
        return 0

    if args.forget:
        CHALLENGE_STORE.clear(args.source)
        print(f"  forgot the stored challenge for {args.source}")
        return 0

    from .challenge import ChallengeCoordinator
    print(f"  Checking {args.source}; a browser opens if a challenge is needed.")
    try:
        with ChallengeCoordinator.for_database(args.db, cookies=CHALLENGE_STORE) as recovery:
            report = recovery.recover(args.source, url=args.url, wait_seconds=args.wait)
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    if report["solved"]:
        if report.get("outcome") == "clear":
            print(f"  {args.source} is answering normally; nothing to solve.")
        else:
            print(f"  cleared; kept {report['cookies']} cookie(s). {args.source} is unblocked.")
        return 0
    print(f"  not cleared: {report.get('error', 'timed out waiting')}", file=sys.stderr)
    return 1


def cmd_cache(args: argparse.Namespace) -> int:
    """What has been asked of each source, and how it went."""
    _configure_console(False)
    store = FlightStore(args.db)
    try:
        rows = store.fetch_summary()
        if not rows:
            print("  nothing has been fetched yet")
            return 0
        print(f"  {args.db} — a source is asked again after {args.cache_hours}h")
        print()
        print(f"  {'source':<12} {'status':<11} {'searches':>9}  newest")
        print("  " + "-" * 50)
        for row in rows:
            print(f"  {row['source']:<12} {row['status']:<11} {row['n']:>9}  "
                  f"{(row['newest'] or '')[:16]}")
        return 0
    finally:
        store.close()


def cmd_rates(args: argparse.Namespace) -> int:
    _configure_console(False)
    table = fx.get_rates(args.base_currency, refresh=args.refresh)
    print(f"  base {table.base} via {table.provider or 'cache'}, fetched {table.fetched_at}")
    for code in sorted(table.rates):
        print(f"    1 {table.base} = {table.rates[code]:>12,.4f} {code}")
    return 0


def cmd_capture(args: argparse.Namespace) -> int:
    """Record one real search, so the bytes survive the next markup change.

    Run this when a source breaks, or when adding one: what it leaves behind
    is a fixture the parser can be tested against forever, without the site
    having to still be in the same mood.
    """
    from .capture import digest_offers, record, replay, trim_recording

    query = SearchQuery(
        origin=resolve(args.origin, prefer="city").code,
        destination=resolve(args.destination, prefer="city").code,
        depart=args.start,
        ret=args.ret,
        adults=args.adults, children=args.children, infants=args.infants,
        cabin=args.cabin, currency=args.currency,
    )
    directory = Path(args.out)
    print(f"recording {args.source} {query.label()} -> {directory}")

    recording = record(args.source, query, directory)
    total = sum(e.bytes for e in recording.exchanges)
    print(f"  {len(recording.exchanges)} exchanges, {total / 1e6:.1f} MB, "
          f"{recording.expect['offers']} offers")
    if recording.expect.get("error"):
        # Kept deliberately: a recording of the failure is the thing worth
        # having when a source breaks.
        print(f"  the search failed: {recording.expect['error']}")
        print("  recording kept anyway — replay it to work on the parser")

    if args.trim:
        trimmed = trim_recording(recording, keep=args.keep)
        after = sum((directory / e.body_file).stat().st_size for e in recording.exchanges)
        print(f"  trimmed {trimmed} bodies to {args.keep} cards each: "
              f"{after / 1e6:.1f} MB, {recording.expect['offers']} offers")

    offers = replay(recording)
    ok = (len(offers) == recording.expect["offers"]
          and digest_offers(offers) == recording.expect["digest"])
    print(f"  replays {'identically' if ok else 'DIFFERENTLY — do not commit this'}")
    return 0 if ok else 1


def cmd_errors(args: argparse.Namespace) -> int:
    """Read back what has gone wrong, for whoever is debugging it next."""
    from . import errorlog

    if args.clear:
        print(f"forgot {errorlog.clear()} entries")
        return 0

    if args.json:
        print(json.dumps(errorlog.recent(args.limit, args.where), indent=2, default=str))
        return 0

    rows = errorlog.summary()
    if not rows:
        print("nothing recorded")
        return 0

    print("what has been failing, commonest first:")

    for row in rows[:20]:
        print(f"  {row['count']:>4}x  {row['where']:<22} {row['kind']}: {row['message']}")
        print(f"        first {row['first']}   last {row['last']}")

    recent = errorlog.recent(args.limit, args.where)
    print()
    print(f"the last {len(recent)}:")

    for entry in recent:
        print(f"  {entry['at']}  {entry['where']}  {entry['kind']}: {entry['message']}")
        for key, value in (entry.get("context") or {}).items():
            if key == "replay":
                continue
            print(f"        {key}: {value}")
        if (entry.get("context") or {}).get("replay"):
            print(f"        replay it: {entry['context']['replay']}")
    return 0


# -- argument parsing ------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="flight-scraper",
        description="Scrape flight prices from six sources in parallel.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # scrape
    scrape = sub.add_parser("scrape", help="search a route across every source")
    scrape.add_argument("origin", help="place name or IATA code, e.g. berlin or BER")
    scrape.add_argument("destination", help="place name or IATA code")
    scrape.add_argument("start", type=parse_date, help="departure date (YYYY-MM-DD, today, +14)")
    scrape.add_argument("end", type=parse_date, nargs="?",
                        help="last departure date, to scan a range")
    scrape.add_argument("--return", dest="ret", type=parse_date, default=None,
                        help="return date, for a round trip")
    scrape.add_argument("--adults", type=int, default=1)
    scrape.add_argument("--children", type=int, default=0)
    scrape.add_argument("--infants", type=int, default=0,
                        help="infants on a lap, under 2")
    scrape.add_argument("--cabin", choices=CABIN_CLASSES, default="economy")
    scrape.add_argument("--currency", default="EUR",
                        help="currency to ask the sources for (default EUR)")
    scrape.add_argument("--base-currency", default="EUR",
                        help="currency the printed table and CSV are shown in "
                             "(the database always stores EUR)")
    scrape.add_argument("--sources", nargs="+", choices=list(REGISTRY),
                        help=f"limit to these sources (default: all {len(REGISTRY)})")
    scrape.add_argument("--prefer", choices=("city", "airport"), default="city")
    scrape.add_argument("--timeout", type=int, default=60)
    scrape.add_argument("--workers", type=int, default=DEFAULT_MAX_WORKERS,
                        help="ceiling on source searches in flight at once "
                             f"(default {DEFAULT_MAX_WORKERS}); each source also "
                             "throttles itself")
    scrape.add_argument("--cache-hours", type=float,
                        default=DEFAULT_TTL.total_seconds() / 3600,
                        help="reuse a source's answer to an identical search for "
                             "this long; 0 disables the cache")
    scrape.add_argument("--retries", type=int, default=2)
    scrape.add_argument("--top", type=int, default=25, help="rows to print")
    scrape.add_argument("--db", default="flights.db", help="SQLite file, or '' to skip storage")
    scrape.add_argument("--output", help="output file stem under out/")
    scrape.add_argument("-q", "--quiet", action="store_true")
    scrape.add_argument("-v", "--verbose", action="store_true")
    scrape.set_defaults(func=cmd_scrape)

    # query
    query = sub.add_parser("query", help="read back what has already been scraped")
    query.add_argument("--origin")
    query.add_argument("--destination")
    query.add_argument("--start", type=parse_date)
    query.add_argument("--end", type=parse_date)
    query.add_argument("--max-stops", type=int)
    query.add_argument("--sources", nargs="+", choices=list(REGISTRY))
    query.add_argument("--top", type=int, default=25)
    query.add_argument("--summary", action="store_true", help="per-source totals instead of rows")
    query.add_argument("--base-currency", default="EUR",
                       help="currency to display in; converted at today's rate "
                            "(the database always stores EUR)")
    query.add_argument("--db", default="flights.db")
    query.set_defaults(func=cmd_query)

    # places
    places = sub.add_parser("places", help="look up the IATA code for a place")
    places.add_argument("query")
    places.set_defaults(func=cmd_places)

    # capture
    capture = sub.add_parser(
        "capture",
        help="record one real search as a replayable fixture",
    )
    capture.add_argument("source", choices=list(REGISTRY))
    capture.add_argument("origin")
    capture.add_argument("destination")
    capture.add_argument("start", type=parse_date)
    capture.add_argument("--ret", type=parse_date, default=None)
    capture.add_argument("--out", required=True, help="directory to write the recording to")
    capture.add_argument("--adults", type=int, default=1)
    capture.add_argument("--children", type=int, default=0)
    capture.add_argument("--infants", type=int, default=0)
    capture.add_argument("--cabin", default="economy", choices=list(CABIN_CLASSES))
    capture.add_argument("--currency", default="EUR")
    capture.add_argument("--trim", action="store_true",
                         help="cut result payloads down to a few cards")
    capture.add_argument("--keep", type=int, default=3,
                         help="cards to keep when trimming (default 3)")
    capture.set_defaults(func=cmd_capture)

    # errors
    errors = sub.add_parser(
        "errors", help="what has gone wrong lately, and in what context"
    )
    errors.add_argument("--limit", type=int, default=10)
    errors.add_argument("--where", help="only this subsystem, e.g. source.ff-sky")
    errors.add_argument("--json", action="store_true", help="the entries, whole")
    errors.add_argument("--clear", action="store_true", help="forget everything recorded")
    errors.set_defaults(func=cmd_errors)

    # sources
    sources = sub.add_parser("sources", help="list the available sources")
    sources.set_defaults(func=cmd_sources)

    # rates
    rates = sub.add_parser("rates", help="show the exchange rates used for conversion")
    rates.add_argument("--base-currency", default="EUR")
    rates.add_argument("--refresh", action="store_true")
    rates.set_defaults(func=cmd_rates)

    # unblock
    unblock = sub.add_parser(
        "unblock",
        help="open a source's security check so you can clear it yourself",
    )
    unblock.add_argument("source", nargs="?", default="ff-kayak", choices=list(REGISTRY))
    unblock.add_argument("--url", help="challenge URL, if you already have one")
    unblock.add_argument("--db", default="flights.db")
    unblock.add_argument("--wait", type=int, default=300,
                         help="seconds to wait for you to finish (default 300)")
    unblock.add_argument("--status", action="store_true",
                         help="show which sources have been cleared")
    unblock.add_argument("--forget", action="store_true",
                         help="discard a stored challenge for this source")
    unblock.set_defaults(func=cmd_unblock)

    # prune
    prune = sub.add_parser("prune", help="forget flights that have already departed")
    prune.add_argument("--before", metavar="YYYY-MM-DD",
                       help="cutoff date (default: today)")
    prune.add_argument("--db", default="flights.db")
    prune.add_argument("--cache-hours", type=float,
                       default=DEFAULT_TTL.total_seconds() / 3600)
    prune.set_defaults(func=cmd_prune)

    # cache
    cache = sub.add_parser("cache", help="inspect or clear the per-source response cache")
    cache.add_argument("--db", default="flights.db")
    cache.add_argument("--cache-hours", type=float,
                       default=DEFAULT_TTL.total_seconds() / 3600)
    cache.add_argument("--purge", action="store_true", help="delete stale entries")
    cache.add_argument("--older-than", type=float, metavar="HOURS",
                       help="with --purge, the age to delete beyond (default: the TTL)")
    cache.set_defaults(func=cmd_cache)

    # serve
    serve = sub.add_parser("serve", help="run the local web UI")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=5000)
    serve.add_argument("--debug", action="store_true")
    serve.add_argument("--db", default="flights.db", help="process ledger path, or '' to disable storage")
    serve.add_argument("--workers", type=int, default=DEFAULT_MAX_WORKERS)
    serve.add_argument("--exit-with-parent", type=int, default=0, metavar="PID",
                       help="shut down when this process does (the desktop "
                            "shell passes its own pid so no sidecar is orphaned)")
    serve.set_defaults(func=cmd_serve)

    return parser


def cmd_serve(args: argparse.Namespace) -> int:
    from .parent_watch import exit_with_parent
    from .web import run_server

    exit_with_parent(args.exit_with_parent)
    run_server(host=args.host, port=args.port, debug=args.debug, db_path=args.db, max_workers=args.workers)
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())

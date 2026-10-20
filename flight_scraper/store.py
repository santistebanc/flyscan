"""SQLite storage. Three tables, and nothing said twice.

``fetches``
    One row per *(search, source)*: what was asked of whom, how it went, and
    when. This is also the record that decides whether to ask again — there is
    no separate cache, because "has this source answered this search recently"
    and "what did it answer" are the same fact, and storing it twice is how the
    two drifted apart.

``trips``
    One row per distinct flight, keyed by :attr:`Itinerary.trip_key`. Five
    sources finding the same flight write one row here.

``offers``
    A price, belonging to one fetch and one trip. The fetch **owns** its
    offers: re-fetching deletes them and inserts the fresh set, so what is here
    is always current and there is no history.

Every offer takes the source, party, cabin and timestamp of its fetch through
``fetch_id`` rather than repeating them on every row.

Prices are stored in **EUR only**, converted when scraped. A column whose
meaning depends on whichever run wrote it cannot be sorted, and "cheapest across
five sellers" is the entire point. Showing them in another currency is a
presentation concern: see :meth:`FlightStore.display_in`, which converts on the
way out and never writes.
"""

from __future__ import annotations

import csv
import hashlib
import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence

from . import fx
from .models import Itinerary, Leg, Offer, SearchQuery, Segment

#: The one currency prices are stored in. Not configurable on purpose.
STORED_CURRENCY = "EUR"

#: How long a source's answer stands before it is worth asking again.
DEFAULT_TTL = timedelta(hours=6)

#: How many times a failing source is retried before it is left alone.
DEFAULT_MAX_RETRIES = 3

#: A fetch left "loading" longer than this was abandoned by a dead process.
STUCK_AFTER = timedelta(minutes=10)

SCHEMA = """
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 10000;

CREATE TABLE IF NOT EXISTS fetches (
    id            INTEGER PRIMARY KEY,
    query_key     TEXT    NOT NULL UNIQUE,
    origin        TEXT    NOT NULL,
    destination   TEXT    NOT NULL,
    depart_date   TEXT    NOT NULL,
    return_date   TEXT,
    adults        INTEGER NOT NULL DEFAULT 1,
    children      INTEGER NOT NULL DEFAULT 0,
    infants       INTEGER NOT NULL DEFAULT 0,
    cabin         TEXT    NOT NULL DEFAULT 'economy',
    currency      TEXT    NOT NULL DEFAULT 'EUR',
    source        TEXT    NOT NULL,
    status        TEXT    NOT NULL DEFAULT 'pending',
    reason        TEXT,
    retries       INTEGER NOT NULL DEFAULT 0,
    count         INTEGER NOT NULL DEFAULT 0,
    last_fetched  TEXT,
    CHECK (status IN ('pending', 'loading', 'success', 'failed', 'challenge'))
);

CREATE INDEX IF NOT EXISTS idx_fetches_lookup
    ON fetches (origin, destination, depart_date, source);
CREATE INDEX IF NOT EXISTS idx_fetches_status ON fetches (status, last_fetched);

CREATE TABLE IF NOT EXISTS trips (
    id                      INTEGER PRIMARY KEY,
    trip_key                TEXT    NOT NULL UNIQUE,
    origin                  TEXT    NOT NULL,
    destination             TEXT    NOT NULL,
    depart_date             TEXT    NOT NULL,
    return_date             TEXT,
    departure_time          TEXT,
    arrival_time            TEXT,
    duration_minutes        INTEGER,
    stops                   INTEGER,
    return_departure_time   TEXT,
    return_arrival_time     TEXT,
    return_duration_minutes INTEGER,
    return_stops            INTEGER,
    airlines                TEXT,
    flight_numbers          TEXT,
    depart_segments         TEXT,
    return_segments         TEXT
);

CREATE INDEX IF NOT EXISTS idx_trips_route ON trips (origin, destination, depart_date);

CREATE TABLE IF NOT EXISTS offers (
    id       INTEGER PRIMARY KEY,
    fetch_id INTEGER NOT NULL REFERENCES fetches (id) ON DELETE CASCADE,
    trip_id  INTEGER NOT NULL REFERENCES trips (id)   ON DELETE CASCADE,
    agent    TEXT    NOT NULL DEFAULT '',
    price    REAL    NOT NULL,
    deeplink TEXT,
    UNIQUE (fetch_id, trip_id, agent)
);

CREATE INDEX IF NOT EXISTS idx_offers_trip  ON offers (trip_id, price);
CREATE INDEX IF NOT EXISTS idx_offers_fetch ON offers (fetch_id);
CREATE INDEX IF NOT EXISTS idx_offers_price ON offers (price);
"""

#: Columns exported to CSV/JSON, in order.
_EXPORT_COLUMNS = [
    "depart_date", "origin_airport", "destination_airport", "departure",
    "arrival", "duration_minutes", "stops", "airlines", "flight_numbers",
    "source", "agent", "price", "currency", "price_base", "base_currency",
    "deeplink", "trip_key",
]

_JSON_COLUMNS = ("depart_segments", "return_segments")


# -- keys -------------------------------------------------------------------

def query_fingerprint(query: SearchQuery) -> Dict[str, Any]:
    """The parts of a search that decide the answer, in a stable order."""
    return {
        "origin": query.origin,
        "destination": query.destination,
        "depart": query.depart.isoformat(),
        "ret": query.ret.isoformat() if query.ret else None,
        "adults": query.adults,
        "children": query.children,
        "infants": query.infants,
        "cabin": query.cabin,
        "currency": query.currency,
    }


def query_key(source: str, query: SearchQuery) -> str:
    """Identity of one question put to one source."""
    payload = json.dumps(
        {"source": source, **query_fingerprint(query)},
        sort_keys=True, separators=(",", ":"),
    )
    return hashlib.sha1(payload.encode()).hexdigest()


def _merge_segments(stored: Optional[str], fresh: Optional[str]) -> Optional[str]:
    """A better version of a stored segment list, or ``None`` to leave it be.

    Field by field, an empty value gives way to a filled one and nothing filled
    is ever overwritten — the column-level rule this sits beside, applied
    inside the JSON where the real gaps are.

    Only lists describing the same per-flight airports and minute-level clock
    times are merged. Equal segment counts alone do not establish identity.
    Marketing/operating flight numbers may differ for the same physical flight.
    """
    try:
        old = json.loads(stored or "[]") or []
        new = json.loads(fresh or "[]") or []
    except (TypeError, ValueError):
        return None
    if not isinstance(old, list) or not isinstance(new, list) or not old or not new or len(old) != len(new):
        return None

    def identity(segment):
        return (str(segment.get("origin") or "").upper(),
                str(segment.get("destination") or "").upper(),
                str(segment.get("departure") or "")[:16],
                str(segment.get("arrival") or "")[:16])

    changed = False
    out: List[Dict[str, Any]] = []
    for was, now in zip(old, new):
        if not isinstance(was, dict) or not isinstance(now, dict):
            return None
        old_identity, new_identity = identity(was), identity(now)
        if not all(old_identity) or not all(new_identity) or old_identity != new_identity:
            return None
        merged = dict(was)
        for key, value in now.items():
            if value in (None, "", []) or merged.get(key) not in (None, "", []):
                continue
            merged[key] = value
            changed = True
        out.append(merged)
    return json.dumps(out) if changed else None


def _leg_from_row(data: Dict[str, Any], inbound: bool) -> Leg:
    """One direction out of a joined trip row."""
    prefix = "return_" if inbound else ""
    return Leg(
        origin_airport=(data["destination"] if inbound else data["origin"]) or "",
        destination_airport=(data["origin"] if inbound else data["destination"]) or "",
        departure=data.get(f"{prefix}departure_time") or "",
        arrival=data.get(f"{prefix}arrival_time") or "",
        duration_minutes=data.get(f"{prefix}duration_minutes") or 0,
        stops=data.get(f"{prefix}stops"),
        airlines=data.get("airlines") or "",
        flight_numbers="" if inbound else (data.get("flight_numbers") or ""),
        segments=[
            Segment.from_dict(x)
            for x in (data.get(f"{prefix or 'depart_'}segments") or [])
            if isinstance(x, dict)
        ],
    )


class FlightStore:
    """The database — and the record of what has been asked of which source."""

    def __init__(self, path: Path | str = "flights.db", base_currency: str = STORED_CURRENCY):
        self.path = Path(path)
        if self.path.parent != Path("."):
            self.path.parent.mkdir(parents=True, exist_ok=True)
        # Ignored on purpose if someone passes something else: the column has
        # one meaning, and it is this one.
        self.base_currency = STORED_CURRENCY
        self.conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA)
        self.conn.execute("PRAGMA foreign_keys = ON")
        self.conn.commit()

    # -- deciding what to ask ----------------------------------------------

    def plan(
        self,
        query: SearchQuery,
        sources: Sequence[str],
        ttl: timedelta = DEFAULT_TTL,
        max_retries: int = DEFAULT_MAX_RETRIES,
    ) -> Dict[str, Dict[str, Any]]:
        """For each source: fetch it, or skip it and why.

        The whole decision lives here rather than spread across callers, because
        every one of these states has bitten at some point — a stale answer, a
        failure retried forever, a challenge retried at all, a "loading" row left
        behind by a process that died.
        """
        now = datetime.now(timezone.utc)
        out: Dict[str, Dict[str, Any]] = {}

        for source in sources:
            row = self.conn.execute(
                "SELECT * FROM fetches WHERE query_key = ?", (query_key(source, query),)
            ).fetchone()

            if row is None:
                out[source] = {
                    "fetch": True, "why": "never asked", "age_hours": None,
                    "last_fetched": None, "count": 0, "retries": 0, "reason": None,
                }
                continue

            record = dict(row)
            age = self._age(record["last_fetched"], now)
            status = record["status"]
            hours = round(age.total_seconds() / 3600, 2) if age else None

            # Age and last_fetched belong on every state, not just `fresh`: a
            # stale or failed source still has a "last scraped" worth showing.
            common = {
                "age_hours": hours,
                "last_fetched": record["last_fetched"],
                "count": record["count"],
                "retries": record["retries"],
                "reason": record["reason"],
            }
            if status == "challenge":
                # Never retried: more unattended traffic at a host that has just
                # asked for a human is the one thing that makes it worse.
                out[source] = {**common, "fetch": False, "why": "needs a human"}
            elif status == "loading" and (age is None or age > STUCK_AFTER):
                out[source] = {**common, "fetch": True, "why": "stuck loading"}
            elif status == "loading":
                out[source] = {**common, "fetch": False, "why": "in flight"}
            elif status == "failed" and record["retries"] >= max_retries:
                out[source] = {**common, "fetch": False, "why": "retries exhausted"}
            elif status == "failed":
                out[source] = {**common, "fetch": True, "why": "retrying"}
            elif status == "success" and age is not None and age <= ttl:
                out[source] = {**common, "fetch": False, "why": "fresh"}
            else:
                out[source] = {**common, "fetch": True, "why": "stale"}
        return out

    @staticmethod
    def _age(stamp: Optional[str], now: datetime) -> Optional[timedelta]:
        if not stamp:
            return None
        try:
            when = datetime.fromisoformat(stamp)
        except ValueError:
            return None
        if when.tzinfo is None:
            when = when.replace(tzinfo=timezone.utc)
        return now - when

    # -- the fetch lifecycle ------------------------------------------------

    def begin_fetch(self, query: SearchQuery, source: str) -> int:
        """Mark a source as being asked, and return the fetch id."""
        key = query_key(source, query)
        fingerprint = query_fingerprint(query)
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        with self.conn:
            self.conn.execute(
                """
                INSERT INTO fetches (query_key, origin, destination, depart_date,
                                     return_date, adults, children, infants, cabin,
                                     currency, source, status, reason, last_fetched)
                VALUES (?,?,?,?,?,?,?,?,?,?,?, 'loading', NULL, ?)
                ON CONFLICT (query_key) DO UPDATE SET
                    status = 'loading', reason = NULL,
                    last_fetched = excluded.last_fetched
                """,
                (
                    key, fingerprint["origin"], fingerprint["destination"],
                    fingerprint["depart"], fingerprint["ret"], fingerprint["adults"],
                    fingerprint["children"], fingerprint["infants"],
                    fingerprint["cabin"], fingerprint["currency"], source, now,
                ),
            )
        row = self.conn.execute("SELECT id FROM fetches WHERE query_key = ?", (key,)).fetchone()
        return int(row["id"])

    def complete_fetch(self, fetch_id: int, offers: Sequence[Offer]) -> int:
        """Replace this fetch's offers with what it just found.

        Delete-then-insert rather than upsert: an offer that vanished from the
        source has to vanish here too, and working out which ones disappeared is
        more work than writing the set again.
        """
        rates = fx.get_rates(STORED_CURRENCY)
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        written = 0
        seen: Dict[tuple, float] = {}

        with self.conn:
            self.conn.execute("DELETE FROM offers WHERE fetch_id = ?", (fetch_id,))
            for offer in offers:
                price = offer.price_eur
                if price is None:
                    price = rates.convert(offer.price, offer.currency)
                if price is None:
                    continue        # unconvertible: no comparable number to store
                price = round(price, 2)
                trip_id = self._upsert_trip(offer.itinerary)

                # One row per seller per trip. A source listing the same seller
                # twice for one flight keeps the cheaper of the two.
                mark = (trip_id, offer.agent)
                if mark in seen:
                    if price < seen[mark]:
                        seen[mark] = price
                        self.conn.execute(
                            "UPDATE offers SET price = ?, deeplink = ?"
                            " WHERE fetch_id = ? AND trip_id = ? AND agent = ?",
                            (price, offer.deeplink, fetch_id, trip_id, offer.agent),
                        )
                    continue

                seen[mark] = price
                self.conn.execute(
                    "INSERT INTO offers (fetch_id, trip_id, agent, price, deeplink)"
                    " VALUES (?,?,?,?,?)",
                    (fetch_id, trip_id, offer.agent, price, offer.deeplink),
                )
                written += 1

            self.conn.execute(
                "UPDATE fetches SET status='success', reason=NULL, retries=0,"
                " count=?, last_fetched=? WHERE id=?",
                (written, now, fetch_id),
            )
        return written

    def fail_fetch(self, fetch_id: int, reason: str) -> None:
        """Record a failure and count the attempt."""
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        with self.conn:
            self.conn.execute(
                "UPDATE fetches SET status='failed', reason=?, retries=retries+1,"
                " last_fetched=? WHERE id=?",
                ((reason or "")[:500], now, fetch_id),
            )

    def challenge_fetch(self, fetch_id: int, url: str) -> None:
        """Record that a source asked for a human. Deliberately not a failure."""
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        with self.conn:
            self.conn.execute(
                "UPDATE fetches SET status='challenge', reason=?, last_fetched=?"
                " WHERE id=?",
                (url, now, fetch_id),
            )

    def clear_challenges(self, source: str) -> int:
        """Forget that a source was challenged, so it is asked again.

        These blocks lift on their own — they are IP-scoped on a rolling window
        — so a source that answers again has retracted the request itself.
        """
        with self.conn:
            cursor = self.conn.execute(
                "UPDATE fetches SET status='pending', reason=NULL"
                " WHERE source=? AND status='challenge'",
                (source,),
            )
        return cursor.rowcount

    def pending_challenges(self) -> Dict[str, str]:
        """Sources waiting on a human, and where to go and be one."""
        rows = self.conn.execute(
            "SELECT source, reason, MAX(last_fetched) FROM fetches"
            " WHERE status='challenge' AND reason IS NOT NULL GROUP BY source"
        )
        return {r["source"]: r["reason"] for r in rows}

    def _upsert_trip(self, itinerary: Itinerary) -> int:
        """The trip row for this flight, created if new, filled in if thin.

        Atomic on ``trip_key``: two searches finding the same flight at the same
        moment must not both insert it, and a check-then-insert loses that race
        — which discarded whole batches when it did.
        """
        outbound, inbound = itinerary.outbound, itinerary.inbound
        values = {
            "trip_key": itinerary.trip_key,
            "origin": outbound.origin_airport or itinerary.query.origin,
            "destination": outbound.destination_airport or itinerary.query.destination,
            "depart_date": itinerary.query.depart.isoformat(),
            "return_date": itinerary.query.ret.isoformat() if itinerary.query.ret else None,
            "departure_time": outbound.departure,
            "arrival_time": outbound.arrival,
            "duration_minutes": outbound.duration_minutes,
            "stops": outbound.stops,
            "return_departure_time": inbound.departure if inbound else None,
            "return_arrival_time": inbound.arrival if inbound else None,
            "return_duration_minutes": inbound.duration_minutes if inbound else None,
            "return_stops": inbound.stops if inbound else None,
            "airlines": outbound.airlines,
            "flight_numbers": outbound.flight_numbers,
            "depart_segments": json.dumps([s.to_dict() for s in outbound.segments]),
            "return_segments": json.dumps(
                [s.to_dict() for s in inbound.segments] if inbound else []
            ),
        }
        columns = ", ".join(values)
        marks = ", ".join("?" * len(values))
        cursor = self.conn.execute(
            f"INSERT INTO trips ({columns}) VALUES ({marks})"
            f" ON CONFLICT (trip_key) DO NOTHING",
            list(values.values()),
        )
        if cursor.rowcount:
            return int(cursor.lastrowid)

        row = self.conn.execute(
            "SELECT * FROM trips WHERE trip_key = ?", (itinerary.trip_key,)
        ).fetchone()
        # Sources describe the same flight in different detail; fill the gaps
        # rather than overwrite what another source already knew.
        gaps = {
            key: value for key, value in values.items()
            if value not in (None, "", "[]") and not row[key]
        }
        # The same rule, one level down. A segment list is a single column, so
        # a stored one that *exists* but is missing a flight number was never
        # improvable: `not row[key]` is false for a non-empty blob, and the
        # trip is skipped. That is how 566 easyJet segments kept an unsplit
        # `easyJet EZY5063` long after the parser learned to read it — the
        # flights were found again on every scrape and the rows never moved.
        # Merging per field keeps the intent (never overwrite something known
        # with nothing) while letting a better answer land.
        for key in ("depart_segments", "return_segments"):
            merged = _merge_segments(row[key], values[key])
            if merged is not None:
                gaps[key] = merged
        if gaps:
            sets = ", ".join(f"{key} = ?" for key in gaps)
            self.conn.execute(
                f"UPDATE trips SET {sets} WHERE id = ?",
                list(gaps.values()) + [row["id"]],
            )
        return int(row["id"])

    # -- reading ------------------------------------------------------------

    def offers_for_search(self, query: SearchQuery) -> List[Offer]:
        """Every stored offer for one search, rebuilt as :class:`Offer` objects.

        This is what a skipped source contributes to a run: it was not asked,
        but it answered once and its offers are still here.
        """
        rows = self.conn.execute(
            """
            SELECT t.*, o.price, o.deeplink, o.agent, f.source
            FROM offers o
            JOIN trips t   ON t.id = o.trip_id
            JOIN fetches f ON f.id = o.fetch_id
            WHERE f.origin = ? AND f.destination = ? AND f.depart_date = ?
              AND ((? IS NULL AND f.return_date IS NULL) OR f.return_date = ?)
              AND f.adults = ? AND f.children = ? AND f.infants = ? AND f.cabin = ?
            """,
            (
                query.origin, query.destination, query.depart.isoformat(),
                query.ret.isoformat() if query.ret else None,
                query.ret.isoformat() if query.ret else None,
                query.adults, query.children, query.infants, query.cabin,
            ),
        )

        offers: List[Offer] = []
        for row in rows:
            data = self._row(row)
            has_return = bool(data.get("return_departure_time"))
            offers.append(
                Offer(
                    itinerary=Itinerary(
                        query=query,
                        outbound=_leg_from_row(data, False),
                        inbound=_leg_from_row(data, True) if has_return else None,
                    ),
                    source=data["source"],
                    price=float(data["price"]),
                    currency=STORED_CURRENCY,
                    agent=data["agent"] or "",
                    deeplink=data["deeplink"] or "",
                    price_eur=float(data["price"]),
                )
            )
        return offers

    def browse(
        self,
        origin: Optional[str] = None,
        destination: Optional[str] = None,
        depart_from: Optional[str] = None,
        depart_to: Optional[str] = None,
        ret: Optional[str] = None,
        ret_to: Optional[str] = None,
        match_return: bool = False,
        adults: int = 1,
        children: int = 0,
        infants: int = 0,
        cabin: str = "economy",
        max_stops: Optional[int] = None,
        limit: Optional[int] = 300,
    ) -> List[Dict[str, Any]]:
        """Stored flights for a search, each with every seller's price.

        The read side: answers from what earlier fetches left behind and never
        touches a source. Party is matched exactly — a family fare quietly mixed
        into a one-adult comparison would be worse than no answer — and so is
        the *kind* of trip, because a one-way is not a cheaper round trip.

        Both dates are windows. A search is a departure range against a return
        range, so reading it back means every stored trip inside that
        rectangle, not one date against one date.
        """
        where = ["f.adults = ?", "f.children = ?", "f.infants = ?", "f.cabin = ?"]
        params: List[Any] = [adults, children, infants, cabin]
        if origin:
            where.append("f.origin = ?")
            params.append(origin.upper())
        if destination:
            where.append("f.destination = ?")
            params.append(destination.upper())
        if depart_from:
            where.append("f.depart_date >= ?")
            params.append(depart_from)
        if depart_to:
            where.append("f.depart_date <= ?")
            params.append(depart_to)
        if max_stops is not None:
            where.append("t.stops <= ?")
            params.append(max_stops)
        if match_return:
            if ret:
                where.append("f.return_date >= ?")
                params.append(ret)
                where.append("f.return_date <= ?")
                params.append(ret_to or ret)
            else:
                where.append("f.return_date IS NULL")

        rows = self.conn.execute(
            f"""
            SELECT t.*, o.price, o.deeplink, o.agent, f.source, f.last_fetched
            FROM offers o
            JOIN trips t   ON t.id = o.trip_id
            JOIN fetches f ON f.id = o.fetch_id
            WHERE {' AND '.join(where)}
            ORDER BY o.price
            """,
            params,
        )

        # One entry per trip, its offers cheapest first (the query is sorted).
        trips: Dict[int, Dict[str, Any]] = {}
        for row in rows:
            data = self._row(row)
            trip = trips.get(data["id"])
            if trip is None:
                if limit is not None and len(trips) >= limit:
                    continue
                trip = {
                    key: value for key, value in data.items()
                    if key not in ("price", "deeplink", "agent", "source", "last_fetched")
                }
                trip["offers"] = []
                trip["last_fetched"] = data["last_fetched"]
                trips[data["id"]] = trip
            trip["offers"].append({
                "source": data["source"],
                "agent": data["agent"] or "",
                "price": float(data["price"]),
                "deeplink": data["deeplink"] or "",
            })
            if (data["last_fetched"] or "") > (trip["last_fetched"] or ""):
                trip["last_fetched"] = data["last_fetched"]

        return sorted(
            trips.values(),
            key=lambda t: t["offers"][0]["price"] if t["offers"] else float("inf"),
        )

    def cheapest(
        self,
        origin: Optional[str] = None,
        destination: Optional[str] = None,
        depart_from: Optional[str] = None,
        depart_to: Optional[str] = None,
        sources: Optional[Sequence[str]] = None,
        max_stops: Optional[int] = None,
        limit: int = 100,
    ) -> List[Dict[str, Any]]:
        """Cheapest offer per trip, cheapest first — for the ``query`` command."""
        where: List[str] = ["1 = 1"]
        params: List[Any] = []
        if origin:
            where.append("f.origin = ?")
            params.append(origin.upper())
        if destination:
            where.append("f.destination = ?")
            params.append(destination.upper())
        if depart_from:
            where.append("f.depart_date >= ?")
            params.append(depart_from)
        if depart_to:
            where.append("f.depart_date <= ?")
            params.append(depart_to)
        if max_stops is not None:
            where.append("t.stops <= ?")
            params.append(max_stops)
        if sources:
            where.append(f"f.source IN ({', '.join('?' * len(sources))})")
            params.extend(sources)

        rows = self.conn.execute(
            f"""
            SELECT t.*, MIN(o.price) AS price_base, o.agent, o.deeplink, f.source
            FROM offers o
            JOIN trips t   ON t.id = o.trip_id
            JOIN fetches f ON f.id = o.fetch_id
            WHERE {' AND '.join(where)}
            GROUP BY t.id
            ORDER BY price_base
            LIMIT ?
            """,
            params + [int(limit)],
        )

        out = []
        for row in rows:
            data = self._row(row)
            # Names the printed table and the exports already speak.
            data["origin_airport"] = data["origin"]
            data["destination_airport"] = data["destination"]
            data["departure"] = data["departure_time"]
            data["base_currency"] = STORED_CURRENCY
            out.append(data)
        return out

    def source_summary(self) -> List[Dict[str, Any]]:
        rows = self.conn.execute(
            """
            SELECT f.source,
                   COUNT(o.id)               AS offers,
                   COUNT(DISTINCT o.trip_id) AS itineraries,
                   MIN(o.price)              AS cheapest,
                   AVG(o.price)              AS average
            FROM offers o JOIN fetches f ON f.id = o.fetch_id
            GROUP BY f.source ORDER BY cheapest
            """
        )
        return [dict(r) for r in rows]

    def fetch_summary(self) -> List[Dict[str, Any]]:
        """What has been asked of each source, and how it went."""
        rows = self.conn.execute(
            """
            SELECT source, status, COUNT(*) AS n, MAX(last_fetched) AS newest
            FROM fetches GROUP BY source, status ORDER BY source, status
            """
        )
        return [dict(r) for r in rows]

    def stored_base(self) -> str:
        return STORED_CURRENCY

    def display_in(self, rows: List[Dict[str, Any]], currency: str) -> List[Dict[str, Any]]:
        """Convert stored EUR prices for display. Never writes."""
        currency = currency.upper()
        if currency == STORED_CURRENCY:
            return rows
        rates = fx.get_rates(STORED_CURRENCY)
        rate = rates.rates.get(currency)
        if not rate:
            return rows
        for row in rows:
            if row.get("price_base") is not None:
                row["price_base"] = round(row["price_base"] * rate, 2)
            row["base_currency"] = currency
        return rows

    # -- housekeeping -------------------------------------------------------

    def purge_past(self, before: Optional[str] = None) -> Dict[str, int]:
        """Drop departed flights and the fetches that found them.

        A search for last Tuesday cannot become useful again. Offers go with
        their fetch by cascade; trips left with no offers are swept after.
        """
        cutoff = before or datetime.now().date().isoformat()
        with self.conn:
            fetches = self.conn.execute(
                "DELETE FROM fetches WHERE depart_date < ?", (cutoff,)
            ).rowcount
            trips = self.conn.execute(
                "DELETE FROM trips WHERE id NOT IN (SELECT trip_id FROM offers)"
            ).rowcount
        self.conn.execute("VACUUM")
        return {"fetches": fetches, "trips": trips}

    def sweep_orphans(self) -> int:
        """Delete trips no offer points at any more."""
        with self.conn:
            cursor = self.conn.execute(
                "DELETE FROM trips WHERE id NOT IN (SELECT trip_id FROM offers)"
            )
        return cursor.rowcount

    def stats(self) -> Dict[str, int]:
        return {
            table: self.conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in ("fetches", "trips", "offers")
        }

    @staticmethod
    def _row(row: sqlite3.Row) -> Dict[str, Any]:
        data = dict(row)
        for column in _JSON_COLUMNS:
            if isinstance(data.get(column), str):
                try:
                    data[column] = json.loads(data[column])
                except json.JSONDecodeError:
                    data[column] = []
        return data

    # -- lifecycle ---------------------------------------------------------

    def close(self) -> None:
        self.conn.close()

    def __enter__(self) -> "FlightStore":
        return self

    def __exit__(self, *exc) -> None:
        self.close()


# -- export helpers ---------------------------------------------------------

def offer_to_row(offer: Offer, base_currency: str = STORED_CURRENCY) -> Dict[str, Any]:
    """Flatten an offer for CSV/JSON export."""
    leg = offer.itinerary.outbound
    query = offer.itinerary.query
    return {
        "source": offer.source,
        "agent": offer.agent,
        "price": offer.price,
        "currency": offer.currency,
        "price_base": offer.price_eur,
        "base_currency": base_currency,
        "depart_date": query.depart.isoformat(),
        "origin_airport": leg.origin_airport,
        "destination_airport": leg.destination_airport,
        "departure": leg.departure,
        "arrival": leg.arrival,
        "duration_minutes": leg.duration_minutes,
        "stops": leg.stops,
        "airlines": leg.airlines,
        "flight_numbers": leg.flight_numbers,
        "deeplink": offer.deeplink,
        "trip_key": offer.trip_key,
    }


def write_csv(rows: Iterable[Dict[str, Any]], path: Path | str) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=_EXPORT_COLUMNS, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow(row)
    return path


def write_json(rows: Iterable[Dict[str, Any]], path: Path | str) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(list(rows), indent=1, ensure_ascii=False, default=str), encoding="utf-8"
    )
    return path


def default_output_stem(origin: str, destination: str) -> str:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return f"{origin.lower()}-{destination.lower()}-{stamp}"

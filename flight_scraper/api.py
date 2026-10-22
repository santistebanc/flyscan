"""The versioned HTTP API, for frontends other than the bundled one.

Three things make this usable by something that is not a browser tab you
control:

*Resumable streams.* Events are numbered and replayable, so a client that drops
its connection sends ``Last-Event-ID`` and picks up where it left off instead of
losing the run. Two clients can watch the same search.

*A snapshot alongside the stream.* Not every frontend can hold an SSE
connection. ``GET /v1/searches/{id}`` and ``/results`` answer the same questions
by polling, from the same job.

*Idempotent creation.* Posting the same search twice while the first is still
running returns the first one's id rather than scraping it again. The sources
are the scarce resource here, not the server, so the API's job is to absorb
repeated demand — the cache handles searches that already finished, this handles
the one still in flight.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import uuid
from datetime import date
from typing import Any, Dict, List, Optional

from flask import Blueprint, Response, current_app, jsonify, request

from . import errorlog, fx
from .jobs import Job
from .models import SearchQuery, parse_date, pretty_duration, trip_pairs
from .places import resolve
from .query_jobs import belongs_to as _belongs_to
from .scheduler import FOREGROUND, default_scheduler
from .sources import DEFAULT_SOURCES, REGISTRY
from .store import FlightStore
from .task_queue import QueueClosed, QueueFull

api = Blueprint("api_v1", __name__, url_prefix="/v1")

#: Set FLIGHT_SCRAPER_API_KEY to require ``Authorization: Bearer <key>`` or
#: ``X-API-Key``. Unset means open, which is fine on localhost and not
#: elsewhere: an unauthenticated caller here spends *your* IP's goodwill with
#: the sources.
API_KEY_ENV = "FLIGHT_SCRAPER_API_KEY"


def _registry():
    return current_app.extensions["flight_scraper"]["jobs"]


def _start(params: Dict[str, Any]):
    return current_app.extensions["flight_scraper"]["start_job"](params)


def _parse(payload: Dict[str, Any]):
    return current_app.extensions["flight_scraper"]["parse_params"](payload)


# -- plumbing --------------------------------------------------------------


def search_fingerprint(params: Dict[str, Any]) -> str:
    """Identity of a search, for collapsing duplicate requests.

    Include execution policy as well as query identity: a forced refresh or a
    different freshness window must not join a search with different promises.
    """
    material = {
        k: str(params.get(k))
        for k in (
            "origin", "destination", "start", "end", "ret", "ret_end", "adults",
            "children", "infants", "cabin", "currency", "prefer", "db", "cache_hours", "refresh",
        )
    }
    material["sources"] = ",".join(sorted(params.get("sources") or []))
    return hashlib.sha1(
        json.dumps(material, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def last_event_id(req) -> int:
    """Where a reconnecting client got to, from the header or an explicit cursor."""
    raw = req.headers.get("Last-Event-ID") or req.args.get("after") or "0"
    try:
        return max(0, int(raw))
    except (TypeError, ValueError):
        return 0


def sse_response(job: Job, after: int = 0) -> Response:
    """Stream a job's event log as Server-Sent Events, resumable from ``after``."""
    def generate():
        for event in job.log.subscribe(after=after):
            if event.get("event") == "keepalive":
                # A comment keeps proxies from closing an idle stream without
                # showing up as an event on the client.
                yield ": keep-alive\n\n"
                continue
            yield f"id: {event['seq']}\ndata: {json.dumps(event, default=str)}\n\n"

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@api.before_request
def _authenticate():
    if request.method == "OPTIONS":
        return None
    key = os.environ.get(API_KEY_ENV)
    if not key:
        return None
    header = request.headers.get("Authorization", "")
    supplied = header[7:] if header.startswith("Bearer ") else request.headers.get("X-API-Key", "")
    # Native EventSource cannot set headers. Only the read-only event stream
    # accepts the session key in its URL; ordinary endpoints require a header.
    if not supplied and request.method == "GET" and re.fullmatch(r"/v1/searches/[^/]+/events", request.path):
        supplied = request.args.get("api_key", "")
    if not hmac.compare_digest(supplied.encode(), key.encode()):
        return jsonify({"error": "unauthorized"}), 401
    return None


@api.after_request
def _cors(response: Response) -> Response:
    response.headers.setdefault("Access-Control-Allow-Origin", "*")
    response.headers.setdefault(
        "Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key, Last-Event-ID"
    )
    response.headers.setdefault("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
    response.headers.setdefault("Access-Control-Expose-Headers", "Last-Event-ID")
    return response


# -- endpoints -------------------------------------------------------------


@api.get("/health")
def health():
    return jsonify({
        "status": "ok",
        "sources": list(REGISTRY),
        "scheduler": default_scheduler().snapshot(),
    })


@api.post("/errors")
def report_error():
    """Somewhere for the page to put what went wrong in front of it.

    A browser cannot write to the log, and an error that only ever reached a
    console nobody had open may as well not have happened.
    """
    payload = request.get_json(force=True, silent=True) or {}
    where = str(payload.get("where") or "ui")
    message = str(payload.get("message") or "unknown error")

    # The context is merged rather than passed alongside: a stack sent inside
    # it and one sent beside it are the same keyword twice, which is a
    # TypeError raised while reporting an error — the one failure mode this
    # whole path exists to avoid.
    context = payload.get("context")
    fields = dict(context) if isinstance(context, dict) else {"detail": context}
    fields.setdefault("stack", payload.get("stack"))

    entry = errorlog.record(
        where if where.startswith("ui") else f"ui.{where}", message, **fields,
    )
    return jsonify({"id": entry}), 202


@api.get("/errors")
def read_errors():
    """What has gone wrong lately, newest first.

    Reading is the point: an error nobody can retrieve is a rumour. `summary`
    groups them, because the shape of a problem is usually in the counts —
    forty of one thing is a site that changed, one of forty is a fluke.
    """
    try:
        limit = min(int(request.args.get("limit") or 20), 200)
    except ValueError:
        limit = 20
    return jsonify({
        "errors": errorlog.recent(limit, where=request.args.get("where")),
        "summary": errorlog.summary(),
    })


@api.delete("/errors")
def forget_errors():
    return jsonify({"cleared": errorlog.clear()})


@api.get("/jobs")
def jobs():
    """The scrape queue: what is running, what is waiting, what just finished.

    Read from memory without contacting a source or opening the ledger.
    Query groups remain global; optional filters only annotate membership.
    """
    scheduler = default_scheduler()
    jobs = scheduler.jobs()
    # Given a search, each job is marked as belonging to it or not, so the page
    # can tell its own work from a search someone left running. Matching lives
    # here because the fields do.
    if request.args.get("origin"):
        for job in jobs:
            job["mine"] = _belongs_to(job, request.args)
    groups = scheduler.query_jobs()
    if request.args.get("origin"):
        for group in groups:
            group["mine"] = _belongs_to(group, request.args)
    return jsonify({"jobs": jobs, "query_jobs": groups, "scheduler": scheduler.snapshot()})


def _queue_selection(payload):
    """Validate and resolve an explicit filter range for queue operations."""
    params, error = _parse(payload)
    if error:
        raise ValueError(error)
    try:
        query = SearchQuery(
            resolve(params["origin"], prefer=params["prefer"]).code,
            resolve(params["destination"], prefer=params["prefer"]).code,
            params["start"], params["ret"], params["adults"], params["children"],
            params["infants"], params["cabin"], params["currency"],
        )
    except (ValueError, RuntimeError) as exc:
        raise ValueError(str(exc)) from exc
    selection = {"origin": query.origin, "destination": query.destination,
                 "start": params["start"].isoformat(),
                 "end": (params["end"] or params["start"]).isoformat(),
                 "ret": params["ret"].isoformat() if params["ret"] else "",
                 "ret_end": (params["ret_end"] or params["ret"]).isoformat() if params["ret"] else "",
                 "adults": query.adults, "children": query.children, "infants": query.infants,
                 "cabin": query.cabin, "currency": query.currency}
    return selection


@api.post("/queue/selection")
def select_queue_query():
    """Set foreground filters without submitting, cancelling or hiding work."""
    payload = request.get_json(silent=True)
    if not request.is_json or (payload is None and request.get_data(as_text=True).strip() != "null"):
        return jsonify({"error": "a search object or JSON null is required"}), 400
    if payload is None:
        default_scheduler().select_query(None)
        return jsonify({"selected": None})
    if not isinstance(payload, dict):
        return jsonify({"error": "a search object or null is required"}), 400
    try:
        selection = _queue_selection(payload)
    except (ValueError, RuntimeError) as exc:
        return jsonify({"error": str(exc)}), 400
    default_scheduler().select_query(selection)
    return jsonify({"selected": selection})


@api.post("/queue/actions/<action>")
def selected_queue_action(action):
    """Act on every query job in the supplied filters, regardless of owner."""
    if action not in ("cancel", "retry"):
        return jsonify({"error": "unknown queue action"}), 400
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "search filters are required"}), 400
    try:
        selection = _queue_selection(payload)
    except (ValueError, RuntimeError) as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify(default_scheduler().selection_action(selection, action))


@api.post("/query-jobs/<group_id>/<action>")
@api.post("/query-jobs/<group_id>/sources/<source>/<action>")
def query_job_action(group_id, action, source=None):
    if action not in ("cancel", "retry"):
        return jsonify({"error": "unknown query job action"}), 400
    outcome = default_scheduler().query_action(group_id, action, source)
    if outcome is None:
        return jsonify({"error": "query job or source no longer available"}), 404
    return jsonify(outcome)


@api.post("/jobs")
def enqueue_job():
    """Push one source/trip without creating a full date-range search."""
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "a JSON object is required"}), 400
    try:
        source = payload["source"]
        if not isinstance(source, str) or source not in REGISTRY:
            raise ValueError("unknown source")
        query = SearchQuery(
            origin=payload["origin"], destination=payload["destination"],
            depart=date.fromisoformat(payload["depart"]),
            ret=date.fromisoformat(payload["ret"]) if payload.get("ret") else None,
            adults=int(payload.get("adults", 1)), children=int(payload.get("children", 0)),
            infants=int(payload.get("infants", 0)), cabin=payload.get("cabin", "economy"),
            currency=payload.get("currency", "EUR"),
        )
        if not all(re.fullmatch(r"[A-Z]{3}", code) for code in (query.origin, query.destination, query.currency)):
            raise ValueError("origin, destination and currency must be three-letter codes")
        if query.children < 0 or query.infants < 0:
            raise ValueError("passenger counts cannot be negative")
        refresh = payload.get("refresh", False)
        if not isinstance(refresh, bool):
            raise ValueError("refresh must be a boolean")
    except (KeyError, ValueError, TypeError, AttributeError) as exc:
        return jsonify({"error": str(exc)}), 400
    scheduler = default_scheduler()
    owner = "enqueue-" + uuid.uuid4().hex
    try:
        future = scheduler.submit(REGISTRY[source](), query, owner=owner, refresh=refresh)
    except QueueFull as exc:
        return jsonify({"error": str(exc)}), 429, {"Retry-After": "5"}
    except QueueClosed as exc:
        return jsonify({"error": str(exc)}), 503
    # submit may complete directly from the ledger or join another caller's work.
    if future.job_id is None:
        result = future.result()
        return jsonify({"id": None, "state": "done" if result.ok else "failed",
                        "count": result.count, "error": result.error, "cached": result.ok}), 200
    job = scheduler.find_job(future.job_id)
    return jsonify({"id": future.job_id, "state": job.state if job else "done",
                    "url": f"/v1/jobs/{future.job_id}"}), 202


@api.get("/jobs/<int:job_id>")
def read_queue_job(job_id: int):
    job = default_scheduler().find_job(job_id)
    if job is None:
        return jsonify({"error": "no such job"}), 404
    return jsonify(job.describe())


@api.post("/jobs/<int:job_id>/<action>")
def job_action(job_id: int, action: str):
    """Cancel, promote or retry one source task, including running work."""
    scheduler = default_scheduler()
    if action == "cancel":
        outcome = scheduler.cancel_job(job_id)
        if outcome == "running":
            return jsonify({"error": "already running — it will finish"}), 409
        if outcome == "gone":
            return jsonify({"error": "no such job"}), 404
        return jsonify({"id": job_id, "state": "cancelled"})

    if action == "promote":
        if not scheduler.promote_job(job_id):
            return jsonify({"error": "not waiting any more"}), 409
        return jsonify({"id": job_id, "state": "queued", "priority": FOREGROUND})

    if action == "retry":
        try:
            new_id = scheduler.retry_job(job_id)
        except QueueFull as exc:
            return jsonify({"error": str(exc)}), 429, {"Retry-After": "5"}
        except QueueClosed as exc:
            return jsonify({"error": str(exc)}), 503
        if new_id is None:
            return jsonify({"error": "still queued or running"}), 409
        return jsonify({"id": new_id, "state": "queued"})

    return jsonify({"error": f"unknown action {action!r}"}), 400


@api.post("/jobs/cancel")
def cancel_queue():
    """Empty the queue. Anything already running is left to finish.

    With a search in the body, ``mine: true`` drops that search's waiting jobs
    and ``others: true`` drops everyone else's — the second being the way to
    clear a search someone walked away from without losing the one on screen.
    With neither, everything waiting goes.
    """
    scheduler = default_scheduler()
    payload = request.get_json(force=True, silent=True) or {}
    wants_mine, wants_others = payload.get("mine"), payload.get("others")
    if not wants_mine and not wants_others:
        return jsonify({"cancelled": scheduler.cancel_queued()})

    dropped = 0
    for job in scheduler.jobs():
        if job["state"] not in ("queued", "blocked"):
            continue
        if _belongs_to(job, payload) is bool(wants_mine):
            dropped += scheduler.cancel_job(job["id"]) == "cancelled"
    return jsonify({"cancelled": dropped})


@api.get("/sources")
def sources():
    return jsonify([
        {
            "name": name,
            "label": cls.label,
            "currency": cls.fixed_currency,
            "max_concurrency": cls.max_concurrency,
            "min_interval": cls.min_interval,
        }
        for name, cls in REGISTRY.items()
    ])


@api.post("/searches")
def create_search():
    payload = request.get_json(force=True, silent=True) or {}
    params, error = _parse(payload)
    if error:
        return jsonify({"error": error}), 400

    params["_fingerprint"] = search_fingerprint(params)
    params["_force"] = bool(payload.get("force"))
    job, joined = _start(params)
    return jsonify({**job.summary(), "joined": joined}), 200 if joined else 202


@api.get("/searches")
def list_searches():
    limit = min(int(request.args.get("limit") or 25), 100)
    return jsonify([job.summary() for job in _registry().list(limit)])


@api.get("/searches/<search_id>")
def get_search(search_id: str):
    job = _registry().get(search_id)
    if job is None:
        return jsonify({"error": "unknown search"}), 404
    return jsonify(job.summary())


@api.get("/searches/<search_id>/events")
def stream_search(search_id: str):
    job = _registry().get(search_id)
    if job is None:
        return jsonify({"error": "unknown search"}), 404
    return sse_response(job, last_event_id(request))


@api.get("/searches/<search_id>/results")
def search_results(search_id: str):
    """Everything found so far, flattened — usable mid-run, not just at the end."""
    job = _registry().get(search_id)
    if job is None:
        return jsonify({"error": "unknown search"}), 404

    try:
        limit = min(int(request.args.get("limit") or 200), 1000)
        max_stops = (
            int(request.args["max_stops"]) if request.args.get("max_stops") else None
        )
    except ValueError as exc:
        return jsonify({"error": f"bad filter: {exc}"}), 400
    day_filter = request.args.get("day")

    days = job.days
    rows = [
        row
        for day in days
        if day_filter is None or day["day"] == day_filter
        for row in day["rows"]
    ]
    if max_stops is not None:
        rows = [r for r in rows if r.get("stops") is not None and r["stops"] <= max_stops]
    rows.sort(key=lambda r: (r["best"]["price_base"] is None, r["best"]["price_base"] or 0))

    return jsonify({
        "search_id": job.id,
        "status": job.status,
        "days_done": len(days),
        "count": len(rows),
        "results": rows[:limit],
    })


@api.delete("/searches/<search_id>")
def cancel_search(search_id: str):
    job = _registry().get(search_id)
    if job is None:
        return jsonify({"error": "unknown search"}), 404
    job.cancel()
    return jsonify({**job.summary(), "cancelling": True})


@api.post("/freshness")
def freshness():
    """How old each source's answer is for a search, per date.

    Lets a frontend show what it is looking at — "Kayak's prices are 4 hours
    old" — and refresh only the stale ones. Asking a source is the expensive
    step, so re-asking three of six is the difference between 3s and 90s.
    """
    payload = request.get_json(force=True, silent=True) or {}
    params, error = _parse(payload)
    if error:
        return jsonify({"error": error}), 400

    store = default_scheduler().store
    if store is None:
        return jsonify({"error": "no database, so nothing is recorded"}), 409

    sources = params["sources"]
    per_day = []
    for day, back in trip_pairs(
        params["start"], params["end"], params["ret"], params["ret_end"]
    ):
        query = SearchQuery(
            origin=params["origin"], destination=params["destination"], depart=day,
            ret=back, adults=params["adults"], children=params["children"],
            infants=params["infants"],
            cabin=params["cabin"], currency=params["currency"],
        )
        plan = store.plan(query, sources, ttl=default_scheduler().ttl)
        per_day.append({
            "day": day.isoformat(),
            "ret": back.isoformat() if back else None,
            "sources": [
                {
                    "source": name,
                    "cached": not decision["fetch"] or decision["why"] != "never asked",
                    "fresh": decision["why"] == "fresh",
                    "why": decision["why"],
                    "age_hours": decision.get("age_hours"),
                    "offers": decision.get("count", 0),
                }
                for name, decision in plan.items()
            ],
        })

    # A per-source roll-up across the range is what the UI actually renders.
    summary = []
    for source in sources:
        rows = [s for d in per_day for s in d["sources"] if s["source"] == source]
        ages = [r["age_hours"] for r in rows if r["age_hours"] is not None]
        summary.append({
            "source": source,
            "days_cached": sum(1 for r in rows if r["cached"]),
            "days_total": len(rows),
            "days_fresh": sum(1 for r in rows if r["fresh"]),
            "oldest_hours": max(ages) if ages else None,
            "newest_hours": min(ages) if ages else None,
            "offers": sum(r["offers"] for r in rows),
        })

    return jsonify({
        "ttl_hours": round(default_scheduler().ttl.total_seconds() / 3600, 2),
        "summary": sorted(summary, key=lambda s: (s["oldest_hours"] is None,
                                                  -(s["oldest_hours"] or 0))),
        "days": per_day,
    })


@api.post("/maintenance/purge")
def purge():
    """Forget flights that have already departed, and stale cache entries."""
    payload = request.get_json(force=True, silent=True) or {}
    before = payload.get("before")

    store = FlightStore(payload.get("db", "flights.db"))
    try:
        removed = store.purge_past(before)
    finally:
        store.close()

    return jsonify({"removed": removed})


def _can_solve_here() -> bool:
    """Whether this process can put a browser in front of a person.

    Needs Playwright, which the packaged sidecar deliberately leaves out — the
    desktop shell uses its own webview instead, and 150 MB of browser is a lot
    to carry for a feature that shell already has.
    """
    try:
        import playwright.sync_api  # noqa: F401
    except Exception:
        return False
    return True


@api.get("/challenges")
def challenges():
    """Sources waiting on a human, and where to go and be one.

    Clearing one needs a browser on the machine running the scraper. When that
    machine is this one, ``POST /challenges/{source}/solve`` opens it here.
    """
    pending = default_scheduler().challenges()
    solving = default_scheduler().challenge_control.solving()
    errors = default_scheduler().challenge_control.recovery_errors()
    return jsonify({
        "pending": [
            {"source": s, "url": u, "solving": s in solving, "error": errors.get(s)} for s, u in pending.items()
        ],
        "can_solve_here": _can_solve_here(),
        "how_to_clear": "flight-scraper unblock <source>",
    })


@api.post("/challenges/<source>/solve")
def solve_challenge(source: str):
    """Open this source's check in a browser on the machine running the scraper.

    Only useful when that machine is the one the person is sitting at — which is
    the normal case, since the server runs on localhost. The browser it opens is
    one this process owns, so the cookies the check hands out land where the
    scraper can use them; a check cleared in someone's own Chrome leaves them
    there, which is the whole reason this endpoint exists.

    Returns immediately. Solving takes as long as a person takes, so the work
    runs in the background and the caller watches ``GET /challenges`` for the
    source to disappear.
    """
    if source not in REGISTRY:
        return jsonify({"error": f"unknown source: {source}"}), 404
    if not _can_solve_here():
        return jsonify({
            "error": "this server cannot open a browser (Playwright is not installed)",
        }), 501

    control = default_scheduler().challenge_control
    if source not in control.pending():
        return jsonify({"source": source, "status": "already cleared"})
    started = control.start_recovery(source)
    return jsonify({"source": source, "status": "opening a browser" if started else "already open"}), 202


@api.post("/challenges/<source>/cookies")
def store_challenge_cookies(source: str):
    """Take the cookies a person earned by clearing a challenge elsewhere.

    The desktop shell opens the challenge in its own webview, so the cookies are
    minted there rather than here. They transfer: the sources accept cookies
    from one client presented by another, which is why the shell does not have
    to proxy every later request too.

    This is the receiving half of that — it stores nothing about *how* the
    challenge was cleared, only that it was, and by whom is the caller's
    business.
    """
    if source not in REGISTRY:
        return jsonify({"error": f"unknown source: {source}"}), 404

    payload = request.get_json(force=True, silent=True) or {}
    cookies = payload.get("cookies")
    if isinstance(cookies, list):
        # Accept the browser-shaped form too: [{name, value}, ...]
        cookies = {
            c["name"]: c["value"]
            for c in cookies
            if isinstance(c, dict) and "name" in c and "value" in c
        }
    if not isinstance(cookies, dict) or not cookies:
        return jsonify({"error": "expected a non-empty 'cookies' object or list"}), 400

    default_scheduler().challenge_control.accept_cookies(
        source, {str(k): str(v) for k, v in cookies.items()}, payload.get("url", ""),
    )
    return jsonify({
        "source": source,
        "stored": len(cookies),
        "cleared": True,
    })


@api.delete("/challenges/<source>")
def clear_challenge(source: str):
    """Mark a challenge as dealt with, so the source is tried again."""
    cleared = default_scheduler().clear_challenge(source)
    return jsonify({"source": source, "cleared": cleared})


@api.get("/places")
def places():
    from .places import PlaceLookupError, search_places

    term = (request.args.get("q") or "").strip()
    if len(term) < 2:
        return jsonify([])
    try:
        matches = search_places(term)
    except PlaceLookupError as exc:
        return jsonify({"error": str(exc)}), 502
    return jsonify([
        {"code": p.code, "name": p.name, "country": p.country, "kind": p.kind, "city": p.city}
        for p in matches
    ])


def _stored_leg(
    airport_from: str, airport_to: str, departure: str, arrival: str,
    minutes: Optional[int], stops: Optional[int], airlines: str,
    flight_numbers: str, segments: Any,
) -> Dict[str, Any]:
    """One direction, rebuilt from stored columns."""
    return {
        "origin_airport": airport_from,
        "destination_airport": airport_to,
        "departure": departure or "",
        "arrival": arrival or "",
        "duration": pretty_duration(minutes) if minutes else "",
        "stops": stops,
        "airlines": airlines or "",
        "flight_numbers": flight_numbers or "",
        "segments": [
            {
                "carrier": seg.get("carrier", ""),
                "carrier_name": seg.get("carrier_name") or seg.get("carrier", ""),
                "flight_number": seg.get("flight_number", ""),
                "origin": seg.get("origin", ""),
                "destination": seg.get("destination", ""),
                "departure": seg.get("departure", ""),
                "arrival": seg.get("arrival", ""),
                "duration": pretty_duration(seg.get("duration_minutes") or 0),
            }
            for seg in (segments or [])
            if isinstance(seg, dict)
        ],
    }


def _stored_offer(offer: Dict[str, Any]) -> Dict[str, Any]:
    # Stored prices are EUR and only EUR, so `price` and `price_base` are the
    # same number. The pair is kept because a live search sends both, and the
    # client must not have to know which it is looking at.
    price = offer.get("price")
    return {
        "source": offer.get("source", ""),
        "agent": offer.get("agent", ""),
        "price": price,
        "currency": "EUR",
        "price_base": price,
        "deeplink": offer.get("deeplink", ""),
    }


def _stored_row(row: Dict[str, Any]) -> Dict[str, Any]:
    """A stored flight in the same shape a live search streams.

    Deliberately identical to ``searches._merged_row``: the table and the detail
    panel must not care whether a row came from the database or from a scrape
    that finished a second ago.
    """
    offers = [_stored_offer(o) for o in row.get("offers") or []]
    sources: list = []
    for offer in offers:
        if offer["source"] not in sources:
            sources.append(offer["source"])
    priced = [o["price_base"] for o in offers if o["price_base"] is not None]
    spread = round(max(priced) - min(priced), 2) if len(priced) > 1 else None

    has_return = bool(row.get("return_departure_time"))
    return {
        "trip_key": row["trip_key"],
        "depart_date": row["depart_date"],
        "route": f"{row['origin']}-{row['destination']}",
        "departure": row.get("departure_time") or "",
        "arrival": row.get("arrival_time") or "",
        "duration": pretty_duration(row.get("duration_minutes") or 0),
        "stops": row.get("stops"),
        "airlines": row.get("airlines") or "",
        "flight_numbers": row.get("flight_numbers") or "",
        # The return date searched for — see the note in searches._merged_row.
        "return_date": row.get("return_date") or "",
        "return_departure": row.get("return_departure_time") or "",
        "return_arrival": row.get("return_arrival_time") or "",
        "return_duration": (
            pretty_duration(row.get("return_duration_minutes") or 0) if has_return else ""
        ),
        "outbound": _stored_leg(
            row["origin"], row["destination"],
            row.get("departure_time"), row.get("arrival_time"),
            row.get("duration_minutes"), row.get("stops"),
            row.get("airlines"), row.get("flight_numbers"),
            row.get("depart_segments"),
        ),
        "inbound": _stored_leg(
            row["destination"], row["origin"],
            row.get("return_departure_time"), row.get("return_arrival_time"),
            row.get("return_duration_minutes"), row.get("return_stops"),
            row.get("airlines"), "", row.get("return_segments"),
        ) if has_return else None,
        "best": offers[0] if offers else None,
        "sources": sources,
        "source_count": len(sources),
        "spread": spread,
        "offers": offers,
    }


@api.get("/flights")
def stored_flights():
    """What is already known, straight from the database — no scraping.

    This is what lets a frontend fill in the instant a form changes. Asking a
    source is a separate, explicit act; this only reads what earlier searches
    left behind, so it costs nothing and cannot be rate limited.
    """
    args = request.args
    try:
        # The virtualized desktop requests all matching flights for comparison.
        # Keep bounded reads available for other callers; 0 is also unlimited.
        requested_limit = 0 if args.get("all") == "1" else int(args.get("limit") or 300)
        if requested_limit < 0:
            raise ValueError("limit must be zero or positive")
        limit = min(requested_limit, 1000) if requested_limit else None
        max_stops = int(args["max_stops"]) if args.get("max_stops") else None
        adults = max(1, int(args.get("adults") or 1))
        children = max(0, int(args.get("children") or 0))
        infants = max(0, int(args.get("infants") or 0))
    except ValueError as exc:
        return jsonify({"error": f"bad filter: {exc}"}), 400

    store = FlightStore(args.get("db") or "flights.db")
    try:
        rows = store.browse(
            origin=args.get("origin"),
            destination=args.get("destination"),
            depart_from=args.get("start"),
            depart_to=args.get("end") or args.get("start"),
            # A one-way ticket is a different product from a round trip, so a
            # search for one must never list the other. Returns are a window
            # too: the search is a departure range against a return range.
            ret=args.get("ret") or None,
            ret_to=args.get("ret_end") or args.get("ret") or None,
            match_return=True,
            adults=adults, children=children, infants=infants,
            cabin=args.get("cabin") or "economy",
            max_stops=max_stops,
            limit=limit,
        )
        results = [_stored_row(r) for r in rows]
        newest = max((r.get("last_fetched") or "" for r in rows), default="")
        return jsonify({
            "count": len(results),
            "results": results,
            # When these prices were last confirmed, so the page can say so.
            "last_seen": newest,
            # Where each source stands for exactly this search. The same call
            # the scheduler makes to decide what to ask, so the page shows the
            # decision rather than a guess at it.
            "sources": _source_status(store, args, adults, children, infants),
        })
    finally:
        store.close()


def _source_status(
    store: FlightStore, args: Any, adults: int, children: int, infants: int
) -> List[Dict[str, Any]]:
    """Per-source state for one search, rolled up across its dates.

    A search is many fetches per source — one per trip, and a departure range
    against a return range is a rectangle of them — so the roll-up reports the
    state that matters: anything needing a fetch outranks anything fresh, and a
    source waiting on a human outranks the lot. Reporting only the best of them
    would say "fresh" for a search that is mostly missing.
    """
    start = parse_date(args.get("start") or "")
    if start is None:
        return []
    end = parse_date(args["end"]) if str(args.get("end") or "").strip() else start
    ret = parse_date(args["ret"]) if str(args.get("ret") or "").strip() else None
    ret_end = parse_date(args["ret_end"]) if str(args.get("ret_end") or "").strip() else None

    # Worst-first, so the roll-up keeps the state that needs attention.
    rank = {"needs a human": 0, "retries exhausted": 1, "never asked": 2,
            "stale": 3, "retrying": 4, "stuck loading": 5, "in flight": 6, "fresh": 7}

    worst: Dict[str, Dict[str, Any]] = {}
    for day, back in trip_pairs(start, end, ret, ret_end):
        query = SearchQuery(
            origin=(args.get("origin") or "").strip(),
            destination=(args.get("destination") or "").strip(),
            depart=day, ret=back,
            adults=adults, children=children, infants=infants,
            cabin=args.get("cabin") or "economy",
            currency=(args.get("currency") or "EUR").upper(),
        )
        for source, decision in store.plan(query, DEFAULT_SOURCES).items():
            seen = worst.get(source)
            better = seen is None or rank.get(decision["why"], 9) < rank.get(seen["why"], 9)
            entry = {
                "source": source,
                "why": decision["why"],
                "fetch": decision["fetch"],
                "age_hours": decision.get("age_hours"),
                "last_fetched": decision.get("last_fetched"),
                "count": decision.get("count", 0),
                "retries": decision.get("retries", 0),
                "reason": decision.get("reason"),
            }
            if seen is None:
                worst[source] = entry
            else:
                seen["count"] = (seen["count"] or 0) + (entry["count"] or 0)
                ages = [a for a in (seen["age_hours"], entry["age_hours"]) if a is not None]
                seen["age_hours"] = max(ages) if ages else None
                if better:
                    seen.update({
                        k: entry[k]
                        for k in ("why", "fetch", "reason", "retries", "last_fetched")
                    })
    return [worst[s] for s in DEFAULT_SOURCES if s in worst]


@api.get("/rates")
def rates():
    table = fx.get_rates((request.args.get("base") or "EUR").upper())
    return jsonify({
        "base": table.base,
        "provider": table.provider,
        "fetched_at": table.fetched_at,
        "rates": table.rates,
    })

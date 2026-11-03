"""The web layer: the bundled UI, and the versioned API underneath it.

A search runs on a background thread and appends to its job's event log; the
browser reads that log over Server-Sent Events, so each source's results appear
the moment that source finishes rather than after the slowest one does. The log
is replayable, so a reconnect resumes rather than starting blank, and two
clients can watch the same search.

Prices arrive from the sources in whatever currency they quote and are shown
converted to one currency, with the original kept alongside so nothing is
silently rewritten.
"""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path
from typing import Any, Dict, Optional

from flask import Flask, jsonify, send_from_directory

from . import errorlog
from .api import api, search_fingerprint
from .deployment import allowed_sources, web_mode
from .jobs import JobRegistry
from .models import parse_date, trip_pairs
from .scheduler import (
    DEFAULT_MAX_WORKERS,
    default_scheduler,
    execution_settings,
    validate_execution_settings,
)
from .searches import OUT_DIR, execute_search
from .sources import REGISTRY

#: One registry for the process, shared by the UI endpoints and the API.
JOBS = JobRegistry()


def parse_params(form: Dict[str, Any]):
    """Read a search request. Returns ``(params, error)``; error is None on success.

    Shared by the bundled UI and the versioned API so the two cannot drift into
    accepting subtly different searches.
    """
    try:
        settings = execution_settings()
        chosen = form.get("sources") or allowed_sources(REGISTRY)
        if not isinstance(chosen, list) or not all(isinstance(s, str) for s in chosen):
            return None, "sources must be a list of names"
        if set(chosen) - set(allowed_sources(REGISTRY)):
            return None, "source disabled on the web"
        unknown = [s for s in chosen if s not in REGISTRY]
        if unknown:
            return None, "unknown source(s): " + ", ".join(unknown)

        params = {
            "origin": (form.get("origin") or "").strip(),
            "destination": (form.get("destination") or "").strip(),
            "start": parse_date(form.get("start") or ""),
            "end": parse_date(form["end"]) if str(form.get("end") or "").strip() else None,
            "ret": parse_date(form["ret"]) if str(form.get("ret") or "").strip() else None,
            "ret_end": (
                parse_date(form["ret_end"]) if str(form.get("ret_end") or "").strip() else None
            ),
            "adults": max(1, int(form.get("adults") or 1)),
            "children": max(0, int(form.get("children") or 0)),
            "infants": max(0, int(form.get("infants") or 0)),
            "cabin": form.get("cabin") or "economy",
            "currency": (form.get("currency") or "EUR").upper(),
            "base_currency": (form.get("base_currency") or "EUR").upper(),
            "sources": list(chosen),
            "prefer": form.get("prefer") or "city",
            "timeout": int(form.get("timeout") or 60),
            "retries": int(form.get("retries") or 2),
            "workers": int(form.get("workers") or settings["workers"]),
            "cache_hours": float(
                form["cache_hours"] if str(form.get("cache_hours") or "").strip() else 6
            ),
            # Force every source to be asked again even if the cache is fresh.
            # The UI does not set this: pressing Search is already "show what is
            # fresh instantly, go and fetch what is stale".
            "refresh": bool(form.get("refresh")),
            "db": form["db"] if "db" in form else settings["db"],
        }
    except (ValueError, TypeError) as exc:
        return None, f"bad input: {exc}"

    if not params["origin"] or not params["destination"]:
        return None, "origin and destination are both required"
    try:
        params["db"] = str(Path(params["db"]).resolve()) if params["db"] else None
        validate_execution_settings(db_path=params["db"], max_workers=params["workers"])
    except (ValueError, TypeError) as exc:
        return None, f"bad input: {exc}"
    if web_mode():
        if params["end"] and (params["end"] - params["start"]).days > 30:
            return None, "hosted searches support at most 31 departure dates"
        if params["ret_end"] and params["ret"] and (params["ret_end"] - params["ret"]).days > 30:
            return None, "hosted searches support at most 31 return dates"
        params.update(
            db=settings["db"],
            workers=settings["workers"],
            refresh=False,
            cache_hours=6,
            retries=1,
            timeout=60,
        )
        if len(trip_pairs(params["start"], params["end"], params["ret"], params["ret_end"])) > 31:
            return None, "hosted searches support at most 31 trips"
    if params["end"] and params["end"] < params["start"]:
        return None, "end date is before start date"
    # A return before the outbound is not a trip. Worth rejecting rather than
    # searching: every source answers it with nothing, which reads exactly like
    # a route with no flights.
    if params["ret_end"] and not params["ret"]:
        return None, "a return range needs a first return date"
    if params["ret_end"] and params["ret_end"] < params["ret"]:
        return None, "last return date is before the first"
    # Two ranges make a rectangle of trips, and the corner where the return
    # falls before the departure is simply left out. Only if *every* corner is
    # like that is there nothing to search — worth saying so rather than
    # running a search that can only come back empty.
    if params["ret"] and not trip_pairs(
        params["start"], params["end"], params["ret"], params["ret_end"]
    ):
        return None, "every return date is before every departure date"
    return params, None


def start_job(params):
    """Atomically join or start one protected search lifecycle."""
    params = dict(params)
    fingerprint = params.pop("_fingerprint", None) or search_fingerprint(params)
    force = params.pop("_force", False)
    return JOBS.start(
        _public_params(params), fingerprint, lambda job: execute_search(job, params), force=force
    )


def _public_params(params: Dict[str, Any]) -> Dict[str, Any]:
    """The search as a client would describe it — no local file paths."""
    return {
        k: (v.isoformat() if hasattr(v, "isoformat") else v) for k, v in params.items() if k != "db"
    }


def create_app() -> Flask:
    """The API, plus the built frontend if it has been compiled.

    There is deliberately no server-rendered UI any more. There used to be one
    here and a second, richer frontend in ``desktop/``, each with its own copy
    of the same table, drawer and formatting — and they drifted, repeatedly, in
    ways that only showed up at runtime. One frontend that both the browser and
    the desktop shell load is worth more than two that almost agree.
    """
    root = Path(__file__).parent.parent
    bundle = _frontend_dir(root)
    allowed_sources(REGISTRY)  # Validate configuration before serving requests.
    app = Flask(__name__, static_folder=None)
    app.config["MAX_CONTENT_LENGTH"] = 64 * 1024
    from .hosted import install_hosted_policy

    install_hosted_policy(app)

    @app.errorhandler(Exception)
    def _record_unhandled(exc):
        """Nothing gets to fail silently with a 500 and no trace of why."""
        from flask import request as incoming
        from werkzeug.exceptions import HTTPException

        if isinstance(exc, HTTPException):
            return exc  # 404s and the like are answers, not failures
        entry = errorlog.record(
            f"api{incoming.path.replace('/', '.')}",
            exc,
            method=incoming.method,
            path=incoming.full_path,
            body=incoming.get_json(silent=True),
        )
        message = (
            "The request could not be completed." if web_mode() else f"{type(exc).__name__}: {exc}"
        )
        return jsonify({"error": message, "logged": entry}), 500

    @app.get("/")
    def index():
        if bundle is None:
            return (
                "<h1>Flyscan</h1>"
                "<p>The API is running. The frontend has not been built:"
                " <code>npm install --prefix desktop &amp;&amp;"
                " npm run build --prefix desktop</code>,"
                " or run it with live reload via"
                " <code>npm run dev --prefix desktop</code>.</p>"
                "<p>The API itself is at <code>/v1/health</code>.</p>"
            ), 200
        return send_from_directory(bundle, "index.html")

    @app.get("/<path:asset>")
    def frontend_asset(asset: str):
        """Serve the built bundle's files, and nothing outside it."""
        if bundle is None:
            return jsonify({"error": "frontend not built"}), 404
        target = (bundle / asset).resolve()
        if not target.is_relative_to(bundle.resolve()) or not target.is_file():
            return jsonify({"error": "not found"}), 404
        return send_from_directory(bundle, asset)

    app.register_blueprint(api)
    app.extensions["flyscan"] = {
        "jobs": JOBS,
        "start_job": start_job,
        "parse_params": parse_params,
    }

    @app.get("/download/<path:filename>")
    def download(filename: str):
        return send_from_directory(OUT_DIR.resolve(), filename, as_attachment=True)

    return app


def _frontend_dir(root: Path) -> Optional[Path]:
    """Where the compiled frontend lives, in a checkout and in a bundle.

    PyInstaller unpacks data next to the executable, so the packaged sidecar
    looks beside itself before falling back to the repository layout.
    """
    candidates = [Path(getattr(sys, "_MEIPASS", root)) / "frontend", root / "desktop" / "dist"]
    for candidate in candidates:
        if (candidate / "index.html").is_file():
            return candidate
    return None


def run_server(
    host: str = "127.0.0.1",
    port: int = 5000,
    debug: bool = False,
    db_path="flights.db",
    max_workers=DEFAULT_MAX_WORKERS,
) -> None:
    # With --debug, Werkzeug runs this twice: a parent that only watches the source and
    # restarts a child that serves. Only the child should own a scheduler and the ledger.
    if not debug or os.environ.get("WERKZEUG_RUN_MAIN"):
        default_scheduler(db_path=db_path or None, max_workers=max_workers)
    for noisy in ("curl_cffi", "urllib3"):
        logging.getLogger(noisy).setLevel(logging.DEBUG if debug else logging.WARNING)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    app = create_app()
    print(f"\n  Flyscan UI -> http://{host}:{port}\n")
    # threaded=True so an in-flight SSE stream does not block new requests.
    if getattr(sys, "frozen", False):
        from waitress import serve

        # SSE holds a worker for each active stream; leave capacity for API
        # requests and cache reads while searches run. Bind only to loopback.
        serve(app, host="127.0.0.1", port=port, threads=16, channel_timeout=120)
    else:
        app.run(host=host, port=port, debug=debug, threaded=True)

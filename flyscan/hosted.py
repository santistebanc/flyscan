"""Restrictions for a shared, internet-facing instance."""

import os
import threading
import time
from collections import deque
from datetime import date

from flask import jsonify, request

from .deployment import web_mode


def install_hosted_policy(app):
    if not web_mode():
        return
    calls = deque()
    lock = threading.Lock()

    @app.before_request
    def hosted_request():
        # One shared budget bounds work even across many visitor IPs. Run one process.
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            now = time.monotonic()
            with lock:
                while calls and calls[0] < now - 60:
                    calls.popleft()
                if len(calls) >= 90:
                    return (
                        jsonify(error="The service is busy. Please try again shortly."),
                        429,
                        {"Retry-After": "60"},
                    )
                calls.append(now)
            origin = request.headers.get("Origin")
            allowed_origins = {
                value.strip()
                for value in os.environ.get(
                    "FLYSCAN_PUBLIC_ORIGIN", request.host_url.rstrip("/")
                ).split(",")
            }
            if origin and origin not in allowed_origins:
                return jsonify(error="cross-origin writes are disabled"), 403
        if request.path.startswith("/download/"):
            return jsonify(error="Server exports are not public."), 403
        if request.path.startswith("/v1/"):
            if request.path == "/v1/flights":
                try:
                    first = (
                        date.fromisoformat(request.args["start"])
                        if request.args.get("start")
                        else None
                    )
                    last = (
                        date.fromisoformat(request.args["end"])
                        if request.args.get("end")
                        else first
                    )
                    back = (
                        date.fromisoformat(request.args["ret"]) if request.args.get("ret") else None
                    )
                    back_last = (
                        date.fromisoformat(request.args["ret_end"])
                        if request.args.get("ret_end")
                        else back
                    )
                    outward = (last - first).days + 1 if first and last else 1
                    inward = (back_last - back).days + 1 if back and back_last else 1
                    if outward > 31 or inward > 31 or outward * inward > 31:
                        return jsonify(
                            error="Hosted reads support at most 31 departure dates."
                        ), 400
                except ValueError:
                    return jsonify(error="Invalid date filter."), 400
            payload = request.get_json(silent=True) if request.is_json else None
            if "db" in request.args or isinstance(payload, dict) and "db" in payload:
                return jsonify(error="Database paths cannot be selected remotely."), 400
            if request.method in {"GET", "HEAD", "OPTIONS"}:
                if request.path == "/v1/errors":
                    return jsonify(error="Server diagnostics are private."), 403
                return None
            if request.path == "/v1/queue/selection":
                # Visitor filters must not reorder the shared queue, but the page still
                # needs the resolved selection to tell which queue groups are its own.
                from .api import _queue_selection

                if not isinstance(payload, dict):
                    return jsonify(selected=None)
                try:
                    return jsonify(selected=_queue_selection(payload))
                except ValueError as exc:
                    return jsonify(error=str(exc)), 400
            if request.method == "POST" and request.path in {
                "/v1/searches",
                "/v1/jobs",
                "/v1/freshness",
                "/v1/errors",
            }:
                if not isinstance(payload, dict):
                    return jsonify(error="A JSON object is required."), 400
                if request.path in {"/v1/searches", "/v1/jobs"}:
                    from .scheduler import default_scheduler

                    state = default_scheduler().snapshot()
                    if state["queued"] + state["running"] >= 128:
                        return (
                            jsonify(error="The search queue is full."),
                            429,
                            {"Retry-After": "30"},
                        )
                return None
            return jsonify(error="This operation is available only in the desktop app."), 403
        return None

    @app.after_request
    def hosted_response(response):
        response.headers.pop("Access-Control-Allow-Origin", None)
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

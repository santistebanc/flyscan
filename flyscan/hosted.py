"""Restrictions for a shared, internet-facing instance."""

import os
import threading
import time
from collections import deque
from datetime import date

from flask import jsonify, redirect, request, session
from werkzeug.security import check_password_hash

from .deployment import edition, web_mode


def install_hosted_policy(app):
    if not web_mode():
        return
    private = edition() == "private"
    if private and not os.environ.get("FLYSCAN_SESSION_SECRET"):
        raise ValueError("private web hosting requires FLYSCAN_SESSION_SECRET")
    if private and not os.environ.get("FLYSCAN_PRIVATE_PASSWORD_HASH"):
        raise ValueError("private web hosting requires FLYSCAN_PRIVATE_PASSWORD_HASH")
    app.secret_key = os.environ.get("FLYSCAN_SESSION_SECRET")
    app.config.update(
        SESSION_COOKIE_SECURE=True, SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax"
    )
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
        if request.path.startswith("/updates/private/"):
            return None  # Separate password check, including every installer request.
        if private and request.path == "/v1/health" and not session.get("private_access"):
            return jsonify(status="ok")
        if (
            private
            and request.path != "/login"
            and request.path != "/v1/health"
            and not session.get("private_access")
        ):
            if request.path.startswith("/v1/"):
                return jsonify(error="Sign in to the private edition."), 401
            return redirect("/login")
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
                return jsonify(selected=True)  # Visitor filters must not reorder the shared queue.
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
            return jsonify(error="This operation is available only in the desktop edition."), 403
        return None

    @app.route("/login", methods=["GET", "POST"])
    def private_login():
        if not private:
            return redirect("/")
        message = ""
        if request.method == "POST":
            password = request.form.get("password", "")
            if check_password_hash(os.environ["FLYSCAN_PRIVATE_PASSWORD_HASH"], password):
                session.clear()
                session["private_access"] = True
                return redirect("/")
            message = "Password not accepted."
        return (
            '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width">'
            '<title>Flyscan Private — Sign in</title><body style="background:#161c20;color:#edf1ef;'
            'font:16px system-ui;max-width:28rem;margin:15vh auto;padding:24px">'
            "<h1>Flyscan Private</h1><p>Sign in to use all sources.</p>"
            '<form method="post"><label for="password">Password</label><br>'
            '<input id="password" name="password" type="password" autocomplete="current-password" required '
            'style="font:inherit;padding:10px;margin:12px 0;width:90%"><br>'
            f'<button style="font:inherit;padding:10px 24px">Sign in</button><p role="alert">{message}</p></form></body></html>'
        )

    @app.after_request
    def hosted_response(response):
        response.headers.pop("Access-Control-Allow-Origin", None)
        response.headers["X-Content-Type-Options"] = "nosniff"
        if private or request.path.startswith("/updates/private/"):
            response.headers["Cache-Control"] = "no-store"
        return response

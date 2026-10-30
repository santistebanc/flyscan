"""Password-protected proxy for signed assets in a private GitHub repository.

The GitHub token stays on the host. Neither manifests nor redirects expose it.
"""

import base64
import binascii
import json
import os
import re
import threading
import time
from collections import deque
from urllib.error import HTTPError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

from flask import Blueprint, Response, jsonify, request, stream_with_context
from werkzeug.security import check_password_hash

updates = Blueprint("private_updates", __name__, url_prefix="/updates/private")
_attempts = deque()
_lock = threading.Lock()


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def github_open(url, *, binary=False):
    token = os.environ["FLYSCAN_RELEASES_TOKEN"]
    headers = {
        "Accept": "application/octet-stream" if binary else "application/vnd.github+json",
        "User-Agent": "Flyscan-updates",
    }
    opener = build_opener(_NoRedirect)
    for _ in range(4):
        parsed = urlparse(url)
        if parsed.scheme != "https" or parsed.hostname not in {
            "api.github.com",
            "release-assets.githubusercontent.com",
            "objects.githubusercontent.com",
        }:
            raise ValueError("Unexpected asset host")
        safe_headers = dict(headers)
        if parsed.hostname == "api.github.com":
            safe_headers["Authorization"] = f"Bearer {token}"
        try:
            return opener.open(Request(url, headers=safe_headers), timeout=30)
        except HTTPError as exc:
            if exc.code not in {301, 302, 303, 307, 308}:
                raise
            url = exc.headers["Location"]
            exc.close()
    raise ValueError("Too many asset redirects")


@updates.before_request
def authenticate():
    password_hash = os.environ.get("FLYSCAN_PRIVATE_PASSWORD_HASH")
    if not password_hash or not os.environ.get("FLYSCAN_RELEASES_TOKEN"):
        return jsonify(error="Private updates are not configured."), 503
    # Bound expensive password checks and upstream requests, including failed attempts.
    now = time.monotonic()
    with _lock:
        while _attempts and _attempts[0] < now - 60:
            _attempts.popleft()
        if len(_attempts) >= 30:
            return jsonify(error="Try again shortly."), 429, {"Retry-After": "60"}
        _attempts.append(now)
    header = request.headers.get("Authorization", "")
    encoded = header.removeprefix("Bearer ") if header.startswith("Bearer ") else ""
    try:
        supplied = base64.b64decode(encoded, validate=True).decode("utf-8") if encoded else ""
    except (ValueError, UnicodeError, binascii.Error):
        supplied = ""
    if not supplied or len(supplied) > 512 or not check_password_hash(password_hash, supplied):
        return (
            jsonify(error="Private update password required."),
            401,
            {"WWW-Authenticate": "Bearer"},
        )


def release(tag="latest"):
    repository = os.environ.get("FLYSCAN_PRIVATE_RELEASE_REPOSITORY", "santistebanc/flyscan")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ValueError("Invalid private release repository")
    path = "latest" if tag == "latest" else f"tags/{tag}"
    with github_open(f"https://api.github.com/repos/{repository}/releases/{path}") as response:
        data = json.load(response)
    if data.get("draft") or data.get("prerelease"):
        raise ValueError("Release is not published")
    return data


def asset(data, name):
    return next(a for a in data["assets"] if a["name"] == name)


@updates.get("/latest.json")
def latest():
    try:
        data = release()
        with github_open(asset(data, "latest.json")["url"], binary=True) as response:
            manifest = json.load(response)
        version = manifest["version"]
        if not re.fullmatch(r"\d+\.\d+\.\d+", version) or data["tag_name"] != f"v{version}":
            raise ValueError("Release version mismatch")
        origin = os.environ["FLYSCAN_UPDATE_ORIGIN"].rstrip("/")
        if not origin.startswith("https://"):
            raise ValueError("Updates require HTTPS")
        for platform in manifest["platforms"].values():
            name = platform["url"].rsplit("/", 1)[-1]
            if name != f"Flyscan-Private-{version}-windows-x64-setup.exe":
                raise ValueError("Unexpected private installer")
            asset(data, name)
            platform["url"] = f"{origin}/updates/private/v{version}/{name}"
        return jsonify(manifest)
    except (HTTPError, OSError, ValueError, KeyError, StopIteration):
        return jsonify(error="Private release is not available yet."), 503


@updates.get("/<tag>/<name>")
def download(tag, name):
    if (
        not re.fullmatch(r"v\d+\.\d+\.\d+", tag)
        or name != f"Flyscan-Private-{tag[1:]}-windows-x64-setup.exe"
    ):
        return jsonify(error="Unknown installer."), 404
    try:
        upstream = github_open(asset(release(tag), name)["url"], binary=True)
    except (HTTPError, OSError, ValueError, KeyError, StopIteration):
        return jsonify(error="Installer is unavailable."), 503

    def chunks():
        try:
            while chunk := upstream.read(1024 * 1024):
                yield chunk
        finally:
            upstream.close()

    response = Response(stream_with_context(chunks()), mimetype="application/octet-stream")
    if upstream.headers.get("Content-Length"):
        response.headers["Content-Length"] = upstream.headers["Content-Length"]
    response.headers["Content-Disposition"] = f'attachment; filename="{name}"'
    response.call_on_close(upstream.close)
    return response


@updates.after_request
def no_cache(response):
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response

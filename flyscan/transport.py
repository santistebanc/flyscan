"""Private JSON-lines curl_cffi worker. No flight or application policy lives here."""

from __future__ import annotations

import base64
import json
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

from curl_cffi import requests


def main():
    sessions = {}
    guard = threading.Lock()
    output = threading.Lock()

    def reply(message):
        with output:
            sys.stdout.write(json.dumps(message, ensure_ascii=True) + "\n")
            sys.stdout.flush()

    def execute(message):
        request_id = message.get("id")
        try:
            operation = message["op"]
            session_id = message.get("session")
            if operation == "open":
                session = requests.Session(impersonate=message.get("impersonate", "chrome"))
                for cookie in message.get("cookies", []):
                    session.cookies.set(
                        cookie["name"],
                        cookie["value"],
                        domain=cookie.get("domain", ""),
                        path=cookie.get("path", "/"),
                        secure=bool(cookie.get("secure", False)),
                    )
                    expiry = cookie.get("expires")
                    if isinstance(expiry, (int, float)) and expiry > 0:
                        for stored in session.cookies.jar:
                            if (stored.name, stored.domain, stored.path) == (
                                cookie["name"],
                                cookie.get("domain", ""),
                                cookie.get("path", "/"),
                            ):
                                stored.expires = int(expiry)
                                stored.discard = False
                with guard:
                    if session_id in sessions:
                        session.close()
                        raise ValueError("session already exists")
                    sessions[session_id] = session
                result = None
            elif operation == "close":
                with guard:
                    session = sessions.pop(session_id, None)
                if session is not None:
                    session.close()
                result = None
            elif operation == "request":
                if os.environ.get("FLYSCAN_OFFLINE") == "1":
                    raise RuntimeError("network requests are disabled in offline mode")
                with guard:
                    session = sessions[session_id]
                options = message.get("options", {})
                allowed = {"headers", "params", "json", "data", "timeout", "allow_redirects"}
                if set(options) - allowed:
                    raise ValueError("unsupported request options")
                options.setdefault("timeout", 60)
                response = session.request(message["method"], message["url"], **options)
                result = {
                    "status": response.status_code,
                    "url": response.url,
                    "headers": list(response.headers.multi_items()),
                    "body": base64.b64encode(response.content).decode("ascii"),
                    "cookies": [
                        {
                            "name": c.name,
                            "value": c.value,
                            "domain": c.domain,
                            "path": c.path,
                            "secure": c.secure,
                            "expires": c.expires,
                        }
                        for c in session.cookies.jar
                    ],
                }
            else:
                raise ValueError("unknown transport operation")
            reply({"id": request_id, "result": result})
        except Exception as exc:
            reply({"id": request_id, "error": {"kind": type(exc).__name__, "message": str(exc)}})

    # One request per session is enforced by the caller. Distinct sessions can run together.
    pool = ThreadPoolExecutor(max_workers=32, thread_name_prefix="http")
    try:
        for line in sys.stdin:
            try:
                message = json.loads(line)
                if not isinstance(message, dict):
                    raise ValueError("a request object is required")
            except (ValueError, TypeError) as exc:
                reply({"id": None, "error": {"kind": "ProtocolError", "message": str(exc)}})
                continue
            if message.get("op") == "shutdown":
                # The owning application is gone; do not leave native requests or a
                # frozen executable alive until their HTTP timeouts expire.
                os._exit(0)
            pool.submit(execute, message)
    finally:
        # Closing the private input pipe means the owning Node process is gone.
        # Native requests must not keep a frozen worker or its executable alive.
        pool.shutdown(wait=False, cancel_futures=True)
        os._exit(0)


if __name__ == "__main__":
    main()

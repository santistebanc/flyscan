"""Check the frozen service from an empty directory without scraping sources."""

import argparse
import json
import os
import secrets
import socket
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def smoke(binary: Path) -> None:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    key = secrets.token_urlsafe(32)
    environment = {**os.environ, "FLYSCAN_API_KEY": key, "PYTHONUNBUFFERED": "1"}
    # A frozen binary must not depend on the developer's Python import path.
    environment.pop("PYTHONPATH", None)
    environment.pop("PYTHONHOME", None)
    with tempfile.TemporaryDirectory(prefix="flyscan-smoke-") as directory:
        log_path = Path(directory) / "sidecar.log"
        with log_path.open("wb") as log:
            child = subprocess.Popen(
                [
                    str(binary.resolve()),
                    "--port",
                    str(port),
                    "--exit-with-parent",
                    str(os.getpid()),
                ],
                cwd=directory,
                env=environment,
                stdout=log,
                stderr=log,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
            try:

                def request(path, authenticated=True, method="GET", headers=None):
                    merged = {"Authorization": f"Bearer {key}"} if authenticated else {}
                    merged.update(headers or {})
                    try:
                        with urlopen(
                            Request(
                                f"http://127.0.0.1:{port}{path}", headers=merged, method=method
                            ),
                            timeout=2,
                        ) as response:
                            return response.status, response.read(), response.headers
                    except HTTPError as error:
                        return error.code, error.read(), error.headers

                deadline = time.monotonic() + 45
                while time.monotonic() < deadline:
                    if child.poll() is not None:
                        raise RuntimeError(
                            f"Sidecar exited ({child.returncode}). {log_path.read_text(errors='replace')}"
                        )
                    try:
                        status, body, _ = request("/v1/health")
                        if status == 200:
                            assert json.loads(body)["status"] == "ok"
                            break
                    except (URLError, TimeoutError):
                        pass
                    time.sleep(0.15)
                else:
                    raise RuntimeError("Sidecar failed its 45-second startup deadline")
                assert request("/v1/health", authenticated=False)[0] == 401
                assert request("/v1/health?api_key=" + key, authenticated=False)[0] == 401
                assert (
                    request("/v1/searches/missing/events?api_key=" + key, authenticated=False)[0]
                    == 404
                )
                status, _, headers = request(
                    "/v1/health",
                    authenticated=False,
                    method="OPTIONS",
                    headers={
                        "Origin": "http://tauri.localhost",
                        "Access-Control-Request-Headers": "authorization",
                    },
                )
                assert status == 200 and "Authorization" in headers["Access-Control-Allow-Headers"]
                identity = json.loads(request("/v1/version")[1])
                assert identity["mode"] == "desktop"
                sources = {row["name"] for row in json.loads(request("/v1/sources")[1])}
                assert {"momondo", "ff-kayak"} <= sources
                assert request("/")[0] == 200, "Missing bundled frontend"
                status, body, _ = request("/v1/flights?all=1&start=2026-12-21")
                assert status == 200, (
                    f"Stored result API failed ({status}): {body.decode(errors='replace')}"
                )
                assert (Path(directory) / "flights.db").is_file(), (
                    "Database not created in the writable data directory"
                )
                assert "development server" not in log_path.read_text(errors="replace").lower()
                print(
                    "Frozen sidecar passed: startup, session auth, EventSource auth, CORS, bundled UI, database and production server."
                )
            finally:
                if os.name == "nt":
                    subprocess.run(
                        ["taskkill", "/PID", str(child.pid), "/T", "/F"],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                    )
                elif child.poll() is None:
                    child.terminate()
                child.wait(timeout=10)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    args = parser.parse_args()
    smoke(args.binary)

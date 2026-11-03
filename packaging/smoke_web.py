"""Probe a release container on loopback without contacting any flight source."""

import json
import time
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def smoke():
    opener = build_opener(NoRedirect)

    def request(path):
        try:
            response = opener.open(Request("http://127.0.0.1:8080" + path), timeout=2)
        except HTTPError as response:
            return response.code, response.read(), response.headers
        with response:
            return response.status, response.read(), response.headers

    deadline = time.monotonic() + 30
    while True:
        try:
            assert request("/v1/health")[0] == 200
            break
        except (URLError, TimeoutError):
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.25)
    assert request("/")[0] == 200
    identity = json.loads(request("/v1/version")[1])
    assert identity["mode"] == "web"
    sources = {item["name"] for item in json.loads(request("/v1/sources")[1])}
    assert sources and not ({"ff-kayak", "momondo"} & sources)
    print(f"Web container passed: {identity['version']}, bundled UI and source policy.")


if __name__ == "__main__":
    smoke()

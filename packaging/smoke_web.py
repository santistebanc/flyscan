"""Probe a release container on loopback without contacting any flight source."""

import json
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def smoke(edition):
    opener = build_opener(NoRedirect)

    def request(path, data=None, cookie=""):
        headers = {"Cookie": cookie}
        if data is not None:
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        try:
            response = opener.open(
                Request("http://127.0.0.1:8080" + path, data=data, headers=headers), timeout=2
            )
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
    cookie = ""
    if edition == "private":
        assert request("/")[0] == 302
        assert request("/v1/sources")[0] == 401
        status, _, headers = request("/login", b"password=ci-only-password")
        assert status == 302
        cookie = headers["Set-Cookie"].split(";", 1)[0]
    assert request("/", cookie=cookie)[0] == 200
    identity = json.loads(request("/v1/version", cookie=cookie)[1])
    assert identity["edition"] == edition and identity["mode"] == "web"
    sources = {item["name"] for item in json.loads(request("/v1/sources", cookie=cookie)[1])}
    assert (
        ({"ff-kayak", "momondo"} <= sources)
        if edition == "private"
        else not ({"ff-kayak", "momondo"} & sources)
    )
    assert request("/updates/private/latest.json")[0] in {401, 503}
    print(
        f"Web container passed: {identity['version']} {edition}, bundled UI, source policy and private boundaries."
    )


if __name__ == "__main__":
    smoke(sys.argv[1])

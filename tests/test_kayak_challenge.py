"""A block must be recognised as a block, not as a broken parser.

This engine refuses in two different shapes. The poll answers a flagged request
with a 403 and a JSON body naming the captcha. The *search page* just redirects
to `/security/check` and answers 200 with markup that has no form token in it —
which arrived as "search page carried no form token", read like the site had
changed its HTML, and was **retried**, because `SourceError` is retryable. One
search of eight trips became twenty-eight attempts aimed at a host that had
just asked for a human.
"""

import unittest
from datetime import date

from tests import quiet_errorlog
from flight_scraper.models import SearchQuery
from flight_scraper.sources import REGISTRY
from flight_scraper.sources.base import ChallengeRequired, SourceError

QUERY = SearchQuery(origin="BER", destination="SLP", depart=date(2026, 12, 23),
                    ret=date(2026, 12, 27))

# What the real page looks like, trimmed: a 200, no form token, and the
# security path in the URL it landed on.
BLOCKED = """<!doctype html><html><head><title>Security check</title></head>
<body><h1>Please confirm you are a person</h1></body></html>"""

ORDINARY = """<!doctype html><html><body>
<script>window.__data = {"formtoken":"abc123"};</script></body></html>"""

CHANGED = """<!doctype html><html><body>
<script>window.__data = {"something_else":"we renamed it"};</script></body></html>"""


class Fake:
    def __init__(self, text: str, url: str, status: int = 200):
        self.status_code = status
        self.content = text.encode()
        self.text = text
        self.url = url


class FakeSession:
    def __init__(self, page):
        self.page = page
        self.cookies = self

    def set(self, *a, **k):
        pass

    def get(self, url, **kwargs):
        return self.page

    def post(self, url, **kwargs):
        raise AssertionError("a blocked search must never reach the poll")


class SecurityPage(unittest.TestCase):
    def setUp(self):
        quiet_errorlog(self)

    def source(self, page):
        source = REGISTRY["ff-kayak"](timeout=1, retries=1)
        source.session = lambda *a, **k: FakeSession(page)   # type: ignore[method-assign]
        return source

    def test_a_redirect_to_the_security_page_is_a_challenge(self):
        source = self.source(Fake(
            BLOCKED, "https://ie-kayak.flightsfinder.com/security/check?out=%2Fflights",
        ))
        with self.assertRaises(ChallengeRequired) as caught:
            source.search(QUERY)
        self.assertIn("/security/check", caught.exception.url)

    def test_a_challenge_is_never_retried(self):
        """The point of the distinction: retrying is actively harmful here."""
        source = self.source(Fake(
            BLOCKED, "https://ie-kayak.flightsfinder.com/security/check",
        ))
        with self.assertRaises(ChallengeRequired):
            source.run(QUERY)          # `run` re-raises rather than retrying

    def test_markup_that_really_did_change_is_still_an_ordinary_failure(self):
        """Not everything without a token is a block, and saying so would hide
        the day this site renames its form token."""
        source = self.source(Fake(
            CHANGED, "https://ie-kayak.flightsfinder.com/flights/BER-SLP/2026-12-23",
        ))
        result = source.run(QUERY)
        self.assertIn("no form token", result.error)
        self.assertNotIn("challenge", result.error.lower())

    def test_an_ordinary_page_gets_past_the_check(self):
        source = self.source(Fake(
            ORDINARY, "https://ie-kayak.flightsfinder.com/flights/BER-SLP/2026-12-23",
        ))
        # It reaches the poll, which the fake session refuses — proof that the
        # security check did not stand in the way.
        with self.assertRaises(AssertionError):
            source.search(QUERY)


if __name__ == "__main__":
    unittest.main()

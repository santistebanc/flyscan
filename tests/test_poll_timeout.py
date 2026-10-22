"""A slow poll must not cost us the results we already have.

`Source.run` answers any exception by re-running `search` from the top, which
on these portals means a fresh search page and a fresh poll cycle. So a
timeout that escapes the poll loop does not just lose the offers collected so
far — it pays for the whole search a second time. These tests pin the
behaviour with a fake session, since the real one is what times out.
"""

import unittest
from datetime import date
from typing import List
from unittest import mock

from flight_scraper.models import SearchQuery
from flight_scraper.sources.flightsfinder import FlightsFinderSky
from tests import quiet_errorlog

QUERY = SearchQuery(origin="BER", destination="CDG", depart=date(2026, 9, 21))

# The smallest page that carries a polling block, and one result card in the
# shape the parser expects.
PAGE = """
<html><body><script>
$.ajax({type: 'POST', url: '/portal/sky/poll', dataType: 'text',
        data: { 'session': 'abc123', 'suuid': 'deadbeef' }})
</script></body></html>
"""

# `data-price` is in cents, and a card needs one `div.stops` block per
# direction carrying the endpoints. That is the whole minimum: everything else
# the parser reads is optional and fills in from the modal.
CARD = """
<div class="list-item" data-price="12345" data-best="abc">
  <div class="stops">
    <p>07:00 BER</p>
    <p>09:05 CDG</p>
  </div>
</div>
"""


class Fake:
    """Stands in for a curl_cffi response."""

    def __init__(self, text: str, status: int = 200):
        self.status_code = status
        self.content = text.encode()
        self.text = text


class FakeSession:
    """Serves the search page, then whatever the test queued for the polls."""

    def __init__(self, polls):
        self.polls = list(polls)
        self.posts = 0
        self.cookies = self

    def set(self, *args, **kwargs):  # the challenge store writes here
        pass

    def get(self, url, **kwargs):
        return Fake(PAGE)

    def post(self, url, **kwargs):
        self.posts += 1
        answer = self.polls.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return Fake(answer)


def poll_body(done: str, count: str, markup: str) -> str:
    """The pipe-delimited payload: field 0 done, 1 count, 6 the HTML."""
    return "|".join([done, count, "", "", "", "", markup])


class PollTimeout(unittest.TestCase):
    def setUp(self):
        quiet_errorlog(self)
        patch = mock.patch("flight_scraper.sources.flightsfinder.time.sleep")
        patch.start()
        self.addCleanup(patch.stop)

    def source(self, polls) -> FlightsFinderSky:
        source = FlightsFinderSky(timeout=1, retries=2)
        session = FakeSession(polls)
        source.session = lambda *a, **k: session  # type: ignore[method-assign]
        self.session = session
        return source

    def test_a_timeout_after_results_keeps_them(self):
        source = self.source(
            [
                poll_body("N", "1", CARD),
                TimeoutError("poll timed out"),
            ]
        )
        offers = source.search(QUERY)
        self.assertEqual(len(offers), 1)
        self.assertEqual(self.session.posts, 2)

    def test_a_timeout_before_any_result_still_fails(self):
        """Nothing to salvage means the error must travel, so `run` retries."""
        source = self.source([TimeoutError("poll timed out")])
        with self.assertRaises(TimeoutError):
            source.search(QUERY)

    def test_run_does_not_re_search_when_the_poll_merely_timed_out(self):
        """The whole point: one search page fetch, not two."""
        source = self.source(
            [
                poll_body("N", "1", CARD),
                TimeoutError("poll timed out"),
            ]
        )
        result = source.run(QUERY)
        self.assertEqual(result.error, "")
        self.assertEqual(len(result.offers), 1)

    def test_a_finished_poll_still_ends_the_loop(self):
        source = self.source([poll_body("Y", "1", CARD)])
        offers: List = source.search(QUERY)
        self.assertEqual(len(offers), 1)
        self.assertEqual(self.session.posts, 1)


if __name__ == "__main__":
    unittest.main()


class PollSettles(unittest.TestCase):
    """The done flag is not dependable, so a still count has to end the poll.

    `/portal/sky` was measured saying "N" to every poll of two live searches
    while the count stopped moving a third of the way in. Without this the
    search runs to its 45-second deadline re-fetching a 2.5 MB payload.
    """

    def setUp(self):
        patch = mock.patch("flight_scraper.sources.flightsfinder.time.sleep")
        patch.start()
        self.addCleanup(patch.stop)

    def source(self, polls) -> FlightsFinderSky:
        source = FlightsFinderSky(timeout=1, retries=1)
        session = FakeSession(polls)
        source.session = lambda *a, **k: session  # type: ignore[method-assign]
        self.session = session
        return source

    def test_an_unchanging_count_ends_the_poll(self):
        source = self.source(
            [
                poll_body("N", "1", CARD),  # first sighting
                poll_body("N", "1", CARD),  # same
                poll_body("N", "1", CARD),  # same again — stop here
                poll_body("N", "1", CARD),  # must never be asked for
            ]
        )
        offers = source.search(QUERY)
        self.assertEqual(len(offers), 1)
        self.assertEqual(self.session.posts, 3)

    def test_a_moving_count_keeps_polling(self):
        """Growth must not be mistaken for settling."""
        source = self.source(
            [
                poll_body("N", "1", CARD),
                poll_body("N", "2", CARD * 2),
                poll_body("N", "3", CARD * 3),
                poll_body("Y", "3", CARD * 3),
            ]
        )
        offers = source.search(QUERY)
        self.assertEqual(len(offers), 3)
        self.assertEqual(self.session.posts, 4)

    def test_markup_that_drifts_without_changing_results_still_settles(self):
        """The reason this keys on the count and not on the payload length.

        The live payload grew by ~200 bytes between polls carrying identical
        results, so byte equality would never settle.
        """
        source = self.source(
            [
                poll_body("N", "1", CARD),
                poll_body("N", "1", CARD + "<!-- a -->"),
                poll_body("N", "1", CARD + "<!-- bb -->"),
                poll_body("N", "1", CARD + "<!-- ccc -->"),
            ]
        )
        offers = source.search(QUERY)
        self.assertEqual(len(offers), 1)
        self.assertEqual(self.session.posts, 3)

    def test_an_empty_result_never_counts_as_settled(self):
        """Three polls of nothing is a search still starting up, not a finished one."""
        source = self.source(
            [
                poll_body("N", "0", ""),
                poll_body("N", "0", ""),
                poll_body("N", "0", ""),
                poll_body("Y", "1", CARD),
            ]
        )
        offers = source.search(QUERY)
        self.assertEqual(len(offers), 1)
        self.assertEqual(self.session.posts, 4)

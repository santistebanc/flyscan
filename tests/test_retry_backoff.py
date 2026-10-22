"""Retries must not come back in lockstep.

The failures worth designing for here are the correlated ones: a dropped
network or a throttled IP takes every source down at the same moment. With a
fixed backoff all six then retry on the same instant and fail together again.
"""

import unittest
from datetime import date
from unittest import mock

from flight_scraper.models import SearchQuery
from flight_scraper.sources.base import Source
from tests import quiet_errorlog

QUERY = SearchQuery(origin="BER", destination="CDG", depart=date(2026, 9, 21))


class AlwaysFails(Source):
    name = "always-fails"

    def search(self, query):
        raise TimeoutError("nope")


class Backoff(unittest.TestCase):
    def setUp(self):
        quiet_errorlog(self)

    def waits(self, retries: int = 4):
        """Every sleep one run takes while exhausting its retries."""
        source = AlwaysFails(retries=retries)
        with mock.patch("flight_scraper.sources.base.time.sleep") as slept:
            source.run(QUERY)
        return [call.args[0] for call in slept.call_args_list]

    def test_backoff_still_grows_with_each_attempt(self):
        """Jitter must not flatten the escalation, only blur it."""
        bands = self.waits()
        self.assertEqual(len(bands), 3)          # one fewer than the attempts
        for attempt, wait in enumerate(bands, start=1):
            self.assertGreaterEqual(wait, 1.5 * attempt * 0.5)
            self.assertLessEqual(wait, 1.5 * attempt * 1.5)

    def test_two_sources_failing_together_do_not_retry_together(self):
        """The whole point. Identical inputs, different waits."""
        runs = [tuple(self.waits()) for _ in range(6)]
        self.assertGreater(len(set(runs)), 1, "every run waited exactly the same")

    def test_a_source_that_succeeds_never_sleeps(self):
        class Fine(Source):
            name = "fine"

            def search(self, query):
                return []

        with mock.patch("flight_scraper.sources.base.time.sleep") as slept:
            Fine(retries=3).run(QUERY)
        slept.assert_not_called()


if __name__ == "__main__":
    unittest.main()

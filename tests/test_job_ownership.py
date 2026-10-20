"""Which queued fetches belong to the search on screen, and which are strays.

This decides what "drop them" drops, so being wrong in either direction is
expensive: too loose and it throws away the work you are waiting for, too tight
and it leaves a walked-away-from search holding the gates.

Matched on the query's own fields rather than on the label the queue displays —
a label is for reading, and two different parties can render the same string.
"""

import unittest

from flight_scraper.api import _belongs_to

SEARCH = {
    "origin": "BER", "destination": "CDG",
    "start": "2026-12-18", "end": "2026-12-20",
    "ret": "2026-12-27", "ret_end": "2026-12-30",
    "adults": "1", "children": "0", "infants": "0", "cabin": "economy",
}


def job(**over):
    base = {
        "route": "BER-CDG", "depart": "2026-12-19", "ret": "2026-12-28",
        "adults": 1, "children": 0, "infants": 0, "cabin": "economy",
    }
    base.update(over)
    return base


class Ownership(unittest.TestCase):
    def test_inside_both_ranges_belongs(self):
        self.assertTrue(_belongs_to(job(), SEARCH))

    def test_the_edges_of_the_ranges_are_inside_them(self):
        self.assertTrue(_belongs_to(job(depart="2026-12-18", ret="2026-12-27"), SEARCH))
        self.assertTrue(_belongs_to(job(depart="2026-12-20", ret="2026-12-30"), SEARCH))

    def test_a_departure_outside_the_range_is_a_stray(self):
        self.assertFalse(_belongs_to(job(depart="2026-12-21"), SEARCH))
        self.assertFalse(_belongs_to(job(depart="2026-12-17"), SEARCH))

    def test_a_return_outside_the_range_is_a_stray(self):
        """The case that started this: same dates out, different dates back."""
        self.assertFalse(_belongs_to(job(ret="2026-12-26"), SEARCH))
        self.assertFalse(_belongs_to(job(ret="2027-01-03"), SEARCH))

    def test_another_route_is_a_stray(self):
        self.assertFalse(_belongs_to(job(route="BER-SLP"), SEARCH))

    def test_another_party_is_a_stray(self):
        """The same trip for two people is a different question, not the same one."""
        self.assertFalse(_belongs_to(job(adults=2), SEARCH))
        self.assertFalse(_belongs_to(job(children=1), SEARCH))
        self.assertFalse(_belongs_to(job(cabin="business"), SEARCH))

    def test_a_one_way_search_does_not_own_a_round_trip(self):
        one_way = {**SEARCH, "ret": "", "ret_end": ""}
        self.assertFalse(_belongs_to(job(), one_way))
        self.assertTrue(_belongs_to(job(ret=""), one_way))

    def test_a_round_trip_search_does_not_own_a_one_way(self):
        self.assertFalse(_belongs_to(job(ret=""), SEARCH))

    def test_a_single_day_search_needs_no_end(self):
        """`end` empty means the range is one day wide, not unbounded."""
        one_day = {**SEARCH, "end": ""}
        self.assertTrue(_belongs_to(job(depart="2026-12-18"), one_day))
        self.assertFalse(_belongs_to(job(depart="2026-12-19"), one_day))

    def test_case_and_spacing_in_the_route_do_not_matter(self):
        self.assertTrue(_belongs_to(job(route="ber-cdg"),
                                    {**SEARCH, "origin": " ber ", "destination": "cdg"}))


if __name__ == "__main__":
    unittest.main()

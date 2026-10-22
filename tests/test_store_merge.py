"""A stored flight must be able to get better, not just wider.

Trips are written once and thereafter only *gap-filled*, which works at column
level — a source that knows the return time fills a column another source left
empty. It did not work inside a column: a segment list that existed but was
missing flight numbers counted as "known", so a parser fix never reached the
rows it would have corrected. 566 easyJet segments sat unsplit for exactly that
reason.
"""

import json
import unittest

from flight_scraper.store import _merge_segments


def blob(*segments):
    return json.dumps(list(segments))


SEGMENT = {
    "carrier": "",
    "carrier_name": "easyJet EZY5063",
    "flight_number": "",
    "origin": "BER",
    "destination": "CDG",
    "departure": "2026-09-21T07:00",
    "arrival": "2026-09-21T09:05",
    "duration_minutes": 125,
}
FIXED = {**SEGMENT, "carrier": "EZY", "carrier_name": "easyJet", "flight_number": "EZY5063"}


class MergeSegments(unittest.TestCase):
    def test_a_missing_flight_number_is_filled_in(self):
        merged = _merge_segments(blob(SEGMENT), blob(FIXED))
        self.assertIsNotNone(merged, "the fixed parse should reach the stored row")
        self.assertEqual(json.loads(merged)[0]["flight_number"], "EZY5063")
        self.assertEqual(json.loads(merged)[0]["carrier"], "EZY")

    def test_what_is_already_known_is_never_overwritten(self):
        """The rule this inherits: a source with less detail must not win."""
        poorer = {**FIXED, "flight_number": "", "duration_minutes": None}
        self.assertIsNone(_merge_segments(blob(FIXED), blob(poorer)))

    def test_a_stored_name_is_kept_even_when_the_new_one_differs(self):
        """Two sources spell a carrier differently; that is not a gap."""
        other = {**SEGMENT, "carrier_name": "EasyJet Airline", "flight_number": "U25063"}
        merged = json.loads(_merge_segments(blob(SEGMENT), blob(other)))
        self.assertEqual(merged[0]["carrier_name"], "easyJet EZY5063")
        self.assertEqual(merged[0]["flight_number"], "U25063")

    def test_a_different_itinerary_is_left_alone(self):
        """A different number of legs is a different flight detail, not an upgrade."""
        self.assertIsNone(_merge_segments(blob(SEGMENT), blob(FIXED, FIXED)))

    def test_nothing_to_do_reports_nothing_to_do(self):
        self.assertIsNone(_merge_segments(blob(FIXED), blob(FIXED)))
        self.assertIsNone(_merge_segments("[]", blob(FIXED)))
        self.assertIsNone(_merge_segments(None, None))

    def test_unreadable_json_is_survivable(self):
        self.assertIsNone(_merge_segments("{not json", blob(FIXED)))


if __name__ == "__main__":
    unittest.main()

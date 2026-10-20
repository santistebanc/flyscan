"""The captured BER-LHR-DFW-SLP route must never mix two connection schedules."""
import copy
import json
import unittest
from datetime import date
from pathlib import Path

from flight_scraper.models import Itinerary, SearchQuery
from flight_scraper.sources.kayak import Momondo
from flight_scraper.sources.travelpayouts import Travelpayouts, _elapsed_minutes
from flight_scraper.store import FlightStore, _merge_segments

FIXTURES = Path(__file__).parent / "fixtures"
QUERY = SearchQuery("BER", "SLP", date(2026, 12, 10), ret=date(2026, 12, 12))


def captured_legs():
    raw = json.loads((FIXTURES / "jetradar-ber-slp-timing.json").read_text(encoding="utf-8"))
    jet = Travelpayouts._leg(raw["segment"], raw["flight_legs"], raw["airlines"], raw["proposal"])
    raw = json.loads((FIXTURES / "momondo-ber-slp-timing.json").read_text(encoding="utf-8"))
    mom = Momondo._leg(raw["leg"], raw["legs_index"], raw["segments_index"], raw["airlines"])
    return jet, mom


class CapturedTimingTrace(unittest.TestCase):
    def test_jetradar_extracts_each_flights_elapsed_time_from_absolute_timestamps(self):
        jet, _ = captured_legs()
        self.assertEqual(jet.duration_minutes, 1931)
        self.assertEqual([s.duration_minutes for s in jet.segments], [125, 635, 138])
        self.assertEqual(jet.segments[1].flight_number, "AA81")

    def test_elapsed_time_rejects_missing_invalid_and_backwards_absolute_timestamps(self):
        for start, end in [(None, 100), (100, None), ("bad", 100), (100, 99),
                           (100, 100), (float("nan"), 200), (100, float("inf")), (True, 200)]:
            with self.subTest(start=start, end=end):
                self.assertIsNone(_elapsed_minutes(start, end))
        self.assertEqual(_elapsed_minutes("1796910600", "1796948700"), 635)
        self.assertEqual(_elapsed_minutes(0, 3600), 60)

    def test_two_real_connection_schedules_cannot_share_a_trip_key(self):
        jet, mom = captured_legs()
        self.assertEqual(jet.departure[:16], mom.departure[:16])
        self.assertEqual(jet.arrival[:16], mom.arrival[:16])
        self.assertEqual(jet.stops, mom.stops)
        self.assertEqual(mom.segments[1].flight_number, "AA6950")
        self.assertNotEqual(Itinerary(QUERY, jet).trip_key, Itinerary(QUERY, mom).trip_key)

    def test_merge_does_not_copy_the_other_connections_duration_into_AA81(self):
        jet, mom = captured_legs()
        jet.segments[1].duration_minutes = None  # What the original parser discarded.
        old = json.dumps([s.to_dict() for s in jet.segments])
        incoming = json.dumps([s.to_dict() for s in mom.segments])
        self.assertIsNone(_merge_segments(old, incoming), "different departure clocks are different flights")

    def test_store_keeps_both_real_itineraries_instead_of_creating_a_hybrid(self):
        jet, mom = captured_legs()
        store = FlightStore(":memory:")
        self.addCleanup(store.close)
        with store.conn:
            first = store._upsert_trip(Itinerary(QUERY, jet))
            second = store._upsert_trip(Itinerary(QUERY, mom))
        self.assertNotEqual(first, second)
        rows = store.conn.execute("SELECT depart_segments FROM trips ORDER BY id").fetchall()
        self.assertEqual(len(rows), 2)
        self.assertEqual(json.loads(rows[0][0])[1]["duration_minutes"], 635)
        self.assertEqual(json.loads(rows[1][0])[1]["duration_minutes"], 625)

    def test_codeshare_names_and_iso_seconds_do_not_split_the_same_schedule(self):
        jet, _ = captured_legs()
        other = copy.deepcopy(jet)
        for s in other.segments:
            s.carrier = "BA"
            s.flight_number = "BA9999"
            s.departure += ":00"
            s.arrival += ":00"
        self.assertEqual(Itinerary(QUERY, jet).trip_key, Itinerary(QUERY, other).trip_key)

    def test_matching_schedules_still_fill_missing_duration_without_splitting_codeshares(self):
        jet, _ = captured_legs()
        other = copy.deepcopy(jet)
        jet.segments[1].duration_minutes = None
        for s in other.segments:
            s.carrier = "BA"
            s.flight_number = "BA9999"
            s.departure += ":00"
            s.arrival += ":00"
        merged = _merge_segments(json.dumps([s.to_dict() for s in jet.segments]),
                                 json.dumps([s.to_dict() for s in other.segments]))
        self.assertEqual(json.loads(merged)[1]["duration_minutes"], 635)
        self.assertEqual(json.loads(merged)[1]["flight_number"], "AA81")

    def test_return_connections_also_belong_to_trip_identity(self):
        jet, mom = captured_legs()
        self.assertNotEqual(Itinerary(QUERY, jet, jet).trip_key, Itinerary(QUERY, jet, mom).trip_key)


if __name__ == "__main__":
    unittest.main()

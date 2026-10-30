"""A codeshare is one flight sold under several numbers; each price keeps its seller's."""

import json
import sqlite3
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest import mock

from flyscan.api import _stored_row
from flyscan.models import Itinerary, Leg, Offer, SearchQuery
from flyscan.sources.travelpayouts import Travelpayouts
from flyscan.store import FlightStore

FIXTURES = Path(__file__).parent / "fixtures"
QUERY = SearchQuery("BER", "SLP", date(2026, 11, 27), ret=date(2026, 12, 23))
RAW = json.loads((FIXTURES / "jetradar-slp-ber-codeshare.json").read_text(encoding="utf-8"))


def captured_return(seller):
    """The return leg as one seller sells it, parsed from the captured response."""
    return Travelpayouts._leg(
        RAW["segment"], RAW["flight_legs"], RAW["airlines"], RAW["proposals"][seller]
    )


def offer(seller):
    outbound = Leg("BER", "SLP", "2026-11-27T06:10", "2026-11-27T20:57", stops=2)
    sold = Offer(
        Itinerary(QUERY, outbound, captured_return(seller)),
        "jetradar",
        RAW["proposals"][seller]["price"]["value"],
        "EUR",
        agent=seller,
    )
    sold.price_eur = sold.price
    return sold


class CodeshareCarriers(unittest.TestCase):
    def test_jetradar_names_the_sellers_carrier_and_who_operates_the_flight(self):
        farera = captured_return("Farera").segments
        self.assertEqual([s.flight_number for s in farera], ["UA2405", "LH9241", "LH4064"])
        self.assertEqual(farera[1].carrier_name, "Lufthansa")
        self.assertEqual(
            (farera[1].operating_carrier_name, farera[1].operating_flight_number),
            ("United Airlines", "UA102"),
        )
        self.assertEqual(farera[2].operating_carrier_name, "Lufthansa City Airlines")
        self.assertEqual(farera[0].operating_flight_number, "", "UA sells UA2405 itself")

        city = captured_return("City.Travel").segments
        self.assertEqual(city[1].flight_number, "UA102")
        self.assertEqual(city[1].operating_flight_number, "")

    def test_both_sellers_share_one_trip_shown_with_the_cheapest_sellers_codes(self):
        for order in (["City.Travel", "Farera"], ["Farera", "City.Travel"]):
            with self.subTest(saved_first=order[0]):
                store = FlightStore(":memory:")
                self.addCleanup(store.close)
                with mock.patch("flyscan.store.fx.get_rates"):
                    for seller in order:
                        fetch = store.begin_fetch(QUERY, f"jetradar-{seller}")
                        store.complete_fetch(fetch, [offer(seller)])
                [trip] = store.browse("BER", "SLP", "2026-11-27", ret="2026-12-23")
                self.assertEqual([o["agent"] for o in trip["offers"]], ["Farera", "City.Travel"])
                row = _stored_row(trip)
                houston = row["inbound"]["segments"][1]
                self.assertEqual(houston["flight_number"], "LH9241")
                self.assertEqual(houston["carrier_name"], "Lufthansa")
                self.assertEqual(houston["operating_carrier_name"], "United Airlines")
                self.assertEqual(row["best"]["agent"], "Farera")

    def test_offers_rebuilt_for_a_run_keep_their_own_sellers_codes(self):
        store = FlightStore(":memory:")
        self.addCleanup(store.close)
        with mock.patch("flyscan.store.fx.get_rates"):
            for seller in ("City.Travel", "Farera"):
                store.complete_fetch(
                    store.begin_fetch(QUERY, f"jetradar-{seller}"), [offer(seller)]
                )
        numbers = {
            o.agent: o.itinerary.inbound.segments[1].flight_number
            for o in store.offers_for_search(QUERY)
        }
        self.assertEqual(numbers, {"Farera": "LH9241", "City.Travel": "UA102"})

    def test_a_database_from_before_seller_codes_opens_and_shows_the_stored_flights(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "flights.db"
            store = FlightStore(path)
            with mock.patch("flyscan.store.fx.get_rates"):
                store.complete_fetch(store.begin_fetch(QUERY, "jetradar"), [offer("City.Travel")])
            store.close()
            old = sqlite3.connect(path)
            old.execute("ALTER TABLE offers DROP COLUMN codes")
            old.execute("PRAGMA user_version = 1")
            old.commit()
            old.close()

            store = FlightStore(path)
            try:
                [trip] = store.browse("BER", "SLP", "2026-11-27", ret="2026-12-23")
                self.assertEqual(trip["return_segments"][1]["flight_number"], "UA102")
                self.assertEqual(store.conn.execute("PRAGMA user_version").fetchone()[0], 2)
            finally:
                store.close()


if __name__ == "__main__":
    unittest.main()

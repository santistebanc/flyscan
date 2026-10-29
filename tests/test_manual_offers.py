"""Prices a person adds by hand sit beside the scraped ones, and never get asked."""

import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest import mock

from flight_scraper.models import Itinerary, Leg, Offer, SearchQuery, Segment
from flight_scraper.sources import DEFAULT_SOURCES
from flight_scraper.store import MANUAL_SOURCE, FlightStore
from flight_scraper.web import create_app

QUERY = SearchQuery("BER", "LON", date(2026, 12, 21))
SEGMENT = Segment(
    carrier="FR",
    carrier_name="Ryanair",
    flight_number="FR146",
    origin="BER",
    destination="STN",
    departure="2026-12-21T16:40",
    arrival="2026-12-21T17:45",
    duration_minutes=125,
)
LEG = Leg(
    "BER",
    "STN",
    departure=SEGMENT.departure,
    arrival=SEGMENT.arrival,
    duration_minutes=125,
    stops=0,
    airlines="Ryanair",
    flight_numbers="FR146",
    segments=[SEGMENT],
)
SEARCH = {"origin": "BER", "destination": "LON", "start": "2026-12-21"}
TYPED = {
    "flight_number": "fr 146",
    "origin": "ber",
    "destination": "STN",
    "departure": "2026-12-21T16:40",
    "arrival": "2026-12-21T17:45",
    "duration_minutes": 125,
}


class ManualOffers(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.db = str(Path(self.directory.name) / "flights.db")
        store = FlightStore(self.db)
        offer = Offer(Itinerary(QUERY, LEG), "momondo", 80, "EUR", agent="Kiwi", price_eur=80)
        with mock.patch("flight_scraper.store.fx.get_rates"):
            store.complete_fetch(store.begin_fetch(QUERY, "momondo"), [offer])
        self.trip_key = offer.trip_key
        store.close()
        self.client = create_app().test_client()

    def tearDown(self):
        self.directory.cleanup()

    def flights(self, **extra):
        return self.client.get("/v1/flights", query_string={**SEARCH, "db": self.db, **extra}).json[
            "results"
        ]

    def add(self, **body):
        return self.client.post("/v1/manual-offers", json={"db": self.db, **body})

    def test_a_price_on_a_stored_flight_becomes_another_seller(self):
        added = self.add(
            trip_key=self.trip_key,
            origin="BER",
            destination="LON",
            depart="2026-12-21",
            price=55,
            agent="ryanair.com",
        )
        self.assertEqual(added.status_code, 201)
        (row,) = self.flights()
        self.assertEqual(row["best"]["source"], MANUAL_SOURCE)
        self.assertEqual(row["best"]["agent"], "ryanair.com")
        self.assertEqual(row["best"]["entry_id"], added.json["entry_id"])
        self.assertTrue(row["best"]["added_at"])
        self.assertEqual(row["source_count"], 2)
        self.assertNotIn("entry_id", row["offers"][1], "scraped offers cannot be edited")

    def test_a_typed_flight_with_the_same_times_joins_the_stored_one(self):
        added = self.add(origin="BER", destination="LON", outbound=[TYPED], price=60)
        self.assertEqual(added.status_code, 201, added.json)
        self.assertEqual(added.json["trip_key"], self.trip_key)
        self.assertEqual(len(self.flights()), 1)

    def test_a_typed_flight_with_a_connection_is_a_new_flight(self):
        first = {
            **TYPED,
            "destination": "DUB",
            "arrival": "2026-12-21T18:10",
            "duration_minutes": None,
        }
        second = {
            "flight_number": "EI152",
            "carrier_name": "Aer Lingus",
            "origin": "DUB",
            "destination": "LHR",
            "departure": "2026-12-21T19:00",
            "arrival": "2026-12-21T20:20",
        }
        added = self.add(origin="BER", destination="LON", outbound=[first, second], price=99)
        self.assertEqual(added.status_code, 201, added.json)
        typed = next(r for r in self.flights() if r["trip_key"] == added.json["trip_key"])
        leg = typed["outbound"]
        self.assertEqual((leg["origin_airport"], leg["destination_airport"]), ("BER", "LHR"))
        self.assertEqual(leg["stops"], 1)
        self.assertEqual(leg["airlines"], "FR, Aer Lingus")
        # 1h30 by the clock, a 50-minute connection, then 1h20.
        self.assertEqual(leg["duration"], "3h 40m")

    def test_a_price_for_another_party_shows_only_for_that_party(self):
        self.add(
            trip_key=self.trip_key,
            origin="BER",
            destination="LON",
            depart="2026-12-21",
            adults=2,
            price=150,
        )
        self.assertEqual([o["source"] for o in self.flights()[0]["offers"]], ["momondo"])
        self.assertEqual(
            [o["source"] for o in self.flights(adults=2)[0]["offers"]], [MANUAL_SOURCE]
        )

    def test_editing_and_deleting_touch_only_that_price(self):
        added = self.add(origin="BER", destination="LON", outbound=[TYPED], price=60).json
        entry = added["entry_id"]
        changed = self.client.patch(
            f"/v1/manual-offers/{entry}", json={"db": self.db, "price": 45, "agent": "Ryanair"}
        )
        self.assertEqual(changed.status_code, 200)
        self.assertEqual(self.flights()[0]["best"]["price_base"], 45)
        self.assertEqual(
            self.client.delete(
                f"/v1/manual-offers/{entry}", query_string={"db": self.db}
            ).status_code,
            200,
        )
        (row,) = self.flights()
        self.assertEqual([o["source"] for o in row["offers"]], ["momondo"])
        self.assertEqual(
            self.client.delete(
                f"/v1/manual-offers/{entry}", query_string={"db": self.db}
            ).status_code,
            404,
        )

    def test_deleting_the_only_price_on_a_typed_flight_removes_the_flight(self):
        other = {**TYPED, "departure": "2026-12-21T07:00", "arrival": "2026-12-21T08:05"}
        entry = self.add(origin="BER", destination="LON", outbound=[other], price=70).json
        self.assertEqual(len(self.flights()), 2)
        self.client.delete(f"/v1/manual-offers/{entry['entry_id']}", query_string={"db": self.db})
        self.assertEqual([r["trip_key"] for r in self.flights()], [self.trip_key])

    def test_a_scraped_fetch_cannot_be_edited_or_deleted_as_an_entry(self):
        store = FlightStore(self.db)
        try:
            scraped = store.conn.execute("SELECT id FROM fetches").fetchone()["id"]
        finally:
            store.close()
        self.assertEqual(
            self.client.patch(
                f"/v1/manual-offers/{scraped}", json={"db": self.db, "price": 1}
            ).status_code,
            404,
        )
        self.assertEqual(
            self.client.delete(
                f"/v1/manual-offers/{scraped}", query_string={"db": self.db}
            ).status_code,
            404,
        )
        self.assertEqual(len(self.flights()), 1)

    def test_bad_entries_are_refused_with_a_reason(self):
        cases = [
            {"outbound": [TYPED], "price": 0},
            {"outbound": [{**TYPED, "origin": "Berlin"}], "price": 10},
            {
                "outbound": [{**TYPED, "arrival": "2026-12-21T15:00", "duration_minutes": None}],
                "price": 10,
            },
            {"outbound": [], "price": 10},
        ]
        for body in cases:
            response = self.add(origin="BER", destination="LON", **body)
            self.assertEqual(response.status_code, 400, body)
            self.assertTrue(response.json["error"])
        missing = self.add(
            trip_key="nope", origin="BER", destination="LON", depart="2026-12-21", price=5
        )
        self.assertEqual(missing.status_code, 404)

    def trips(self, **filters):
        return self.client.get("/v1/trips", query_string={"db": self.db, **filters}).json["results"]

    def test_suggestions_come_from_every_search_and_match_while_typing(self):
        # A trip stored by a different search, for a different party.
        other = SearchQuery("BER", "DUB", date(2026, 12, 22), adults=2)
        segment = Segment(
            carrier="U2",
            carrier_name="easyJet",
            flight_number="U25063",
            origin="BER",
            destination="DUB",
            departure="2026-12-22T07:00",
            arrival="2026-12-22T08:30",
            duration_minutes=150,
        )
        leg = Leg("BER", "DUB", segment.departure, segment.arrival, 150, 0, segments=[segment])
        store = FlightStore(self.db)
        try:
            with mock.patch("flight_scraper.store.fx.get_rates"):
                store.complete_fetch(
                    store.begin_fetch(other, "momondo"),
                    [Offer(Itinerary(other, leg), "momondo", 90, "EUR", price_eur=90)],
                )
        finally:
            store.close()

        self.assertEqual(len(self.trips()), 2)
        self.assertEqual(
            [t["outbound"]["flight_numbers"] for t in self.trips(number="FR1")], ["FR146"]
        )
        # The digits find the flight whichever airline's code is typed.
        self.assertEqual(len(self.trips(number="EC5063")), 1)
        self.assertEqual(len(self.trips(number="5063")), 1)
        self.assertEqual(len(self.trips(airport="DUB")), 1)
        self.assertEqual(len(self.trips(airport=["BER", "STN"])), 1)
        self.assertEqual(len(self.trips(day="2026-12-22")), 1)
        self.assertEqual(self.trips(round="1"), [])
        # Prices only for the party asked about; the trip itself regardless.
        (dublin,) = self.trips(airport="DUB")
        self.assertEqual(dublin["offers"], [])
        (dublin,) = self.trips(airport="DUB", adults=2)
        self.assertEqual(dublin["best"]["price_base"], 90)

    def test_the_manual_source_is_listed_but_never_asked(self):
        listed = {s["name"]: s for s in self.client.get("/v1/sources").json}
        self.assertFalse(listed[MANUAL_SOURCE]["fetchable"])
        self.assertTrue(all(listed[name]["fetchable"] for name in DEFAULT_SOURCES))
        self.assertNotIn(MANUAL_SOURCE, DEFAULT_SOURCES)
        self.add(origin="BER", destination="LON", outbound=[TYPED], price=60)
        status = self.client.get("/v1/flights", query_string={**SEARCH, "db": self.db}).json[
            "sources"
        ]
        self.assertNotIn(MANUAL_SOURCE, [s["source"] for s in status])


if __name__ == "__main__":
    unittest.main()

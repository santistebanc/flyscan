"""The desktop compares all matching flights, beyond the old display limits."""
import tempfile
import unittest
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from flight_scraper.aggregate import merge
from flight_scraper.jobs import Job
from flight_scraper.models import Itinerary, Leg, Offer, SearchQuery
from flight_scraper.searches import execute_search
from flight_scraper.store import FlightStore
from flight_scraper.web import create_app


QUERY = SearchQuery("BER", "CDG", date(2026, 12, 21))


def offers(count):
    result = []
    for index in range(count):
        leg = Leg("BER", "CDG", departure=f"2026-12-21T{index // 60:02}:{index % 60:02}",
                  arrival="2026-12-22T12:00", duration_minutes=60 + index)
        offer = Offer(Itinerary(QUERY, leg), "test", index + 10, "EUR")
        offer.price_eur = index + 10
        result.append(offer)
    return result


class FullFlightData(unittest.TestCase):
    def test_unlimited_stored_read_includes_extremes_beyond_both_previous_limits(self):
        with tempfile.TemporaryDirectory() as directory:
            db = str(Path(directory) / "flights.db")
            store = FlightStore(db)
            try:
                with mock.patch("flight_scraper.store.fx.get_rates"):
                    store.complete_fetch(store.begin_fetch(QUERY, "test"), offers(1105))
                self.assertEqual(len(store.browse(limit=25)), 25)
                self.assertEqual(len(store.browse(limit=None)), 1105)
            finally:
                store.close()
            client = create_app().test_client()
            filters = {"db": db, "origin": "BER", "destination": "CDG", "start": "2026-12-21"}
            response = client.get("/v1/flights", query_string={**filters, "limit": 0})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json["count"], 1105)
            self.assertEqual(response.json["results"][-1]["best"]["price_base"], 1114)
            self.assertEqual(client.get("/v1/flights", query_string={**filters, "all": 1, "limit": 1000}).json["count"], 1105)
            self.assertEqual(client.get("/v1/flights", query_string=filters).json["count"], 300)
            self.assertEqual(client.get("/v1/flights", query_string={**filters, "limit": -1}).status_code, 400)

    def test_live_partial_and_completed_updates_include_every_flight(self):
        found = offers(75)
        merged = merge(found, "EUR")
        params = dict(origin="BER", destination="CDG", start=QUERY.depart, end=QUERY.depart,
                      ret=None, ret_end=None, adults=1, children=0, infants=0, cabin="economy",
                      currency="EUR", base_currency="EUR", prefer="city", sources=["test"],
                      timeout=10, retries=0, workers=1, db=None, cache_hours=6, refresh=False)
        with tempfile.TemporaryDirectory() as directory, \
             mock.patch("flight_scraper.searches.OUT_DIR", Path(directory)), \
             mock.patch("flight_scraper.searches.resolve", side_effect=lambda code, **_: SimpleNamespace(code=code)), \
             mock.patch("flight_scraper.searches.Aggregator") as factory:
            aggregator = factory.return_value
            aggregator.stored_offers.return_value = None

            def search(*_):
                factory.call_args.kwargs["on_progress"]("day_partial", {
                    "day": QUERY.depart, "merged": merged, "offers": 75,
                    "sources_done": 1, "sources_total": 1,
                })
                yield SimpleNamespace(query=QUERY, day=QUERY.depart, offers=found,
                                      merged=merged, errors={}, elapsed=0)

            aggregator.search_trips.side_effect = search
            job = Job(id="full-results")
            job.run(lambda: execute_search(job, params))
            self.assertEqual(job.status, "done")
            updates = [event for event in job.log.subscribe() if event["event"] in ("day_partial", "day_done")]
            self.assertEqual(len(updates), 2)
            for update in updates:
                self.assertEqual(len(update["rows"]), 75)
                self.assertEqual(update["shown"], 75)

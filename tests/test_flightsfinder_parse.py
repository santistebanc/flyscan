"""What the FlightsFinder markup says, and what we read out of it.

Pure parsing: no network, no fixtures, no database. These are the cases where
the portal's own wording has caught us out.
"""

import unittest
from datetime import date
from pathlib import Path

from flyscan.capture import trim_cffi_payload
from flyscan.models import SearchQuery, Segment
from flyscan.sources.flightsfinder import _CFFLiveParser, _date_segments, _split_flight


class ModalReferences(unittest.TestCase):
    def setUp(self):
        self.markup = (
            Path(__file__).parent / "fixtures" / "ff-sky-ber-mad-modal-reference.html"
        ).read_text(encoding="utf-8")
        self.parser = _CFFLiveParser(
            "ff-sky", SearchQuery("BER", "MAD", date(2026, 12, 11), ret=date(2026, 12, 19)), "EUR"
        )

    def assert_correct_return(self, markup):
        (offer,) = self.parser.parse(markup)
        leg = offer.itinerary.inbound
        self.assertEqual(offer.price, 104)
        self.assertEqual(leg.departure, "2026-12-19T22:20")
        self.assertEqual(leg.duration_minutes, 545)
        self.assertEqual([s.flight_number for s in leg.segments], ["FR3009", "FR2669"])
        self.assertEqual(leg.segments[0].departure, leg.departure)
        self.assertEqual(leg.segments[-1].arrival, leg.arrival)
        self.assertEqual(leg.segments[0].destination, "MXP")
        self.assertEqual(leg.segments[1].origin, "BGY")

    def test_captured_card_uses_its_modal_reference_not_its_position(self):
        self.assert_correct_return(self.markup)

    def test_missing_referenced_modal_does_not_borrow_a_neighbor(self):
        markup = self.markup.replace('id="myModal120"', 'id="unavailable"')
        (offer,) = self.parser.parse(markup)
        self.assertEqual(offer.itinerary.inbound.segments, [])

    def test_data_target_reference(self):
        start = self.markup.index("<a onclick=")
        end = self.markup.index("</a>", start) + len("</a>")
        markup = (
            self.markup[:start] + '<a data-target="#myModal120">Details</a>' + self.markup[end:]
        )
        self.assert_correct_return(markup)

    def test_trimmed_recording_keeps_the_referenced_modal(self):
        payload = ("Y|1|0|0|0|0|" + self.markup).encode()
        trimmed = trim_cffi_payload(payload, keep=1).decode().split("|")[6]
        self.assert_correct_return(trimmed)


class SplitFlight(unittest.TestCase):
    """`easyJet EZY5159` -> name, airline code, flight number."""

    def test_three_letter_icao_code(self):
        """Skyscanner prints ICAO for some carriers, and easyJet is one.

        The regression this exists for: a two-character-only pattern missed
        these entirely, and a miss keeps the text unsplit — so the name held
        the digits and the flight number came back empty.
        """
        self.assertEqual(_split_flight("easyJet EZY5159"), ("easyJet", "EZY", "EZY5159"))

    def test_two_letter_iata_code_without_a_space(self):
        """`KL1405` must not be read as code `KL1` and number `405`."""
        self.assertEqual(_split_flight("KLM KL1405"), ("KLM", "KL", "KL1405"))

    def test_code_containing_a_digit(self):
        """Two-character codes are not always two letters."""
        self.assertEqual(_split_flight("Wizz Air W6 2318"), ("Wizz Air", "W6", "W62318"))

    def test_code_beginning_with_a_digit(self):
        """`4U` is why the two-character branch cannot be letter-first."""
        self.assertEqual(_split_flight("Germanwings 4U 8425"), ("Germanwings", "4U", "4U8425"))

    def test_anything_else_keeps_its_text(self):
        """A leg with no flight number is not a parse failure.

        Ground transfers come through the same field, and losing the text
        would be worse than having no code for it.
        """
        self.assertEqual(_split_flight("Bus service"), ("Bus service", "", ""))

    def test_multi_word_carrier(self):
        self.assertEqual(
            _split_flight("Xiamen Airlines MF9328"),
            ("Xiamen Airlines", "MF", "MF9328"),
        )


class SegmentDates(unittest.TestCase):
    """The modal gives clock-only, airport-local times; the dates are ours."""

    @staticmethod
    def dated(*segments, day="2026-11-22"):
        legs = [
            Segment(origin=o, destination=d, departure=dep, arrival=arr, duration_minutes=minutes)
            for o, d, dep, arr, minutes in segments
        ]
        _date_segments(legs, day)
        return [(s.departure, s.arrival) for s in legs]

    def test_westbound_arrival_reading_earlier_stays_on_the_same_day(self):
        """IST→LON via Tirana: SAW is UTC+3, TIA UTC+1, so 17:55 lands at 17:50."""
        self.assertEqual(
            self.dated(
                ("SAW", "TIA", "17:55", "17:50", 115), ("TIA", "LTN", "00:25", "02:50", 205)
            ),
            [("2026-11-22T17:55", "2026-11-22T17:50"), ("2026-11-23T00:25", "2026-11-23T02:50")],
        )

    def test_eastbound_overnight_flight_lands_the_next_day(self):
        self.assertEqual(
            self.dated(("LHR", "IST", "21:00", "03:00", 240)),
            [("2026-11-22T21:00", "2026-11-23T03:00")],
        )

    def test_a_wait_past_midnight_departs_the_next_day(self):
        self.assertEqual(
            self.dated(
                ("BER", "MAD", "19:00", "22:10", 190), ("MAD", "SLP", "01:15", "06:30", 795)
            ),
            [("2026-11-22T19:00", "2026-11-22T22:10"), ("2026-11-23T01:15", "2026-11-23T06:30")],
        )

    def test_without_a_duration_a_backwards_clock_is_the_next_day(self):
        self.assertEqual(
            self.dated(("SAW", "TIA", "23:30", "00:40", None)),
            [("2026-11-22T23:30", "2026-11-23T00:40")],
        )


if __name__ == "__main__":
    unittest.main()

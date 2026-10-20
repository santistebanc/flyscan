"""What the FlightsFinder markup says, and what we read out of it.

Pure parsing: no network, no fixtures, no database. These are the cases where
the portal's own wording has caught us out.
"""

import unittest
from datetime import date
from pathlib import Path

from flight_scraper.models import SearchQuery
from flight_scraper.sources.flightsfinder import _CFFLiveParser, _split_flight
from flight_scraper.capture import trim_cffi_payload


class ModalReferences(unittest.TestCase):
    def setUp(self):
        self.markup = (Path(__file__).parent / "fixtures" /
                       "ff-sky-ber-mad-modal-reference.html").read_text(encoding="utf-8")
        self.parser = _CFFLiveParser("ff-sky", SearchQuery(
            "BER", "MAD", date(2026, 12, 11), ret=date(2026, 12, 19)), "EUR")

    def assert_correct_return(self, markup):
        offer, = self.parser.parse(markup)
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
        offer, = self.parser.parse(markup)
        self.assertEqual(offer.itinerary.inbound.segments, [])

    def test_data_target_reference(self):
        start = self.markup.index('<a onclick=')
        end = self.markup.index('</a>', start) + len('</a>')
        markup = self.markup[:start] + '<a data-target="#myModal120">Details</a>' + self.markup[end:]
        self.assert_correct_return(markup)

    def test_trimmed_recording_keeps_the_referenced_modal(self):
        payload = ('Y|1|0|0|0|0|' + self.markup).encode()
        trimmed = trim_cffi_payload(payload, keep=1).decode().split('|')[6]
        self.assert_correct_return(trimmed)


class SplitFlight(unittest.TestCase):
    """`easyJet EZY5159` -> name, airline code, flight number."""

    def test_three_letter_icao_code(self):
        """Skyscanner prints ICAO for some carriers, and easyJet is one.

        The regression this exists for: a two-character-only pattern missed
        these entirely, and a miss keeps the text unsplit — so the name held
        the digits and the flight number came back empty.
        """
        self.assertEqual(
            _split_flight("easyJet EZY5159"), ("easyJet", "EZY", "EZY5159")
        )

    def test_two_letter_iata_code_without_a_space(self):
        """`KL1405` must not be read as code `KL1` and number `405`."""
        self.assertEqual(_split_flight("KLM KL1405"), ("KLM", "KL", "KL1405"))

    def test_code_containing_a_digit(self):
        """Two-character codes are not always two letters."""
        self.assertEqual(
            _split_flight("Wizz Air W6 2318"), ("Wizz Air", "W6", "W62318")
        )

    def test_code_beginning_with_a_digit(self):
        """`4U` is why the two-character branch cannot be letter-first."""
        self.assertEqual(
            _split_flight("Germanwings 4U 8425"), ("Germanwings", "4U", "4U8425")
        )

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


if __name__ == "__main__":
    unittest.main()

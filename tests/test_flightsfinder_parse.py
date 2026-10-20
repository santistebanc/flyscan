"""What the FlightsFinder markup says, and what we read out of it.

Pure parsing: no network, no fixtures, no database. These are the cases where
the portal's own wording has caught us out.
"""

import unittest

from flight_scraper.sources.flightsfinder import _split_flight


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

import unittest
from unittest.mock import Mock, patch

from flight_scraper.places import search_places


class AirportCities(unittest.TestCase):
    def test_city_name_is_kept_separate_from_airport_name(self):
        response = Mock(status_code=200)
        response.json.return_value = [
            {"code": "LCY", "type": "airport", "name": "London City Airport", "city_name": "London"},
            {"code": "BER", "type": "city", "name": "Berlin"},
            {"code": "XXX", "type": "airport", "name": "Unknown Airport"},
        ]
        with patch('flight_scraper.places.requests.get', return_value=response):
            places = search_places('LCY')
        self.assertEqual(places[0].city, 'London')
        self.assertEqual(places[0].name, 'London City Airport')
        self.assertEqual(places[1].city, 'Berlin')
        self.assertEqual(places[2].city, '', 'do not mistake an airport name for its city')

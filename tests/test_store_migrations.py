"""A database keeps its data across releases: schema changes run once, in order, or not at all."""

import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest import mock

from flight_scraper import cli
from flight_scraper.store import MIGRATIONS, FlightStore

#: The released migrations, which every test database takes first.
RELEASED = len(MIGRATIONS)


def schema_version(path: str) -> int:
    with closing(sqlite3.connect(path)) as conn:
        return conn.execute("PRAGMA user_version").fetchone()[0]


class Migrations(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.db = str(Path(self.directory.name) / "flights.db")

    def tearDown(self):
        self.directory.cleanup()

    def test_a_new_database_takes_every_migration(self):
        steps = [
            *MIGRATIONS,
            "ALTER TABLE trips ADD COLUMN note TEXT;",
            "CREATE TABLE extra (id INTEGER);",
        ]
        with mock.patch("flight_scraper.store.MIGRATIONS", steps):
            FlightStore(self.db).close()
        self.assertEqual(schema_version(self.db), RELEASED + 2)

    def test_an_existing_database_takes_only_the_new_ones(self):
        FlightStore(self.db).close()
        self.assertEqual(schema_version(self.db), RELEASED)
        # ADD COLUMN fails if repeated, so running it twice would show.
        steps = [*MIGRATIONS, "ALTER TABLE trips ADD COLUMN note TEXT;"]
        with mock.patch("flight_scraper.store.MIGRATIONS", steps):
            FlightStore(self.db).close()
            FlightStore(self.db).close()
        self.assertEqual(schema_version(self.db), RELEASED + 1)

    def test_a_failing_migration_changes_nothing(self):
        FlightStore(self.db).close()
        steps = [
            *MIGRATIONS,
            "ALTER TABLE trips ADD COLUMN note TEXT; ALTER TABLE nowhere ADD COLUMN x TEXT;",
        ]
        with mock.patch("flight_scraper.store.MIGRATIONS", steps):
            with self.assertRaises(sqlite3.OperationalError):
                FlightStore(self.db)
        self.assertEqual(schema_version(self.db), RELEASED)
        with closing(sqlite3.connect(self.db)) as conn:
            columns = [row[1] for row in conn.execute("PRAGMA table_info(trips)")]
        self.assertNotIn("note", columns)

    def test_a_database_from_a_newer_version_is_refused(self):
        steps = [*MIGRATIONS, "CREATE TABLE extra (id INTEGER);"]
        with mock.patch("flight_scraper.store.MIGRATIONS", steps):
            FlightStore(self.db).close()
        with self.assertRaisesRegex(RuntimeError, "newer version"):
            FlightStore(self.db)


class PriceDates(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.db = str(Path(self.directory.name) / "flights.db")

    def tearDown(self):
        self.directory.cleanup()

    def test_prices_stored_before_dates_take_their_fetch_time(self):
        with mock.patch("flight_scraper.store.MIGRATIONS", []):
            FlightStore(self.db).close()
        with closing(sqlite3.connect(self.db)) as conn, conn:
            conn.execute(
                "INSERT INTO fetches (id, query_key, origin, destination, depart_date, source, last_fetched)"
                " VALUES (1, 'k', 'BER', 'LON', '2026-11-01', 'kayak', '2026-10-01T08:00:00+00:00')"
            )
            conn.execute(
                "INSERT INTO trips (id, trip_key, origin, destination, depart_date) VALUES (1, 't', 'BER', 'LON', '2026-11-01')"
            )
            conn.execute("INSERT INTO offers (fetch_id, trip_id, price) VALUES (1, 1, 99)")
        FlightStore(self.db).close()
        with closing(sqlite3.connect(self.db)) as conn:
            seen = conn.execute("SELECT seen_at FROM offers").fetchone()[0]
        self.assertEqual(seen, "2026-10-01T08:00:00+00:00")


class DataDirectory(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.home = os.getcwd()

    def tearDown(self):
        os.chdir(self.home)
        self.directory.cleanup()

    def test_every_command_runs_inside_the_data_directory(self):
        data = Path(self.directory.name) / "preview" / "data"
        with mock.patch.dict(os.environ, {cli.DATA_DIR_ENV: str(data)}):
            self.assertEqual(cli.main(["sources"]), 0)
        self.assertTrue(data.is_dir())
        self.assertEqual(Path.cwd().resolve(), data.resolve())

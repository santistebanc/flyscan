"""A database keeps its data across releases: schema changes run once, in order, or not at all."""

import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest import mock

from flight_scraper import cli
from flight_scraper.store import FlightStore


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
        steps = ["ALTER TABLE trips ADD COLUMN note TEXT;", "CREATE TABLE extra (id INTEGER);"]
        with mock.patch("flight_scraper.store.MIGRATIONS", steps):
            FlightStore(self.db).close()
        self.assertEqual(schema_version(self.db), 2)

    def test_an_existing_database_takes_only_the_new_ones(self):
        FlightStore(self.db).close()
        self.assertEqual(schema_version(self.db), 0)
        # ADD COLUMN fails if repeated, so running it twice would show.
        steps = ["ALTER TABLE trips ADD COLUMN note TEXT;"]
        with mock.patch("flight_scraper.store.MIGRATIONS", steps):
            FlightStore(self.db).close()
            FlightStore(self.db).close()
        self.assertEqual(schema_version(self.db), 1)

    def test_a_failing_migration_changes_nothing(self):
        FlightStore(self.db).close()
        steps = ["ALTER TABLE trips ADD COLUMN note TEXT; ALTER TABLE nowhere ADD COLUMN x TEXT;"]
        with mock.patch("flight_scraper.store.MIGRATIONS", steps):
            with self.assertRaises(sqlite3.OperationalError):
                FlightStore(self.db)
        self.assertEqual(schema_version(self.db), 0)
        with closing(sqlite3.connect(self.db)) as conn:
            columns = [row[1] for row in conn.execute("PRAGMA table_info(trips)")]
        self.assertNotIn("note", columns)

    def test_a_database_from_a_newer_version_is_refused(self):
        steps = ["CREATE TABLE extra (id INTEGER);"]
        with mock.patch("flight_scraper.store.MIGRATIONS", steps):
            FlightStore(self.db).close()
        with self.assertRaisesRegex(RuntimeError, "newer version"):
            FlightStore(self.db)


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

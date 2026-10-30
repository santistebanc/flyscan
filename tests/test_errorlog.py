"""Errors have to survive to be read, and carry enough to act on.

The message alone never says enough: "poll returned HTTP 404" is the same
sentence whether the route was wrong, the session expired, or the site is
blocking us. What makes an entry worth keeping is the context around it.
"""

import json
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest import mock

from flyscan import errorlog


class ErrorLog(unittest.TestCase):
    def setUp(self):
        directory = Path(tempfile.mkdtemp())
        patches = [
            mock.patch.object(errorlog, "LOG_DIR", directory),
            mock.patch.object(errorlog, "LOG_FILE", directory / "errors.jsonl"),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def test_an_entry_keeps_the_context_it_happened_in(self):
        errorlog.record(
            "source.ff-sky",
            RuntimeError("poll returned HTTP 404"),
            route="BER-CDG",
            depart=date(2026, 9, 21),
            adults=2,
        )
        entry = errorlog.recent()[0]
        self.assertEqual(entry["where"], "source.ff-sky")
        self.assertEqual(entry["kind"], "RuntimeError")
        self.assertEqual(entry["message"], "poll returned HTTP 404")
        self.assertEqual(entry["context"]["route"], "BER-CDG")
        # Dates are not JSON, and losing them would lose the search.
        self.assertEqual(entry["context"]["depart"], "2026-09-21")

    def test_a_raised_error_keeps_its_traceback(self):
        try:
            raise ValueError("something specific")
        except ValueError as exc:
            errorlog.record("api.searches", exc)
        self.assertIn("test_errorlog.py", errorlog.recent()[0]["traceback"])

    def test_a_plain_string_is_allowed(self):
        """Not every failure arrives as an exception object."""
        errorlog.record("ui.results", "fetch failed: network offline")
        self.assertEqual(errorlog.recent()[0]["kind"], "error")

    def test_newest_first_and_filterable_by_subsystem(self):
        errorlog.record("source.ff-sky", "one")
        errorlog.record("source.ff-kiwi", "two")
        errorlog.record("source.ff-sky", "three")
        self.assertEqual([e["message"] for e in errorlog.recent()], ["three", "two", "one"])
        self.assertEqual(
            [e["message"] for e in errorlog.recent(where="source.ff-sky")], ["three", "one"]
        )

    def test_the_summary_counts_repeats(self):
        """Forty of one thing is a site that changed; one of forty is a fluke."""
        for _ in range(4):
            errorlog.record("source.ff-kayak", "search page carried no form token")
        errorlog.record("source.ff-sky", "poll returned HTTP 404")
        top = errorlog.summary()[0]
        self.assertEqual(top["count"], 4)
        self.assertEqual(top["where"], "source.ff-kayak")

    def test_the_file_is_capped_so_it_can_be_read_whole(self):
        # A small cap for the test: the behaviour is the same at 500 and the
        # suite has no business writing a thousand files to prove it.
        with mock.patch.object(errorlog, "KEEP", 10):
            for index in range(45):
                errorlog.record("source.ff-sky", f"error {index}")
            kept = len(errorlog.LOG_FILE.read_text(encoding="utf-8").splitlines())
            self.assertLessEqual(kept, 20)
            # and the newest survive the trim, which is the half worth keeping
            self.assertEqual(errorlog.recent(1)[0]["message"], "error 44")

    def test_recording_a_failure_never_becomes_a_failure(self):
        """An exception thrown from an except block is the worst outcome."""
        with mock.patch.object(errorlog.Path, "mkdir", side_effect=OSError("read-only")):
            errorlog.record("source.ff-sky", "whatever")  # must not raise

    def test_a_half_written_line_does_not_poison_the_read(self):
        errorlog.record("source.ff-sky", "good line")
        with errorlog.LOG_FILE.open("a", encoding="utf-8") as handle:
            handle.write('{"id": "truncated"\n')
        self.assertEqual(len(errorlog.recent()), 1)

    def test_entries_are_one_json_object_per_line(self):
        """So they can be grepped and counted without a parser."""
        errorlog.record("source.ff-sky", "a")
        errorlog.record("source.ff-sky", "b")
        for line in errorlog.LOG_FILE.read_text(encoding="utf-8").splitlines():
            json.loads(line)


if __name__ == "__main__":
    unittest.main()

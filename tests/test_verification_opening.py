"""Clicking Verify must open a recorded challenge without running another scrape."""

import threading
import unittest
from unittest import mock

from flight_scraper.challenge import ChallengeCoordinator


class VerificationOpening(unittest.TestCase):
    def test_recorded_challenge_opens_without_waiting_for_a_full_source_probe(self):
        control = ChallengeCoordinator()
        control.record("momondo", "https://example.test/security/check")
        opened, release = threading.Event(), threading.Event()

        def slow_probe(source):
            release.wait(2)
            return "https://example.test/security/check", "challenged"

        def browser(*args, **kwargs):
            opened.set()
            return {"solved": False, "cookies": 0}

        try:
            with (
                mock.patch(
                    "flight_scraper.challenge.probe_challenge", side_effect=slow_probe
                ) as probe,
                mock.patch("flight_scraper.challenge.solve", side_effect=browser),
            ):
                self.assertTrue(control.start_recovery("momondo"))
                opened_promptly = opened.wait(0.1)
                release.set()
                control.close()
                self.assertTrue(
                    opened_promptly,
                    "Verify should open the known URL without waiting for a new flight search",
                )
                probe.assert_not_called()
        finally:
            release.set()
            control.close()

    def test_a_browser_launch_failure_is_exposed_to_the_ui(self):
        control = ChallengeCoordinator()
        control.record("momondo", "https://example.test/security/check")
        entered = threading.Event()

        def fail_browser(*args, **kwargs):
            entered.set()
            raise RuntimeError("Browser executable is missing")

        try:
            with (
                mock.patch(
                    "flight_scraper.challenge.probe_challenge",
                    return_value=("https://example.test/security/check", "challenged"),
                ),
                mock.patch("flight_scraper.challenge.solve", side_effect=fail_browser),
                mock.patch("logging.Logger.exception"),
            ):
                control.start_recovery("momondo")
                self.assertTrue(entered.wait(1))
                control.close()
            self.assertEqual(
                control.recovery_errors().get("momondo"), "Browser executable is missing"
            )
        finally:
            control.close()


if __name__ == "__main__":
    unittest.main()

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


class OpeningWhenRecorded(unittest.TestCase):
    """On the preview the check is open before anyone asks, so the stream has it ready."""

    def test_a_recorded_challenge_opens_at_once_when_asked_to(self):
        control = ChallengeCoordinator(open_when_recorded=True)
        opened = threading.Event()

        def browser(source, url, **kwargs):
            opened.set()
            return {"solved": False, "cookies": 0}

        try:
            with mock.patch("flight_scraper.challenge.solve", side_effect=browser) as solve:
                control.record("momondo", "https://example.test/security/check")
                self.assertTrue(opened.wait(2))
                control.close()
            self.assertEqual(
                solve.call_args.args[:2], ("momondo", "https://example.test/security/check")
            )
        finally:
            control.close()

    def test_otherwise_a_recorded_challenge_waits_for_verify(self):
        control = ChallengeCoordinator()
        try:
            with mock.patch("flight_scraper.challenge.solve") as solve:
                control.record("momondo", "https://example.test/security/check")
                self.assertFalse(control.solving())
            solve.assert_not_called()
        finally:
            control.close()

    def test_the_scheduler_opens_challenges_only_where_a_viewer_streams_them(self):
        from flight_scraper.scheduler import Scheduler

        with mock.patch.dict(
            "os.environ", {"FLIGHT_SCRAPER_CHALLENGE_VIEWER_URL": "http://x.test/vnc.html"}
        ):
            streamed = Scheduler(db_path=None)
        with mock.patch.dict("os.environ", {"FLIGHT_SCRAPER_CHALLENGE_VIEWER_URL": ""}):
            plain = Scheduler(db_path=None)
        try:
            self.assertTrue(streamed.challenge_control.open_when_recorded)
            self.assertFalse(plain.challenge_control.open_when_recorded)
        finally:
            streamed.shutdown()
            plain.shutdown()

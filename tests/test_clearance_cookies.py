"""A solved check must stay cleared: the cookies kept are ones the source accepts.

Momondo asked again within seconds of every solve because the browser session's own session
id was replayed to it in a new session; its durable cookies alone were accepted.
"""

import tempfile
import unittest
from unittest import mock

from flight_scraper import challenge
from flight_scraper.challenge import ChallengeCoordinator, ChallengeStore

JAR = {"consent": "c", "mst_token": "t", "p1.med.sid": "session", "captcha": "x"}
DURABLE = {"consent", "mst_token"}


def browser_cookie(name, expires):
    return {"name": name, "value": JAR[name], "domain": ".momondo.ie", "expires": expires}


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.store = ChallengeStore(tempfile.mkdtemp())

    def test_narrowing_keeps_only_durable_cookies_and_can_be_undone(self):
        self.store.save("momondo", JAR, "u", durable=DURABLE)
        self.assertTrue(self.store.narrow_to_durable("momondo"))
        self.assertEqual(set(self.store.load("momondo")), DURABLE)
        self.assertFalse(self.store.narrow_to_durable("momondo"))  # already narrowed
        self.assertTrue(self.store.restore_full("momondo"))
        self.assertEqual(self.store.load("momondo"), JAR)

    def test_nothing_to_narrow_without_durable_names_or_session_cookies(self):
        self.store.save("a", JAR, "u")
        self.assertFalse(self.store.narrow_to_durable("a"))
        self.store.save("b", {"consent": "c"}, "u", durable={"consent"})
        self.assertFalse(self.store.narrow_to_durable("b"))
        self.assertFalse(self.store.narrow_to_durable("missing"))


class SolveRecordsDurableCookies(unittest.TestCase):
    def test_session_cookies_are_not_called_durable(self):
        store = ChallengeStore(tempfile.mkdtemp())
        page = mock.Mock(url="https://www.momondo.ie/flight-search/BER-LON")
        context = mock.Mock(pages=[page])
        context.cookies.return_value = [
            browser_cookie("consent", 1_900_000_000),
            browser_cookie("mst_token", 1_900_000_000),
            browser_cookie("p1.med.sid", -1),
            browser_cookie("captcha", -1),
        ]
        playwright = mock.MagicMock()
        playwright.__enter__.return_value.chromium.launch_persistent_context.return_value = context
        module = mock.Mock(sync_playwright=lambda: playwright)
        with mock.patch.dict(
            "sys.modules", {"playwright": mock.Mock(), "playwright.sync_api": module}
        ):
            report = challenge.solve(
                "ff-sky", "https://x/security/check", store=store, wait_seconds=1
            )
        self.assertEqual(report["cookies"], 4)
        self.assertEqual(store.load("ff-sky"), {k: JAR[k] for k in JAR})
        self.assertTrue(store.narrow_to_durable("ff-sky"))
        self.assertEqual(set(store.load("ff-sky")), DURABLE)


class RecoveryKeepsCookiesTheSourceAccepts(unittest.TestCase):
    def recover(self, outcomes):
        store = ChallengeStore(tempfile.mkdtemp())

        def solved(source, url, store, **kwargs):
            store.save(source, JAR, url, durable=DURABLE)
            return {"source": source, "solved": True, "cookies": len(JAR)}

        with (
            ChallengeCoordinator(cookies=store) as control,
            mock.patch("flight_scraper.challenge.solve", side_effect=solved),
            mock.patch(
                "flight_scraper.challenge.probe_challenge",
                side_effect=[(None, o) for o in outcomes],
            ) as probe,
        ):
            control.record("momondo", "https://x/security/check")
            report = control.recover("momondo", url="https://x/security/check")
            self.assertEqual(control.pending(), {})
        return set(store.load("momondo")), probe.call_count, report

    def test_session_cookies_are_dropped_when_the_source_asks_again_with_them(self):
        kept, probes, report = self.recover(["challenged", "clear"])
        self.assertEqual((kept, probes, report["solved"]), (DURABLE, 2, True))

    def test_everything_is_kept_when_it_already_clears(self):
        kept, probes, _ = self.recover(["clear"])
        self.assertEqual((kept, probes), (set(JAR), 1))

    def test_everything_is_kept_when_narrowing_does_not_help(self):
        kept, probes, _ = self.recover(["challenged", "challenged"])
        self.assertEqual((kept, probes), (set(JAR), 2))

    def test_an_unreadable_probe_changes_nothing(self):
        kept, probes, _ = self.recover(["error"])
        self.assertEqual((kept, probes), (set(JAR), 1))


if __name__ == "__main__":
    unittest.main()

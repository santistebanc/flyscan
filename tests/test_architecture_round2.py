"""Behavioral regressions for the second architecture review."""

import tempfile
import threading
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest import mock

from flyscan.aggregate import Aggregator
from flyscan.scheduler import Scheduler, default_scheduler, reset_default_scheduler
from flyscan.task_queue import QueueFull
from tests import quiet_errorlog
from tests.test_scheduler_queue import QUERY, FakeSource
from tests.test_task_queue import eventually


class SearchSubscriptions(unittest.TestCase):
    def setUp(self):
        quiet_errorlog(self)

    def test_partial_admission_releases_accepted_subscriptions(self):
        scheduler = Scheduler(db_path=None, max_pending=1)
        self.addCleanup(lambda: scheduler.shutdown(wait=True))
        scheduler.block_source("test", "https://example.test/check")
        search = Aggregator(scheduler=scheduler)
        source = FakeSource()
        with mock.patch.object(search, "_sources", return_value=[source]):
            iterator = search.search_trips(
                QUERY, [(QUERY.depart, None), (date(2026, 12, 22), None)]
            )
            with self.assertRaises(QueueFull):
                next(iterator)
        eventually(
            lambda: (
                not any(j["state"] in ("queued", "running", "blocked") for j in scheduler.jobs())
            )
        )
        self.assertEqual(source.calls, 0)

    def test_cancelling_during_admission_does_not_leave_later_work(self):
        scheduler = Scheduler(db_path=None)
        self.addCleanup(lambda: scheduler.shutdown(wait=True))
        scheduler.block_source("test", "https://example.test/check")
        search = Aggregator(scheduler=scheduler)
        original = scheduler.submit

        def submit(*args, **kwargs):
            future = original(*args, **kwargs)
            search.cancel()
            return future

        with (
            mock.patch.object(search, "_sources", return_value=[FakeSource()]),
            mock.patch.object(scheduler, "submit", side_effect=submit),
        ):
            list(search.search_trips(QUERY, [(QUERY.depart, None), (date(2026, 12, 22), None)]))
        eventually(
            lambda: (
                not any(j["state"] in ("queued", "running", "blocked") for j in scheduler.jobs())
            )
        )

    def test_close_detaches_only_its_subscription_from_shared_work(self):
        scheduler = Scheduler(db_path=None)
        self.addCleanup(lambda: scheduler.shutdown(wait=True))
        scheduler.block_source("test", "https://example.test/check")
        search = Aggregator(scheduler=scheduler)
        source = FakeSource()
        mine = scheduler.submit(source, QUERY, owner=search.owner)
        other = scheduler.submit(source, QUERY, owner="other")
        search.close()
        self.assertIn("cancelled", mine.result(1).error)
        self.assertFalse(other.done())
        scheduler.clear_challenge("test")
        self.assertTrue(other.result(2).ok)

    def test_abandoned_iterator_releases_remaining_subscriptions(self):
        scheduler = Scheduler(db_path=None, max_workers=1)
        self.addCleanup(lambda: scheduler.shutdown(wait=True))
        release = threading.Event()
        self.addCleanup(release.set)
        other_day = date(2026, 12, 22)

        def work(query):
            if query.depart == other_day:
                release.wait(2)
            return []

        search = Aggregator(scheduler=scheduler)
        futures = []
        original = scheduler.submit

        def submit(*args, **kwargs):
            future = original(*args, **kwargs)
            futures.append(future)
            return future

        with (
            mock.patch.object(search, "_sources", return_value=[FakeSource(work)]),
            mock.patch.object(scheduler, "submit", side_effect=submit),
        ):
            iterator = search.search_trips(QUERY, [(QUERY.depart, None), (other_day, None)])
            self.assertEqual(next(iterator).query.depart, QUERY.depart)
            iterator.close()
        self.assertIn("cancelled", futures[1].result(1).error)


class ExecutionSettings(unittest.TestCase):
    def setUp(self):
        quiet_errorlog(self)
        reset_default_scheduler()
        self.addCleanup(reset_default_scheduler)

    def test_second_ledger_is_rejected_instead_of_silently_ignored(self):
        with tempfile.TemporaryDirectory() as directory:
            a, b = str(Path(directory) / "a.db"), str(Path(directory) / "b.db")
            first = default_scheduler(db_path=a)
            try:
                self.assertIs(default_scheduler(db_path=a), first)
                with self.assertRaisesRegex(ValueError, "database|ledger"):
                    default_scheduler(db_path=b)
                self.assertFalse(Path(b).exists())
            finally:
                reset_default_scheduler()
                first.shutdown(wait=True)

    def test_disabled_persistence_cannot_silently_switch_to_a_database(self):
        first = default_scheduler(db_path=None)
        self.assertIsNone(first.store)
        with self.assertRaises(ValueError):
            default_scheduler(db_path="flights.db")

    def test_search_freshness_is_applied_per_submission(self):
        with tempfile.TemporaryDirectory() as directory:
            scheduler = Scheduler(db_path=str(Path(directory) / "db"))
            try:
                source = FakeSource()
                with mock.patch("flyscan.store.fx.get_rates"):
                    scheduler.submit(source, QUERY).result(2)
                    scheduler.submit(source, QUERY, ttl=timedelta(hours=6)).result(2)
                    scheduler.submit(source, QUERY, ttl=timedelta(0)).result(2)
                self.assertEqual(source.calls, 2)
            finally:
                scheduler.shutdown(wait=True)

    def test_http_rejects_conflicting_settings_before_starting_search(self):
        from flyscan.web import create_app

        first = default_scheduler(db_path=None, max_workers=2)
        with mock.patch("flyscan.web.start_job") as start:
            client = create_app().test_client()
            response = client.post(
                "/v1/searches",
                json={
                    "origin": "BER",
                    "destination": "CDG",
                    "start": "2026-12-21",
                    "db": "another.db",
                },
            )
            self.assertEqual(response.status_code, 400)
            self.assertIn("ledger", response.json["error"])
            start.assert_not_called()
            params = client.application.extensions["flyscan"]["parse_params"]
            parsed, error = params({"origin": "BER", "destination": "CDG", "start": "2026-12-21"})
            self.assertIsNone(error)
            self.assertIsNone(parsed["db"])
            self.assertEqual(parsed["workers"], first.max_workers)

    def test_search_identity_includes_freshness_refresh_and_ledger(self):
        from flyscan.api import search_fingerprint

        params = {"db": "a", "cache_hours": 6, "refresh": False}
        original = search_fingerprint(params)
        for change in ({"db": "b"}, {"cache_hours": 0}, {"refresh": True}):
            self.assertNotEqual(search_fingerprint({**params, **change}), original)

    def test_result_reader_uses_the_writers_ledger(self):
        with tempfile.TemporaryDirectory() as directory:
            from flyscan.models import Itinerary, Leg, Offer

            scheduler = Scheduler(db_path=str(Path(directory) / "db"))
            try:
                offer = Offer(Itinerary(QUERY, Leg("BER", "CDG")), "test", 10, "EUR")
                offer.price_eur = 10
                with mock.patch("flyscan.store.fx.get_rates"):
                    self.assertTrue(
                        scheduler.submit(FakeSource(lambda query: [offer]), QUERY).result(2).ok
                    )
                    self.assertEqual(len(Aggregator(scheduler=scheduler).stored_offers(QUERY)), 1)
            finally:
                scheduler.shutdown(wait=True)


class ProgressIdentity(unittest.TestCase):
    def setUp(self):
        quiet_errorlog(self)

    def test_source_lifecycle_events_carry_trip_scrape_and_attempt(self):
        scheduler = Scheduler(db_path=None)
        self.addCleanup(lambda: scheduler.shutdown(wait=True))
        query = QUERY.replace_trip(QUERY.depart, date(2026, 12, 28))
        events = []
        result = scheduler.submit(
            FakeSource(), query, lambda event, data: events.append((event, data))
        ).result(2)
        self.assertTrue(result.ok)
        for event, data in events:
            if event in ("source_start", "source_done"):
                self.assertEqual(data.get("ret"), query.ret)
                self.assertIsInstance(data.get("scrape_id"), int)
                self.assertEqual(data.get("attempt"), 1)

    def test_partial_answers_keep_distinct_return_dates(self):
        from flyscan.models import Itinerary, Leg, Offer

        scheduler = Scheduler(db_path=None)
        self.addCleanup(lambda: scheduler.shutdown(wait=True))
        returns = [date(2026, 12, 28), date(2026, 12, 29)]
        events = []
        search = Aggregator(scheduler=scheduler, on_progress=lambda e, d: events.append((e, d)))
        source = FakeSource(lambda q: [Offer(Itinerary(q, Leg("BER", "CDG")), "test", 10, "EUR")])
        with (
            mock.patch.object(search, "_sources", return_value=[source]),
            mock.patch("flyscan.aggregate.merge", return_value=[]),
        ):
            list(search.search_trips(QUERY, [(QUERY.depart, ret) for ret in returns]))
        self.assertEqual(
            {data["ret"] for event, data in events if event == "day_partial"}, set(returns)
        )


class RecoveryShutdown(unittest.TestCase):
    def test_browser_wait_is_cancelled_and_late_answer_is_discarded(self):
        from flyscan.challenge import ChallengeCoordinator

        control = ChallengeCoordinator()
        entered = threading.Event()

        def solve(*args, cancelled, **kwargs):
            entered.set()
            self.assertTrue(cancelled.wait(2))
            return {"solved": True, "cookies": 1}

        with (
            mock.patch(
                "flyscan.challenge.probe_challenge",
                return_value=("https://example.test/check", "challenged"),
            ),
            mock.patch("flyscan.challenge.solve", side_effect=solve),
            mock.patch.object(control, "clear") as clear,
        ):
            control.start_recovery("test")
            self.assertTrue(entered.wait(2))
            control.close(wait=True)
            self.assertFalse(control.solving())
            clear.assert_not_called()

    def test_owned_ledger_is_retained_until_active_recovery_exits(self):
        from flyscan.challenge import ChallengeCoordinator

        ledger = mock.Mock()
        ledger.pending_challenges.return_value = {}
        control = ChallengeCoordinator(ledger=ledger, owns_ledger=True)
        entered, release = threading.Event(), threading.Event()

        def probe(source):
            entered.set()
            release.wait(2)
            return None, "clear"

        try:
            with mock.patch("flyscan.challenge.probe_challenge", side_effect=probe):
                control.start_recovery("test")
                self.assertTrue(entered.wait(2))
                control.close(wait=False)
                ledger.close.assert_not_called()
                with self.assertRaises(RuntimeError):
                    control.accept_cookies("test", {})
                release.set()
                control.close(wait=True)
                ledger.close.assert_called_once()
                ledger.clear_challenges.assert_not_called()
        finally:
            release.set()
            control.close()

    def test_closed_coordinator_rejects_new_recovery(self):
        from flyscan.challenge import ChallengeCoordinator

        control = ChallengeCoordinator()
        control.close()
        with mock.patch("flyscan.challenge.probe_challenge", return_value=(None, "error")):
            self.assertFalse(control.start_recovery("test"))

    def test_failed_thread_start_releases_the_source_reservation(self):
        from flyscan.challenge import ChallengeCoordinator

        control = ChallengeCoordinator()
        try:
            with mock.patch(
                "threading.Thread.start", side_effect=RuntimeError("cannot start thread")
            ):
                with self.assertRaises(RuntimeError):
                    control.start_recovery("test")
            self.assertFalse(control.solving())
        finally:
            control.close()

    def test_shutdown_during_probe_discards_late_clearance(self):
        scheduler = Scheduler(db_path=None)
        entered, release = threading.Event(), threading.Event()

        def probe(source):
            entered.set()
            release.wait(2)
            return None, "clear"

        try:
            with (
                mock.patch("flyscan.challenge.probe_challenge", side_effect=probe),
                mock.patch.object(scheduler.challenge_control, "clear") as clear,
            ):
                scheduler.challenge_control.start_recovery("test")
                self.assertTrue(entered.wait(2))
                scheduler.shutdown(wait=False)
                release.set()
                eventually(lambda: not scheduler.challenge_control.solving())
                clear.assert_not_called()
        finally:
            release.set()
            scheduler.shutdown(wait=True)


if __name__ == "__main__":
    unittest.main()

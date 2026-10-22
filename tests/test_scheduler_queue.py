import tempfile
import threading
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from flight_scraper.models import SearchQuery
from flight_scraper.scheduler import Scheduler
from flight_scraper.sources.base import ChallengeRequired, Source, SourceError
from flight_scraper.task_queue import RateLimited, RetryableError
from flight_scraper.web import create_app
from tests import quiet_errorlog
from tests.test_task_queue import FAST_RETRY, eventually

QUERY = SearchQuery("BER", "CDG", date(2026, 12, 21))


class FakeSource(Source):
    name = "test"
    max_concurrency = 1
    min_interval = 0

    def __init__(self, work=lambda query: [], **kwargs):
        super().__init__(**kwargs)
        self.work, self.calls = work, 0

    def search(self, query):
        self.calls += 1
        return self.work(query)


class SchedulerTests(unittest.TestCase):
    def setUp(self):
        quiet_errorlog(self)

    def scheduler(self, **kwargs):
        scheduler = Scheduler(
            db_path=kwargs.pop("db_path", None), retry_policy=FAST_RETRY, **kwargs
        )
        self.addCleanup(lambda: scheduler.shutdown(wait=True))
        return scheduler

    def test_scraping_uses_queue_retries_not_source_run_sleeps(self):
        scheduler = self.scheduler(max_workers=1)
        source = FakeSource()

        def work(query):
            if source.calls < 3:
                raise TimeoutError("temporary")
            return []

        source.work = work
        events = []
        with mock.patch.object(source, "run", side_effect=AssertionError("legacy retry path")):
            result = scheduler.submit(source, QUERY, lambda e, d: events.append((e, d))).result(2)
        self.assertTrue(result.ok)
        self.assertEqual(source.calls, 3)
        self.assertEqual([e for e, _ in events].count("source_retry"), 2)
        self.assertTrue(all(d["error"] for e, d in events if e == "source_retry"))

    def test_duplicate_callers_share_scrape_without_occupying_workers(self):
        release, entered = threading.Event(), threading.Event()
        scheduler = self.scheduler(max_workers=1)
        self.addCleanup(release.set)

        def work(query):
            entered.set()
            release.wait(2)
            return []

        source = FakeSource(work)
        first = scheduler.submit(source, QUERY, owner="first")
        self.assertTrue(entered.wait(2))
        second = scheduler.submit(source, QUERY, owner="second")
        self.assertEqual(len(scheduler.jobs()), 1)
        self.assertEqual(scheduler.snapshot()["workers_busy"], 1)
        # Cancelling one caller must not cancel the scrape another still wants.
        scheduler.cancel_owner("first")
        self.assertIn("cancelled", first.result(1).error)
        release.set()
        self.assertTrue(second.result(2).ok)
        self.assertEqual(source.calls, 1)

    def test_challenge_resumes_original_and_queued_jobs_without_reenqueue(self):
        scheduler = self.scheduler(max_workers=1)
        solved = threading.Event()
        events = []

        def work(query):
            if not solved.is_set():
                raise ChallengeRequired("https://example.test/check", "test")
            return []

        source = FakeSource(work)
        first = scheduler.submit(source, QUERY, lambda e, d: events.append(e))
        eventually(lambda: "challenge_required" in events)
        second = scheduler.submit(source, QUERY.replace_date(date(2026, 12, 22)))
        self.assertEqual(source.calls, 1)
        self.assertTrue(all(j["state"] == "blocked" for j in scheduler.jobs()))
        self.assertEqual(scheduler.snapshot()["workers_busy"], 0)
        solved.set()
        self.assertTrue(scheduler.clear_challenge("test"))
        self.assertTrue(first.result(2).ok)
        self.assertTrue(second.result(2).ok)
        self.assertFalse(scheduler.challenges())
        self.assertEqual(source.calls, 3)

    def test_restart_remembers_challenges_and_clear_resumes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "flights.db")
            first = self.scheduler(db_path=path, action_timeout=0.1)
            source = FakeSource(
                lambda q: (_ for _ in ()).throw(ChallengeRequired("https://example.test/check"))
            )
            future = first.submit(source, QUERY)
            eventually(lambda: bool(first.challenges()))
            first.shutdown(wait=True)
            self.assertFalse(future.result(2).ok)
            second = self.scheduler(db_path=path)
            cleared_source = FakeSource()
            pending = second.submit(cleared_source, QUERY)
            self.assertEqual(cleared_source.calls, 0)
            self.assertEqual(second.jobs()[0]["state"], "blocked")
            second.clear_challenge("test")
            self.assertTrue(pending.result(2).ok)
            second.shutdown(wait=True)

    def test_retry_then_success_updates_ledger_and_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            scheduler = self.scheduler(db_path=str(Path(directory) / "db"))
            source = FakeSource()

            def work(query):
                if source.calls < 2:
                    raise RetryableError("offline")
                return []

            source.work = work
            with mock.patch("flight_scraper.store.fx.get_rates"):
                self.assertTrue(scheduler.submit(source, QUERY).result(2).ok)
                self.assertTrue(scheduler.submit(source, QUERY).result(2).ok)
            self.assertEqual(source.calls, 2)
            plan = scheduler.store.plan(QUERY, ["test"])["test"]
            self.assertEqual(plan["why"], "fresh")
            scheduler.shutdown(wait=True)

    def test_duplicate_callers_share_a_loading_ledger_row(self):
        release, entered = threading.Event(), threading.Event()
        with tempfile.TemporaryDirectory() as directory:
            scheduler = self.scheduler(db_path=str(Path(directory) / "db"))
            self.addCleanup(release.set)
            source = FakeSource(lambda q: (entered.set(), release.wait(2), [])[2])
            try:
                with mock.patch("flight_scraper.store.fx.get_rates"):
                    first = scheduler.submit(source, QUERY)
                    self.assertTrue(entered.wait(2))
                    second = scheduler.submit(source, QUERY)
                    self.assertEqual(first.job_id, second.job_id)
                    self.assertFalse(second.done())
                    release.set()
                    self.assertTrue(first.result(2).ok)
                    self.assertTrue(second.result(2).ok)
                self.assertEqual(source.calls, 1)
            finally:
                release.set()
                scheduler.shutdown(wait=True)

    def test_failure_is_recorded_and_manual_retry_gets_correct_id(self):
        scheduler = self.scheduler()
        source = FakeSource(lambda q: (_ for _ in ()).throw(SourceError("bad query")))
        result = scheduler.submit(source, QUERY).result(2)
        self.assertIn("bad query", result.error)
        self.assertEqual(source.calls, 1)
        job_id = scheduler.jobs()[0]["id"]
        source.work = lambda q: []
        new_id = scheduler.retry_job(job_id)
        self.assertIsNotNone(new_id)
        eventually(lambda: scheduler.find_job(new_id).done)
        self.assertEqual(scheduler.find_job(new_id).state, "done")

    def test_timeout_never_commits_late_success(self):
        release, entered = threading.Event(), threading.Event()
        with tempfile.TemporaryDirectory() as directory:
            scheduler = self.scheduler(db_path=str(Path(directory) / "db"))
            self.addCleanup(release.set)

            def work(query):
                entered.set()
                release.wait(2)
                return []

            source = FakeSource(work)
            source.job_timeout = 0.05
            future = scheduler.submit(source, QUERY)
            self.assertTrue(entered.wait(2))
            self.assertIn("JobTimeout", future.result(1).error)
            release.set()
            eventually(lambda: scheduler.snapshot()["workers_busy"] == 0)
            self.assertNotEqual(scheduler.store.plan(QUERY, ["test"])["test"]["why"], "fresh")
            scheduler.shutdown(wait=True)

    def test_progress_callback_failure_does_not_lose_result(self):
        scheduler = self.scheduler()

        def progress(event, data):
            raise RuntimeError("observer broken")

        self.assertTrue(scheduler.submit(FakeSource(), QUERY, progress).result(2).ok)

    def test_failed_ledger_write_does_not_strand_subscribers(self):
        with tempfile.TemporaryDirectory() as directory:
            scheduler = self.scheduler(db_path=str(Path(directory) / "db"))
            with (
                mock.patch.object(
                    scheduler.store, "complete_fetch", side_effect=RuntimeError("disk full")
                ),
                mock.patch.object(
                    scheduler.store, "fail_fetch", side_effect=RuntimeError("disk full")
                ),
            ):
                result = scheduler.submit(FakeSource(), QUERY).result(2)
            self.assertIn("disk full", result.error)
            scheduler.shutdown(wait=True)


class HTTPPolicyTests(unittest.TestCase):
    def response(self, status, retry_after=None):
        response = SimpleNamespace(status_code=status, headers={})
        if retry_after is not None:
            response.headers["Retry-After"] = retry_after
        return SimpleNamespace(get=lambda *a, **k: response)

    def test_retry_after_seconds_date_and_invalid_values(self):
        source = FakeSource()
        for raw, minimum, maximum in [
            ("12", 12, 12),
            ("bogus", 60, 60),
            ("nan", 60, 60),
            ("-1", 60, 60),
        ]:
            with self.assertRaises(RateLimited) as caught:
                source.request(self.response(429, raw), "get", "https://example.test")
            self.assertGreaterEqual(caught.exception.retry_after, minimum)
            self.assertLessEqual(caught.exception.retry_after, maximum)
        future_date = (datetime.now(timezone.utc) + timedelta(seconds=30)).strftime(
            "%a, %d %b %Y %H:%M:%S GMT"
        )
        with self.assertRaises(RateLimited) as caught:
            source.request(self.response(429, future_date), "get", "https://example.test")
        self.assertTrue(28 <= caught.exception.retry_after <= 30)

    def test_transient_and_permanent_http_errors(self):
        for code, error in [
            (500, RetryableError),
            (408, RetryableError),
            (404, SourceError),
            (401, SourceError),
            (403, SourceError),
        ]:
            with self.assertRaises(error):
                FakeSource().request(self.response(code), "get", "https://example.test")

    def test_http_timeout_is_capped_by_attempt_budget(self):
        scheduler = Scheduler(db_path=None)
        self.addCleanup(lambda: scheduler.shutdown(wait=True))
        source = FakeSource()
        source.job_timeout = 0.3
        session = mock.Mock()
        session.get.return_value = SimpleNamespace(status_code=200)
        source.work = lambda q: (
            source.request(session, "get", "https://example.test", timeout=60),
            [],
        )[1]
        self.assertTrue(scheduler.submit(source, QUERY).result(2).ok)
        self.assertLessEqual(session.get.call_args.kwargs["timeout"], 0.301)


class QueueAPITests(unittest.TestCase):
    def setUp(self):
        quiet_errorlog(self)
        self.scheduler = Scheduler(db_path=None)
        self.addCleanup(lambda: self.scheduler.shutdown(wait=True))
        patch = mock.patch("flight_scraper.api.default_scheduler", return_value=self.scheduler)
        patch.start()
        self.addCleanup(patch.stop)
        self.client = create_app().test_client()

    def test_push_inspect_and_clear_captcha_through_api(self):
        solved = threading.Event()

        def work(query):
            if not solved.is_set():
                raise ChallengeRequired("https://example.test/check", "test")
            return []

        source = FakeSource(work)
        with mock.patch.dict("flight_scraper.api.REGISTRY", {"test": lambda: source}):
            response = self.client.post(
                "/v1/jobs",
                json={
                    "source": "test",
                    "origin": "BER",
                    "destination": "CDG",
                    "depart": "2026-12-21",
                },
            )
        self.assertEqual(response.status_code, 202)
        job_id = response.json["id"]
        eventually(lambda: self.scheduler.find_job(job_id).state == "blocked")
        self.assertEqual(self.client.get(f"/v1/jobs/{job_id}").json["action"]["kind"], "captcha")
        solved.set()
        self.assertTrue(self.client.delete("/v1/challenges/test").json["cleared"])
        eventually(lambda: self.scheduler.find_job(job_id).state == "done")
        self.assertEqual(self.client.get(f"/v1/jobs/{job_id}").json["attempts"], 2)

    def test_invalid_requests_are_rejected_without_starting_jobs(self):
        for payload in (
            [],
            {},
            {"source": "missing"},
            {"source": "ff-sky", "origin": "x", "destination": "CDG", "depart": "2026-12-21"},
        ):
            self.assertEqual(self.client.post("/v1/jobs", json=payload).status_code, 400)
        self.assertEqual(self.scheduler.jobs(), [])

    def test_queue_capacity_and_api_key_are_enforced(self):
        source = FakeSource()
        self.scheduler.queue.max_pending = 1
        self.scheduler.block_source("test", "https://example.test/check")
        payload = {"source": "test", "origin": "BER", "destination": "CDG", "depart": "2026-12-21"}
        with mock.patch.dict("flight_scraper.api.REGISTRY", {"test": lambda: source}):
            self.assertEqual(self.client.post("/v1/jobs", json=payload).status_code, 202)
            response = self.client.post("/v1/jobs", json={**payload, "depart": "2026-12-22"})
            self.assertEqual(response.status_code, 429)
            self.assertEqual(response.headers["Retry-After"], "5")
            with mock.patch.dict("os.environ", {"FLIGHT_SCRAPER_API_KEY": "test-key"}):
                self.assertEqual(self.client.post("/v1/jobs", json=payload).status_code, 401)
                self.assertEqual(
                    self.client.post(
                        "/v1/jobs", json=payload, headers={"X-API-Key": "test-key"}
                    ).status_code,
                    202,
                )

    def test_filtered_cancellation_includes_human_waiting_jobs(self):
        source = FakeSource()
        self.scheduler.block_source("test", "https://example.test/check")
        future = self.scheduler.submit(source, QUERY)
        response = self.client.post(
            "/v1/jobs/cancel",
            json={"mine": True, "origin": "BER", "destination": "CDG", "start": "2026-12-21"},
        )
        self.assertEqual(response.json["cancelled"], 1)
        self.assertIn("cancelled", future.result(2).error)


if __name__ == "__main__":
    unittest.main()

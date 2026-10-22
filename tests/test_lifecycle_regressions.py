"""Regressions for the lifecycle seams identified in the architecture review."""

import io
import subprocess
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from flight_scraper.jobs import EventLog, Job, JobRegistry
from flight_scraper.scheduler import Scheduler
from flight_scraper.store import FlightStore
from flight_scraper.task_queue import ActionRequired, TaskQueue
from tests import quiet_errorlog
from tests.test_scheduler_queue import QUERY, FakeSource
from tests.test_task_queue import eventually


class SearchLifecycle(unittest.TestCase):
    def setUp(self):
        quiet_errorlog(self)

    def test_retained_events_keep_monotonic_ids_and_reconnect(self):
        log = EventLog(limit=2)
        self.assertEqual(
            [log.append({"event": "progress"})["seq"] for _ in range(5)], [1, 2, 3, 4, 5]
        )
        log.close()
        self.assertEqual([e["seq"] for e in log.subscribe(after=4)], [5])
        self.assertEqual(log.last_seq, 5)

    def test_cancel_before_attachment_cancels_later_aggregator(self):
        job = Job(id="search")
        job.cancel()
        aggregator = mock.Mock()
        self.assertFalse(job.attach(aggregator))
        aggregator.cancel.assert_called_once()
        job.run(lambda: self.fail("cancelled search executed"))
        self.assertEqual(job.summary()["status"], "cancelled")
        self.assertEqual(list(job.log.subscribe())[-1]["event"], "done")

    def test_runner_and_export_failures_always_finish_and_close_replay(self):
        job = Job(id="search")

        def export():
            job.emit("source_done", source="test")
            raise OSError("export disk full")

        job.run(export)
        self.assertEqual(job.summary()["status"], "failed")
        events = list(job.log.subscribe())
        self.assertEqual([e["event"] for e in events], ["source_done", "error", "done"])
        self.assertIn("export disk full", job.summary()["error"])

    def test_search_creation_is_atomic_across_concurrent_callers(self):
        registry = JobRegistry()
        release, entered = threading.Event(), threading.Event()
        self.addCleanup(release.set)

        def runner(job):
            entered.set()
            release.wait(2)

        barrier = threading.Barrier(8)

        def start(_):
            barrier.wait()
            return registry.start({}, "same-search", runner)

        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(start, range(8)))
        self.assertTrue(entered.wait(1))
        self.assertEqual(len({job.id for job, joined in results}), 1)
        self.assertEqual(sum(not joined for job, joined in results), 1)
        release.set()
        eventually(lambda: results[0][0].done)

    def test_search_observations_are_copies_and_execution_starts_once(self):
        job = Job("search", params={"sources": ["test"]})
        job.record_day("trip", {"rows": [{"price": 10}]})
        job.days[0]["rows"][0]["price"] = 99
        job.summary()["params"]["sources"].append("other")
        self.assertEqual(job.days[0]["rows"][0]["price"], 10)
        self.assertEqual(job.params["sources"], ["test"])
        with self.assertRaises(AttributeError):
            job.status = "done"
        runner = mock.Mock()
        job.run(runner)
        job.run(runner)
        runner.assert_called_once()
        self.assertEqual([e["event"] for e in job.log.snapshot()].count("done"), 1)


class SearchTransportTests(unittest.TestCase):
    def setUp(self):
        quiet_errorlog(self)
        from flight_scraper.web import create_app

        self.registry = JobRegistry()
        patch = mock.patch("flight_scraper.web.JOBS", self.registry)
        patch.start()
        self.addCleanup(patch.stop)
        self.app = create_app()
        self.client = self.app.test_client()
        self.payload = {"origin": "BER", "destination": "CDG", "start": "2026-12-21", "db": ""}
        patch = mock.patch(
            "flight_scraper.searches.resolve",
            side_effect=lambda code, **kw: SimpleNamespace(code=code),
        )
        patch.start()
        self.addCleanup(patch.stop)

    def test_export_error_closes_actual_search_stream_and_keeps_results(self):
        from flight_scraper.aggregate import DayResult
        from flight_scraper.models import Itinerary, Leg, Offer

        offer = Offer(Itinerary(QUERY, Leg("BER", "CDG")), "test", 10, "EUR")
        day = DayResult(QUERY, [], [SimpleNamespace(best=offer)])
        # DayResult.offers reads source results, while merged is only presentation.
        from flight_scraper.sources.base import SourceResult

        day.results = [SourceResult("test", offers=[offer])]
        aggregator = mock.Mock()
        aggregator.search_trips.return_value = iter([day])
        aggregator.stored_offers.return_value = None
        with (
            mock.patch("flight_scraper.searches.Aggregator", return_value=aggregator),
            mock.patch(
                "flight_scraper.searches._merged_row", return_value={"best": {"price_base": 10}}
            ),
            mock.patch(
                "flight_scraper.searches.offer_to_row",
                return_value={"depart_date": "2026-12-21", "price_base": 10},
            ),
            mock.patch(
                "flight_scraper.searches.write_csv", side_effect=OSError("export disk full")
            ),
        ):
            created = self.client.post("/v1/searches", json=self.payload)
            self.assertEqual(created.status_code, 202)
            job = self.registry.get(created.json["search_id"])
            eventually(lambda: job.done)
        self.assertEqual(job.status, "failed")
        self.assertEqual(job.summary()["offers"], 1)
        response = self.client.get(f"/v1/searches/{job.id}/events")
        self.assertIn(b'"event": "done"', response.data)
        self.assertIn(b"export disk full", response.data)
        self.assertEqual(self.client.get(f"/v1/searches/{job.id}/results").json["count"], 1)
        aggregator.close.assert_called_once()

    def test_http_cancel_during_aggregator_construction_starts_no_scrapes(self):
        constructing, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        aggregator = mock.Mock()

        def construct(**kwargs):
            constructing.set()
            release.wait(2)
            return aggregator

        with mock.patch("flight_scraper.searches.Aggregator", side_effect=construct):
            created = self.client.post("/v1/searches", json=self.payload)
            job = self.registry.get(created.json["search_id"])
            self.assertTrue(constructing.wait(2))
            self.assertEqual(self.client.delete(f"/v1/searches/{job.id}").status_code, 200)
            release.set()
            eventually(lambda: job.done)
        self.assertEqual(job.status, "cancelled")
        aggregator.cancel.assert_called_once()
        aggregator.search_trips.assert_not_called()
        aggregator.close.assert_called_once()

    def test_http_duplicate_searches_share_one_runner(self):
        release, entered = threading.Event(), threading.Event()
        self.addCleanup(release.set)

        def run(job, params):
            entered.set()
            release.wait(2)

        with mock.patch("flight_scraper.web.execute_search", side_effect=run) as runner:
            first = self.client.post("/v1/searches", json=self.payload)
            self.assertTrue(entered.wait(2))
            second = self.client.post("/v1/searches", json=self.payload)
            self.assertEqual(second.status_code, 200)
            self.assertTrue(second.json["joined"])
            self.assertEqual(first.json["search_id"], second.json["search_id"])
            release.set()
            eventually(lambda: self.registry.get(first.json["search_id"]).done)
            runner.assert_called_once()


class ChallengeLifecycle(unittest.TestCase):
    def setUp(self):
        quiet_errorlog(self)

    def test_another_process_clearing_ledger_resumes_original_work(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "db")
            store = FlightStore(path)
            fetch = store.begin_fetch(QUERY, "test")
            store.challenge_fetch(fetch, "https://example.test/check")
            store.close()
            scheduler = Scheduler(db_path=path)
            try:
                source = FakeSource()
                future = scheduler.submit(source, QUERY)
                self.assertEqual(scheduler.jobs()[0]["state"], "blocked")
                subprocess.run(
                    [
                        sys.executable,
                        "-c",
                        "import sys; from flight_scraper.store import FlightStore; "
                        "store=FlightStore(sys.argv[1]); store.clear_challenges('test'); store.close()",
                        path,
                    ],
                    check=True,
                    capture_output=True,
                    timeout=5,
                )
                with mock.patch("flight_scraper.store.fx.get_rates"):
                    self.assertTrue(future.result(2).ok)
                self.assertEqual(source.calls, 1)
                self.assertFalse(scheduler.challenges())
            finally:
                scheduler.shutdown(wait=True)

    def test_cookie_clearance_is_visible_to_existing_cookie_reader(self):
        from flight_scraper.challenge import ChallengeStore

        with tempfile.TemporaryDirectory() as directory:
            reader, writer = ChallengeStore(directory), ChallengeStore(directory)
            writer.save("test", {"clearance": "old"})
            self.assertEqual(reader.load("test"), {"clearance": "old"})
            writer.save("test", {"clearance": "new"})
            self.assertEqual(reader.load("test"), {"clearance": "new"})
            writer.clear("test")
            self.assertEqual(reader.load("test"), {})

    def test_cli_clearance_uses_selected_database_for_all_probe_outcomes(self):
        from flight_scraper.challenge import ChallengeStore
        from flight_scraper.cli import cmd_unblock

        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "selected.db")
            cookies = ChallengeStore(Path(directory) / "cookies")
            args = SimpleNamespace(
                status=False, forget=False, source="test", db=path, url=None, wait=1
            )
            for outcome in ("clear", "error", "challenged"):
                store = FlightStore(path)
                fetch = store.begin_fetch(QUERY, "test")
                store.challenge_fetch(fetch, "https://example.test/stored")
                store.close()

                def solve(source, url, store, wait_seconds, **kwargs):
                    store.save(source, {"clearance": "new"}, url)
                    return {"source": source, "solved": True, "cookies": 1}

                url = "https://example.test/fresh" if outcome == "challenged" else None
                with (
                    mock.patch("flight_scraper.cli._configure_console"),
                    mock.patch("flight_scraper.cli.CHALLENGE_STORE", cookies),
                    mock.patch(
                        "flight_scraper.scheduler.default_scheduler",
                        side_effect=AssertionError("wrong ledger"),
                    ),
                    mock.patch(
                        "flight_scraper.challenge.probe_challenge", return_value=(url, outcome)
                    ),
                    mock.patch("flight_scraper.challenge.solve", side_effect=solve) as solved,
                    redirect_stdout(io.StringIO()),
                ):
                    self.assertEqual(cmd_unblock(args), 0)
                store = FlightStore(path)
                try:
                    self.assertFalse(store.pending_challenges())
                finally:
                    store.close()
                self.assertEqual(solved.call_count, 0 if outcome == "clear" else 1)

    def test_cookie_adapter_clears_and_resumes_original_future(self):
        from flight_scraper.challenge import ChallengeStore

        with tempfile.TemporaryDirectory() as directory:
            scheduler = Scheduler(db_path=None)
            scheduler.challenge_control.cookies = ChallengeStore(directory)
            try:
                scheduler.block_source("test", "https://example.test/check")
                future = scheduler.submit(FakeSource(), QUERY)
                scheduler.challenge_control.accept_cookies("test", {"clearance": "ok"})
                self.assertTrue(future.result(2).ok)
                self.assertEqual(
                    scheduler.challenge_control.cookies.load("test"), {"clearance": "ok"}
                )
            finally:
                scheduler.shutdown(wait=True)

    def test_probe_failure_without_url_and_unsolved_browser_keep_challenge(self):
        from flight_scraper.challenge import ChallengeCoordinator, ChallengeStore

        with tempfile.TemporaryDirectory() as directory:
            with ChallengeCoordinator(cookies=ChallengeStore(directory)) as recovery:
                with mock.patch(
                    "flight_scraper.challenge.probe_challenge", return_value=(None, "error")
                ):
                    self.assertFalse(recovery.recover("test")["solved"])
                recovery.record("test", "https://example.test/stored")
                with (
                    mock.patch(
                        "flight_scraper.challenge.probe_challenge", return_value=(None, "error")
                    ),
                    mock.patch("flight_scraper.challenge.solve", return_value={"solved": False}),
                ):
                    self.assertFalse(recovery.recover("test")["solved"])
                self.assertIn("test", recovery.pending())

    def test_cookie_write_failure_leaves_original_work_paused(self):
        scheduler = Scheduler(db_path=None)
        try:
            scheduler.block_source("test", "https://example.test/check")
            future = scheduler.submit(FakeSource(), QUERY)
            with mock.patch.object(
                scheduler.challenge_control.cookies, "save", side_effect=OSError("disk full")
            ):
                with self.assertRaises(OSError):
                    scheduler.challenge_control.accept_cookies("test", {"clearance": "ok"})
            self.assertFalse(future.done())
            self.assertEqual(scheduler.find_job(future.job_id).state, "blocked")
        finally:
            scheduler.shutdown(wait=True)

    def test_browser_requests_share_one_recovery_and_resume_work(self):
        scheduler = Scheduler(db_path=None)
        entered, release = threading.Event(), threading.Event()
        try:
            scheduler.block_source("test", "https://example.test/check")
            future = scheduler.submit(FakeSource(), QUERY)

            def solve(*args, **kwargs):
                entered.set()
                release.wait(2)
                return {"solved": True, "cookies": 0}

            with (
                mock.patch(
                    "flight_scraper.challenge.probe_challenge",
                    return_value=("https://example.test/check", "challenged"),
                ),
                mock.patch("flight_scraper.challenge.solve", side_effect=solve) as browser,
            ):
                self.assertTrue(scheduler.challenge_control.start_recovery("test"))
                self.assertTrue(entered.wait(2))
                self.assertFalse(scheduler.challenge_control.start_recovery("test"))
                release.set()
                self.assertTrue(future.result(2).ok)
                eventually(lambda: not scheduler.challenge_control.solving())
                browser.assert_called_once()
        finally:
            release.set()
            scheduler.shutdown(wait=True)


class QueueOwnership(unittest.TestCase):
    def test_observations_cannot_mutate_running_execution_or_payload(self):
        with TaskQueue(max_workers=1) as queue:
            queue.register("work", lambda payload, context: payload)
            queue.pause("held", ActionRequired("confirm", "wait"))
            handle = queue.submit("work", {"private": "payload"}, resource="held")
            snapshot = queue.get(handle.id)
            with self.assertRaises((AttributeError, TypeError)):
                snapshot.state = "done"
            with self.assertRaises(TypeError):
                snapshot.action["kind"] = "changed"
            self.assertFalse(hasattr(snapshot, "payload"))
            self.assertFalse(hasattr(snapshot, "context"))
            self.assertFalse(hasattr(handle, "payload"))
            self.assertFalse(hasattr(handle, "context"))
            self.assertEqual(queue.get(handle.id).state, "waiting_action")
            queue.resolve_action("held")
            self.assertEqual(handle.future.result(2), {"private": "payload"})

    def test_event_observations_are_frozen_at_transition_time(self):
        seen = []

        def observe(event, task):
            if event == "action_required":
                seen.append(task)
                queue.resolve_action(task.resource)

        calls = []
        with TaskQueue(on_event=observe) as queue:

            def handler(payload, context):
                calls.append(1)
                if len(calls) == 1:
                    raise ActionRequired("confirm", "continue")
                return "done"

            queue.register("work", handler)
            handle = queue.submit("work")
            self.assertEqual(handle.future.result(2), "done")
            self.assertEqual(seen[0].state, "waiting_action")
            self.assertEqual(seen[0].attempts, 1)

    def test_result_future_remains_compatible_with_as_completed_but_queue_owns_completion(self):
        with TaskQueue() as queue:
            queue.register("work", lambda payload, context: payload)
            jobs = [queue.submit("work", value) for value in range(3)]
            with self.assertRaises(AttributeError):
                jobs[0].future.set_result("injected")
            self.assertEqual(
                sorted(
                    future.result()
                    for future in as_completed([job.future for job in jobs], timeout=2)
                ),
                [0, 1, 2],
            )


if __name__ == "__main__":
    unittest.main()

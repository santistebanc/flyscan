"""Query jobs stay independent of the results view and share source gates."""

import tempfile
import threading
import time
import unittest
from collections import deque
from dataclasses import replace
from datetime import date
from pathlib import Path
from unittest import mock

from flyscan.scheduler import Scheduler
from flyscan.task_queue import RateLimited
from flyscan.web import create_app
from tests import quiet_errorlog
from tests.test_scheduler_queue import QUERY, FakeSource
from tests.test_task_queue import FAST_RETRY, eventually


class QueryJobTests(unittest.TestCase):
    def setUp(self):
        quiet_errorlog(self)
        self.scheduler = Scheduler(db_path=None, max_workers=1, retry_policy=FAST_RETRY)
        self.addCleanup(lambda: self.scheduler.shutdown(wait=True))
        patch = mock.patch("flyscan.api.default_scheduler", return_value=self.scheduler)
        patch.start()
        self.addCleanup(patch.stop)
        self.client = create_app().test_client()

    def test_groups_are_global_and_identity_includes_currency_and_party(self):
        source = FakeSource()
        for query in (
            QUERY,
            QUERY.replace_date(date(2026, 12, 22)),
            replace(QUERY, currency="USD"),
            replace(QUERY, adults=2),
            replace(QUERY, ret=date(2026, 12, 28)),
            replace(QUERY, cabin="business"),
        ):
            self.scheduler.submit(source, query).result(2)
        response = self.client.get("/v1/jobs?origin=MAD&destination=LHR&start=2026-12-21")
        self.assertEqual(len(response.json["query_jobs"]), 6)
        self.assertTrue(all(not job["mine"] for job in response.json["query_jobs"]))

    def test_selection_applies_to_future_submissions_and_demotes_previous_work(self):
        source = FakeSource()
        self.scheduler.block_source("test", "https://example.test/check")
        later = QUERY.replace_date(date(2026, 12, 22))
        first = self.scheduler.submit(source, QUERY)
        response = self.client.post(
            "/v1/queue/selection",
            json={"origin": "BER", "destination": "CDG", "start": "2026-12-22"},
        )
        self.assertEqual(response.status_code, 200)
        second = self.scheduler.submit(source, later)
        self.assertEqual(self.scheduler.find_job(first.job_id).describe()["priority"], 10)
        self.assertEqual(self.scheduler.find_job(second.job_id).describe()["priority"], 0)
        # Last-submitted search subscriptions must not steal selected priority.
        self.scheduler.focus("background-owner")
        self.assertEqual(self.scheduler.find_job(second.job_id).describe()["priority"], 0)
        self.client.post(
            "/v1/queue/selection",
            json={"origin": "BER", "destination": "CDG", "start": "2026-12-21"},
        )
        self.assertEqual(self.scheduler.find_job(first.job_id).describe()["priority"], 0)
        self.assertEqual(self.scheduler.find_job(second.job_id).describe()["priority"], 10)
        self.client.post("/v1/queue/selection", data="null", content_type="application/json")
        self.assertTrue(all(j["priority"] == 10 for j in self.scheduler.jobs()))

    def test_group_cancel_cancels_running_and_waiting_sources(self):
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        first_source = FakeSource(lambda q: (entered.set(), release.wait(2), [])[2])
        first = self.scheduler.submit(first_source, QUERY)
        self.assertTrue(entered.wait(2))
        other = FakeSource()
        other.name = "other"
        second = self.scheduler.submit(other, QUERY)
        group = self.client.get("/v1/jobs").json["query_jobs"][0]
        response = self.client.post(f"/v1/query-jobs/{group['id']}/cancel")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["cancelled"], 2)
        self.assertIn("cancelled", first.result(2).error)
        self.assertIn("cancelled", second.result(2).error)
        self.assertEqual(self.scheduler.find_job(first.job_id).describe()["status"], "cancelling")
        retry = self.client.post(f"/v1/query-jobs/{group['id']}/sources/test/retry")
        self.assertEqual(retry.json["retried"], 0)
        release.set()
        eventually(lambda: not self.scheduler.find_job(first.job_id).describe()["worker_busy"])
        retry = self.client.post(f"/v1/query-jobs/{group['id']}/sources/test/retry")
        self.assertEqual(retry.json["retried"], 1)

    def test_group_retry_keeps_success_and_deduplicates_source_attempts(self):
        good, bad = FakeSource(), FakeSource()
        bad.name = "other"
        self.scheduler.submit(good, QUERY).result(2)
        self.scheduler.block_source("other", "https://example.test/check")
        future = self.scheduler.submit(bad, QUERY)
        self.scheduler.cancel_job(future.job_id)
        future.result(2)
        group_id = self.client.get("/v1/jobs").json["query_jobs"][0]["id"]
        response = self.client.post(f"/v1/query-jobs/{group_id}/retry")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["retried"], 1)
        group = self.client.get("/v1/jobs").json["query_jobs"][0]
        self.assertEqual(len(group["sources"]), 2)
        self.assertEqual(good.calls, 1)
        self.assertEqual(
            next(s for s in group["sources"] if s["source"] == "other")["status"], "waiting_input"
        )

    def test_selected_job_runs_first_but_manual_retry_keeps_source_cooldown(self):
        starts = []
        source = FakeSource(lambda q: (starts.append((q.depart, time.monotonic())), [])[1])
        source.min_interval = 0.12
        self.scheduler.block_source("test", "https://example.test/check")
        background = self.scheduler.submit(source, QUERY)
        later = QUERY.replace_date(date(2026, 12, 22))
        selected = self.scheduler.submit(source, later)
        self.scheduler.select_query({"origin": "BER", "destination": "CDG", "start": "2026-12-22"})
        self.scheduler.clear_challenge("test")
        selected.result(2)
        self.assertEqual(starts[0][0], later.depart)
        group_id = next(
            g["id"] for g in self.scheduler.query_jobs() if g["depart"] == later.depart.isoformat()
        )
        self.assertEqual(self.scheduler.query_action(group_id, "retry", "test")["retried"], 1)
        eventually(lambda: len(starts) == 3)
        background.result(2)
        self.assertEqual([s[0] for s in starts], [later.depart, later.depart, QUERY.depart])
        self.assertTrue(all(b[1] - a[1] >= 0.105 for a, b in zip(starts, starts[1:], strict=False)))

    def test_rate_limit_survives_cancelled_request_and_applies_to_other_queries(self):
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)

        def work(query):
            if query.depart == QUERY.depart:
                entered.set()
                release.wait(2)
                raise RateLimited(0.15)
            return []

        source = FakeSource(work)
        first = self.scheduler.submit(source, QUERY)
        self.assertTrue(entered.wait(2))
        self.scheduler.cancel_job(first.job_id)
        first.result(2)
        second = self.scheduler.submit(source, QUERY.replace_date(date(2026, 12, 22)))
        release.set()
        eventually(
            lambda: self.scheduler.find_job(second.job_id).describe()["status"] == "rate_limited"
        )
        self.assertGreater(self.scheduler.find_job(second.job_id).describe()["ready_in"], 0)
        self.assertEqual(source.calls, 1)
        self.assertTrue(second.result(2).ok)

    def test_query_keeps_all_source_rows_after_task_history_is_pruned(self):
        self.scheduler.queue._history = deque(maxlen=1)
        first, second = FakeSource(), FakeSource()
        second.name = "other"
        one = self.scheduler.submit(first, QUERY)
        one.result(2)
        self.scheduler.submit(second, QUERY).result(2)
        self.assertIsNone(self.scheduler.queue.get(one.job_id))
        group = self.scheduler.query_jobs()[0]
        self.assertEqual(len(group["sources"]), 2)
        self.assertEqual(self.scheduler.query_action(group["id"], "retry", "test")["retried"], 1)

    def test_cached_source_appears_without_contacting_source_and_can_be_refreshed(self):
        with tempfile.TemporaryDirectory() as directory:
            scheduler = Scheduler(db_path=str(Path(directory) / "ledger.db"))
            try:
                source = FakeSource()
                scheduler.submit(source, QUERY).result(2)
                cached = scheduler.submit(source, QUERY)
                self.assertIsNone(cached.job_id)
                self.assertEqual(source.calls, 1)
                group = scheduler.query_jobs()[0]
                self.assertEqual(group["sources"][0]["status"], "cached")
                self.assertEqual(scheduler.query_action(group["id"], "retry")["retried"], 0)
                self.assertEqual(scheduler.query_action(group["id"], "retry", "test")["retried"], 1)
                eventually(lambda: source.calls == 2)
            finally:
                scheduler.shutdown(wait=True)

    def test_invalid_selection_and_actions_do_not_change_work(self):
        for body in (
            [],
            {},
            {"origin": "BER", "destination": "CDG", "start": "bad"},
            {"origin": "BER", "destination": "CDG", "start": "2026-12-21", "cabin": "bad"},
        ):
            self.assertEqual(self.client.post("/v1/queue/selection", json=body).status_code, 400)
        self.assertEqual(self.client.post("/v1/query-jobs/missing/retry").status_code, 404)
        self.assertEqual(self.client.post("/v1/query-jobs/missing/unknown").status_code, 400)
        self.assertEqual(
            self.client.post(
                "/v1/queue/selection", data="broken", content_type="application/json"
            ).status_code,
            400,
        )

    def test_group_retry_reports_capacity_errors_without_losing_failed_state(self):
        source = FakeSource()
        self.scheduler.block_source("test", "https://example.test/check")
        first = self.scheduler.submit(source, QUERY)
        self.scheduler.cancel_job(first.job_id)
        first.result(2)
        group_id = self.scheduler.query_jobs()[0]["id"]
        self.scheduler.queue.max_pending = 1
        self.scheduler.submit(source, QUERY.replace_date(date(2026, 12, 22)))
        response = self.client.post(f"/v1/query-jobs/{group_id}/retry")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["retried"], 0)
        self.assertIn("capacity", response.json["errors"][0]["error"])
        group = next(g for g in self.scheduler.query_jobs() if g["id"] == group_id)
        self.assertEqual(group["sources"][0]["status"], "cancelled")

    def test_range_cancel_uses_explicit_filters_across_owners_and_keeps_other_jobs(self):
        source = FakeSource()
        self.scheduler.block_source("test", "https://example.test/check")
        included = [QUERY, QUERY.replace_date(date(2026, 12, 22))]
        excluded = [
            QUERY.replace_date(date(2026, 12, 23)),
            replace(QUERY, adults=2),
            replace(QUERY, currency="USD"),
            replace(QUERY, cabin="business"),
            replace(QUERY, destination="LON"),
            replace(QUERY, ret=date(2026, 12, 28)),
        ]
        wanted = [
            self.scheduler.submit(source, q, owner=f"search-{index}")
            for index, q in enumerate(included)
        ]
        others = [self.scheduler.submit(source, q) for q in excluded]
        # Another tab's foreground selection must not widen or redirect a bulk action.
        self.scheduler.select_query({"origin": "BER", "destination": "LON", "start": "2026-12-21"})
        response = self.client.post(
            "/v1/queue/actions/cancel",
            json={
                "origin": "BER",
                "destination": "CDG",
                "start": "2026-12-21",
                "end": "2026-12-22",
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["groups"], 2)
        self.assertEqual(response.json["cancelled"], 2)
        self.assertTrue(all("cancelled" in future.result(2).error for future in wanted))
        self.assertTrue(all(not future.done() for future in others))

    def test_range_retry_preserves_success_and_live_work_and_respects_return_range(self):
        good, bad = FakeSource(), FakeSource()
        bad.name = "other"
        self.scheduler.block_source("other", "https://example.test/check")
        wanted = [
            replace(QUERY, ret=date(2026, 12, 28)),
            replace(QUERY, depart=date(2026, 12, 22), ret=date(2026, 12, 29)),
        ]
        outside = replace(QUERY, ret=date(2026, 12, 30))
        cancelled = []
        for query in [*wanted, outside]:
            self.scheduler.submit(good, query).result(2)
            future = self.scheduler.submit(bad, query)
            self.scheduler.cancel_job(future.job_id)
            future.result(2)
            cancelled.append(future)
        filters = {
            "origin": "BER",
            "destination": "CDG",
            "start": "2026-12-21",
            "end": "2026-12-22",
            "ret": "2026-12-28",
            "ret_end": "2026-12-29",
        }
        response = self.client.post("/v1/queue/actions/retry", json=filters)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["groups"], 2)
        self.assertEqual(response.json["retried"], 2)
        self.assertEqual(good.calls, 3)
        self.assertEqual(bad.calls, 0)  # Verification still gates the whole source.
        groups = self.scheduler.query_jobs()
        self.assertEqual(
            sum(s["status"] == "waiting_input" for g in groups for s in g["sources"]), 2
        )
        self.assertEqual(
            self.client.post("/v1/queue/actions/retry", json=filters).json["retried"], 0
        )
        outside_group = next(g for g in groups if g["ret"] == "2026-12-30")
        self.assertEqual(
            next(s for s in outside_group["sources"] if s["source"] == "other")["status"],
            "cancelled",
        )

    def test_range_actions_reject_missing_or_invalid_filters(self):
        for payload in (None, [], {}, {"origin": "BER", "destination": "CDG", "start": "bad"}):
            self.assertEqual(
                self.client.post("/v1/queue/actions/cancel", json=payload).status_code, 400
            )
        self.assertEqual(self.client.post("/v1/queue/actions/drop", json={}).status_code, 400)


if __name__ == "__main__":
    unittest.main()

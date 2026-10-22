"""Applying a server fix must not discard queued work or restart settled sources."""
import time
import unittest
from datetime import timedelta
from unittest import mock

from flight_scraper.scheduler import Scheduler
from tests import quiet_errorlog
from tests.test_scheduler_queue import QUERY, FakeSource
from tests.test_task_queue import eventually


class QueueRestore(unittest.TestCase):
    def setUp(self):
        quiet_errorlog(self)

    def test_finished_and_cancelled_sources_restore_without_fetching(self):
        old = Scheduler(db_path=None)
        source = FakeSource()
        try:
            old.submit(source, QUERY).result(2)
            old.block_source("test", "https://example.test/check")
            second = old.submit(source, QUERY.replace_date(QUERY.depart + timedelta(days=1)))
            old.cancel_job(second.job_id)
            groups = old.query_jobs()
        finally:
            old.shutdown()
        restored, resumed = Scheduler(db_path=None), FakeSource()
        try:
            with mock.patch.dict("flight_scraper.scheduler.REGISTRY", {"test": lambda: resumed}):
                restored.restore_query_jobs(groups)
            states = {g["depart"]: g["sources"][0]["queue_state"] for g in restored.query_jobs()}
            self.assertEqual(states[QUERY.depart.isoformat()], "done")
            self.assertEqual(states[(QUERY.depart + timedelta(days=1)).isoformat()], "cancelled")
            self.assertEqual(resumed.calls, 0)
            cancelled = next(g for g in restored.query_jobs() if g["sources"][0]["queue_state"] == "cancelled")
            self.assertEqual(restored.query_action(cancelled["id"], "retry")["retried"], 1)
            eventually(lambda: resumed.calls == 1)
        finally:
            restored.shutdown()

    def test_unfinished_jobs_restore_their_challenge_hold_and_remaining_delay(self):
        old = Scheduler(db_path=None)
        try:
            old.block_source("test", "https://example.test/check")
            old.submit(FakeSource(), QUERY)
            groups = old.query_jobs()
        finally:
            old.shutdown()
        restored, source = Scheduler(db_path=None), FakeSource()
        try:
            groups[0]["sources"][0]["ready_in"] = 0.15
            with mock.patch.dict("flight_scraper.scheduler.REGISTRY", {"test": lambda: source}):
                restored.restore_query_jobs(groups)
            self.assertEqual(restored.query_jobs()[0]["sources"][0]["queue_state"], "waiting_action")
            self.assertEqual(source.calls, 0)
            restored.clear_challenge("test")
            time.sleep(0.03)
            self.assertEqual(source.calls, 0)
            eventually(lambda: source.calls == 1)
        finally:
            restored.shutdown()

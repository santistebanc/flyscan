"""Queue behavior through the same interface used by real handlers."""
import threading
import time
import unittest
from concurrent.futures import CancelledError

from flight_scraper.task_queue import (
    ActionRequired,
    JobTimeout,
    PermanentError,
    QueueClosed,
    QueueFull,
    RateLimited,
    ResourceLimit,
    RetryableError,
    RetryPolicy,
    TaskQueue,
)


def eventually(predicate, timeout=2):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.005)
    raise AssertionError("condition did not become true before deadline")


FAST_RETRY = RetryPolicy(max_attempts=3, base_delay=0.01, max_delay=0.02)


class QueueTests(unittest.TestCase):
    def queue(self, **kwargs):
        queue = TaskQueue(**kwargs)
        self.addCleanup(queue.shutdown)
        return queue

    def test_register_and_submit_different_kinds(self):
        queue = self.queue()
        queue.register("scrape", lambda payload, context: payload["url"])
        queue.register("route", lambda payload, context: sum(payload))
        self.assertEqual(queue.submit("scrape", {"url": "example"}).future.result(2), "example")
        self.assertEqual(queue.submit("route", [1, 2, 3]).future.result(2), 6)

    def test_retries_release_worker_and_obey_budget(self):
        retrying = threading.Event()
        queue = self.queue(max_workers=1, on_event=lambda event, task: retrying.set() if event == "retry" else None)
        order = []
        def handler(payload, context):
            order.append(payload)
            if payload == "bad":
                raise RetryableError("offline")
            return payload
        queue.register("work", handler)
        bad = queue.submit("work", "bad", retry=RetryPolicy(2, 0.3, 0.3))
        self.assertTrue(retrying.wait(2))
        good = queue.submit("work", "good")
        self.assertEqual(good.future.result(2), "good")
        with self.assertRaises(RetryableError):
            bad.future.result(2)
        self.assertEqual(order, ["bad", "good", "bad"])
        self.assertEqual(bad.attempts, 2)

    def test_programming_and_permanent_errors_are_not_retried(self):
        queue = self.queue()
        for error in (PermanentError("invalid"), ValueError("bug")):
            queue.register(type(error).__name__, lambda p, ctx, error=error: (_ for _ in ()).throw(error))
            task = queue.submit(type(error).__name__, retry=FAST_RETRY)
            with self.assertRaises(type(error)):
                task.future.result(2)
            self.assertEqual(task.attempts, 1)

    def test_resource_interval_and_concurrency(self):
        queue = self.queue(max_workers=4)
        queue.limit("host", ResourceLimit(1, 0.06))
        starts = []
        running = 0
        maximum = 0
        lock = threading.Lock()
        def handler(payload, context):
            nonlocal running, maximum
            with lock:
                running += 1
                maximum = max(maximum, running)
                starts.append(time.monotonic())
            context.sleep(0.03)
            with lock:
                running -= 1
        queue.register("work", handler)
        tasks = [queue.submit("work", resource="host") for _ in range(3)]
        for task in tasks:
            task.future.result(2)
        self.assertEqual(maximum, 1)
        self.assertTrue(all(b - a >= 0.055 for a, b in zip(starts, starts[1:], strict=False)))

    def test_rate_limit_cools_whole_resource_but_not_others(self):
        notified = threading.Event()
        queue = self.queue(max_workers=1, on_event=lambda event, task: notified.set() if event == "retry" else None)
        times = {}
        calls = 0
        def handler(payload, context):
            nonlocal calls
            times[payload] = time.monotonic()
            if payload == "limited":
                calls += 1
                if calls == 1:
                    raise RateLimited(0.15)
            return payload
        queue.register("work", handler)
        limited = queue.submit("work", "limited", resource="host", retry=FAST_RETRY)
        self.assertTrue(notified.wait(2))
        first_failure = times["limited"]
        sibling = queue.submit("work", "sibling", resource="host")
        other = queue.submit("work", "other", resource="other")
        self.assertEqual(other.future.result(2), "other")
        limited.future.result(2)
        sibling.future.result(2)
        self.assertLess(times["other"], times["sibling"])
        self.assertGreaterEqual(times["limited"] - first_failure, 0.145)
        self.assertGreaterEqual(times["sibling"] - first_failure, 0.145)

    def test_rate_limit_on_last_attempt_still_cools_siblings(self):
        queue = self.queue(max_workers=1)
        queue.register("work", lambda p, ctx: (_ for _ in ()).throw(RateLimited(0.12)) if p == "bad" else time.monotonic())
        bad = queue.submit("work", "bad", retry=RetryPolicy(1))
        before = time.monotonic()
        with self.assertRaises(RateLimited):
            bad.future.result(2)
        good = queue.submit("work", "good")
        self.assertGreaterEqual(good.future.result(2) - before, 0.115)

    def test_action_releases_worker_holds_resource_and_resumes(self):
        action_seen = threading.Event()
        queue = self.queue(max_workers=1, on_event=lambda event, task: action_seen.set() if event == "action_required" else None)
        cleared = threading.Event()
        calls = []
        def handler(payload, context):
            calls.append(payload)
            if payload == "captcha" and not cleared.is_set():
                raise ActionRequired("captcha", "solve this", "https://example.test/check")
            return payload
        queue.register("work", handler)
        first = queue.submit("work", "captcha", resource="host")
        self.assertTrue(action_seen.wait(2))
        sibling = queue.submit("work", "sibling", resource="host")
        other = queue.submit("work", "other", resource="other")
        self.assertEqual(other.future.result(2), "other")
        self.assertFalse(first.future.done())
        self.assertFalse(sibling.future.done())
        self.assertEqual(calls, ["captcha", "other"])
        self.assertEqual(first.action["kind"], "captcha")
        cleared.set()
        self.assertEqual(queue.resolve_action("host"), 2)
        self.assertEqual(first.future.result(2), "captcha")
        self.assertEqual(sibling.future.result(2), "sibling")

    def test_action_expires_and_can_be_cancelled(self):
        queue = self.queue()
        queue.register("work", lambda p, ctx: (_ for _ in ()).throw(ActionRequired("login", "sign in")))
        expired = queue.submit("work", resource="a", action_timeout=0.05)
        cancelled = queue.submit("work", resource="b")
        eventually(lambda: cancelled.state == "waiting_action")
        self.assertTrue(queue.cancel(cancelled.id))
        with self.assertRaises(CancelledError):
            cancelled.future.result(2)
        with self.assertRaises(JobTimeout):
            expired.future.result(2)
        self.assertEqual(expired.attempts, 1)

    def test_action_callback_can_resolve_immediately(self):
        calls = []
        def event(name, task):
            if name == "action_required":
                queue.resolve_action(task.resource)
        queue = self.queue(on_event=event)
        def handler(payload, context):
            calls.append(1)
            if len(calls) == 1:
                raise ActionRequired("confirm", "continue")
            return "ok"
        queue.register("work", handler)
        self.assertEqual(queue.submit("work").future.result(2), "ok")

    def test_repeated_actions_have_a_budget(self):
        queue = self.queue(on_event=lambda event, task: queue.resolve_action(task.resource) if event == "action_required" else None)
        queue.register("work", lambda p, ctx: (_ for _ in ()).throw(ActionRequired("confirm", "again")))
        task = queue.submit("work")
        with self.assertRaises(PermanentError):
            task.future.result(2)
        self.assertEqual(task.attempts, 4)

    def test_timeout_is_prompt_and_retains_physical_resource_until_exit(self):
        release, entered = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        queue = self.queue(max_workers=2)
        # Cleanup order must release the fake hung handler before joining.
        self.addCleanup(release.set)
        queue.limit("host", ResourceLimit(1))
        def handler(payload, context):
            if payload == "hung":
                entered.set()
                release.wait(3)
            return payload
        queue.register("work", handler)
        task = queue.submit("work", "hung", resource="host", timeout=0.05)
        self.assertTrue(entered.wait(2))
        sibling = queue.submit("work", "sibling", resource="host")
        other = queue.submit("work", "other", resource="other")
        with self.assertRaises(JobTimeout):
            task.future.result(1)
        self.assertEqual(other.future.result(1), "other")
        self.assertFalse(sibling.future.done())
        self.assertGreaterEqual(queue.snapshot()["workers_busy"], 1)
        release.set()
        self.assertEqual(sibling.future.result(2), "sibling")
        self.assertEqual(task.state, "timed_out")
        self.assertEqual(task.attempts, 1)

    def test_cooperative_timeout_retries_without_overlap(self):
        queue = self.queue()
        calls = []
        def handler(p, ctx):
            calls.append(1)
            if len(calls) == 1:
                raise JobTimeout("request expired")
            return "ok"
        queue.register("work", handler)
        task = queue.submit("work", retry=FAST_RETRY)
        self.assertEqual(task.future.result(2), "ok")
        self.assertEqual(task.attempts, 2)

    def test_cancel_running_cooperatively(self):
        entered = threading.Event()
        queue = self.queue(max_workers=1)
        def handler(p, ctx):
            entered.set()
            ctx.sleep(10)
        queue.register("work", handler)
        task = queue.submit("work")
        self.assertTrue(entered.wait(2))
        self.assertTrue(queue.cancel(task.id))
        with self.assertRaises(CancelledError):
            task.future.result(2)
        eventually(lambda: queue.snapshot()["workers_busy"] == 0)

    def test_priority_capacity_and_shutdown_settle_all_futures(self):
        release, entered = threading.Event(), threading.Event()
        queue = self.queue(max_workers=1, max_pending=3)
        self.addCleanup(release.set)
        order = []
        def handler(p, ctx):
            if p == "first":
                entered.set()
                release.wait(2)
            order.append(p)
        queue.register("work", handler)
        first = queue.submit("work", "first")
        self.assertTrue(entered.wait(1))
        background = queue.submit("work", "background")
        foreground = queue.submit("work", "foreground", priority=0)
        with self.assertRaises(QueueFull):
            queue.submit("work")
        release.set()
        for task in (first, foreground, background):
            task.future.result(2)
        self.assertEqual(order, ["first", "foreground", "background"])
        queue.pause("held", ActionRequired("human", "wait"))
        waiting = queue.submit("work", resource="held")
        queue.shutdown()
        with self.assertRaises(CancelledError):
            waiting.future.result(1)
        with self.assertRaises(QueueClosed):
            queue.submit("work")

    def test_history_is_bounded_and_inputs_are_validated(self):
        queue = self.queue(history_limit=2)
        queue.register("work", lambda p, ctx: p)
        for i in range(5):
            queue.submit("work", i).future.result(2)
        self.assertEqual(len(queue.tasks()), 2)
        for timeout in (0, -1, float("nan"), float("inf")):
            with self.assertRaises(ValueError):
                queue.submit("work", timeout=timeout)
        with self.assertRaises(ValueError):
            queue.submit("unknown")
        for kwargs in ({"priority": "high"}, {"resource": []}, {"retry": {}}, {"kind": []}):
            with self.assertRaises(ValueError):
                queue.submit(**{"kind": "work", **kwargs})
        # Bad submissions must leave the dispatcher healthy.
        self.assertEqual(queue.submit("work", "still alive").future.result(2), "still alive")


if __name__ == "__main__":
    unittest.main()

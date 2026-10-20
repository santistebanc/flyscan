"""A process-local queue for scraping and other bounded background work.

Handlers receive (payload, context) and either return a value or raise a typed
failure. Delays and human actions live in the dispatcher, never in a worker.
Timeouts settle the caller promptly, but a non-cooperating thread keeps its
physical worker and resource slot until it exits; it is never retried in parallel.
"""

from __future__ import annotations

import math
import logging
import random
import threading
import time
from collections import deque
from concurrent.futures import CancelledError, Future, ThreadPoolExecutor
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Optional, Mapping
from types import MappingProxyType


class QueueFull(RuntimeError):
    pass


class QueueClosed(RuntimeError):
    pass


class PermanentError(RuntimeError):
    """Invalid input or another failure for which repeating work cannot help."""


class RetryableError(RuntimeError):
    """An explicitly transient failure."""


class JobTimeout(TimeoutError):
    pass


class RateLimited(RetryableError):
    def __init__(self, retry_after: float = 60.0):
        self.retry_after = _seconds(retry_after, "retry_after", allow_zero=True)
        super().__init__(f"rate limited; retry after {self.retry_after:g}s")


class ActionRequired(Exception):
    """Pause this resource until a person supplies an action resolution."""

    def __init__(self, kind: str, message: str, url: str = ""):
        super().__init__(message)
        self.kind, self.url = kind, url

    def describe(self) -> dict:
        return {"kind": self.kind, "message": str(self), "url": self.url}


def _seconds(value: float, name: str, allow_zero: bool = False) -> float:
    value = float(value)
    if not math.isfinite(value) or value < 0 or (value == 0 and not allow_zero):
        raise ValueError(f"{name} must be finite and {'nonnegative' if allow_zero else 'positive'}")
    return value


@dataclass(frozen=True)
class RetryPolicy:
    max_attempts: int = 3
    base_delay: float = 1.5
    max_delay: float = 60.0

    def __post_init__(self):
        if not isinstance(self.max_attempts, int) or self.max_attempts < 1:
            raise ValueError("max_attempts must be a positive integer")
        object.__setattr__(self, "base_delay", _seconds(self.base_delay, "base_delay", allow_zero=True))
        object.__setattr__(self, "max_delay", _seconds(self.max_delay, "max_delay", allow_zero=True))

    def delay(self, failures: int) -> float:
        return min(self.max_delay, self.base_delay * 2 ** min(failures - 1, 30)) * random.uniform(0.5, 1.0)


@dataclass(frozen=True)
class ResourceLimit:
    concurrency: int = 1
    min_interval: float = 0.0

    def __post_init__(self):
        if not isinstance(self.concurrency, int) or self.concurrency < 1:
            raise ValueError("concurrency must be a positive integer")
        object.__setattr__(self, "min_interval", _seconds(self.min_interval, "min_interval", allow_zero=True))


class _ResultFuture(Future):
    """Standard wait/callback/cancel semantics; only the queue can resolve it."""

    def set_result(self, result):
        raise AttributeError("the queue owns task completion")

    def set_exception(self, exception):
        raise AttributeError("the queue owns task completion")

    def set_running_or_notify_cancel(self):
        raise AttributeError("the queue owns task execution")

    def _mark_running(self):
        return super().set_running_or_notify_cancel()

    def _resolve(self, value=None, error=None):
        if error is not None:
            super().set_exception(error)
        else:
            super().set_result(value)


@dataclass(frozen=True)
class TaskSnapshot:
    """An observation captured atomically under the queue lock, without its payload."""

    id: int
    kind: str
    resource: str
    owner: str
    priority: int
    state: str
    attempts: int
    failures: int
    error: str
    action: Optional[Mapping[str, str]]
    retry_in: Optional[float]
    created_at: datetime
    started_at: Optional[datetime]
    finished_at: Optional[datetime]
    worker_busy: bool
    wait_reason: str = ""
    ready_in: Optional[float] = None

    @property
    def done(self):
        return self.state in ("done", "failed", "timed_out", "cancelled")

    def describe(self):
        return {
            "id": self.id, "kind": self.kind, "resource": self.resource,
            "owner": self.owner, "priority": self.priority, "state": self.state,
            "attempts": self.attempts, "failures": self.failures, "error": self.error,
            "action": dict(self.action) if self.action else None, "retry_in": self.retry_in,
            "created_at": self.created_at.isoformat(),
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "finished_at": self.finished_at.isoformat() if self.finished_at else None,
            "worker_busy": self.worker_busy,
            "wait_reason": self.wait_reason, "ready_in": self.ready_in,
        }


@dataclass(frozen=True)
class Task:
    """Submission handle: a result future and read-only current observations."""

    id: int
    future: Future
    _read: Callable[[], TaskSnapshot] = field(repr=False, compare=False)

    def describe(self):
        return self._read().describe()

    def snapshot(self):
        """Read even after this task has left the queue's bounded history."""
        return self._read()

    @property
    def state(self):
        return self._read().state

    @property
    def done(self):
        return self._read().done

    @property
    def attempts(self):
        return self._read().attempts

    @property
    def action(self):
        return self._read().action


@dataclass
class _Task:
    id: int
    kind: str
    payload: Any
    resource: str
    owner: str
    priority: int
    timeout: float
    retry: RetryPolicy
    action_timeout: float
    future: Future = field(default_factory=lambda: _ResultFuture())
    state: str = "queued"
    attempts: int = 0
    failures: int = 0
    action_requests: int = 0
    error: str = ""
    action: Optional[dict] = None
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    available_at: float = 0.0
    action_deadline: float = 0.0
    context: Optional["JobContext"] = field(default=None, repr=False)

    @property
    def done(self) -> bool:
        return self.state in ("done", "failed", "timed_out", "cancelled")



class JobContext:
    def __init__(self, task: _Task):
        self.task_id = task.id
        self.deadline = time.monotonic() + task.timeout
        self.cancelled = threading.Event()

    def check(self) -> None:
        if time.monotonic() >= self.deadline:
            raise JobTimeout("job attempt exceeded its deadline")
        if self.cancelled.is_set():
            raise CancelledError("job cancelled")

    def remaining(self) -> float:
        self.check()
        return max(0.001, self.deadline - time.monotonic())

    def sleep(self, seconds: float) -> None:
        self.cancelled.wait(min(seconds, self.remaining()))
        self.check()


_CONTEXT: ContextVar[Optional[JobContext]] = ContextVar("queue_context", default=None)


def current_context() -> Optional[JobContext]:
    return _CONTEXT.get()


class TaskQueue:
    def __init__(self, max_workers: int = 12, max_pending: int = 10000,
                 history_limit: int = 200, on_event: Optional[Callable[[str, TaskSnapshot], None]] = None):
        if any(not isinstance(n, int) or n < 1 for n in (max_workers, max_pending, history_limit)):
            raise ValueError("worker, pending and history limits must be positive")
        if on_event is not None and not callable(on_event):
            raise ValueError("on_event must be callable")
        self.max_workers, self.max_pending = max_workers, max_pending
        self._handlers: Dict[str, Callable] = {}
        self._limits: Dict[str, ResourceLimit] = {}
        self._busy: Dict[str, int] = {}
        self._next_start: Dict[str, float] = {}
        self._actions: Dict[str, tuple] = {}
        self._tasks: Dict[int, _Task] = {}
        self._active: Dict[int, _Task] = {}
        self._history = deque(maxlen=history_limit)
        self._notifications = deque()
        self._on_event = on_event
        self._next_id = 0
        self._closed = False
        self._cv = threading.Condition(threading.RLock())
        self._pool = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="job")
        self._dispatcher = threading.Thread(target=self._loop, name="queue-dispatch", daemon=True)
        self._dispatcher.start()

    def register(self, kind: str, handler: Callable[[Any, JobContext], Any]) -> None:
        if not isinstance(kind, str) or not kind or not callable(handler):
            raise ValueError("a nonempty kind and callable handler are required")
        with self._cv:
            if kind in self._handlers:
                raise ValueError(f"handler already registered: {kind}")
            self._handlers[kind] = handler

    def limit(self, resource: str, limit: ResourceLimit) -> None:
        if not isinstance(resource, str) or not resource or not isinstance(limit, ResourceLimit):
            raise ValueError("a resource name and ResourceLimit are required")
        with self._cv:
            previous = self._limits.get(resource)
            if previous is not None and previous != limit:
                raise ValueError(f"conflicting limits for resource {resource}")
            self._limits[resource] = limit

    def submit(self, kind: str, payload: Any = None, *, resource: Optional[str] = None,
               owner: str = "", priority: int = 10, timeout: float = 120,
               retry: Optional[RetryPolicy] = None, action_timeout: float = 900,
               delay: float = 0) -> Task:
        timeout = _seconds(timeout, "timeout")
        action_timeout = _seconds(action_timeout, "action_timeout")
        delay = _seconds(delay, "delay", allow_zero=True)
        if not isinstance(kind, str) or not kind:
            raise ValueError("kind must be a nonempty string")
        if resource is not None and (not isinstance(resource, str) or not resource):
            raise ValueError("resource must be a nonempty string")
        if not isinstance(priority, int):
            raise ValueError("priority must be an integer")
        if retry is not None and not isinstance(retry, RetryPolicy):
            raise ValueError("retry must be a RetryPolicy")
        with self._cv:
            if self._closed:
                raise QueueClosed("queue is shutting down")
            if kind not in self._handlers:
                raise ValueError(f"no handler registered: {kind}")
            if sum(not t.done or t.id in self._active for t in self._tasks.values()) >= self.max_pending:
                raise QueueFull(f"queue capacity ({self.max_pending}) reached")
            self._next_id += 1
            task = _Task(self._next_id, kind, payload, resource or kind, owner, priority,
                        timeout, retry or RetryPolicy(), action_timeout)
            task.available_at = time.monotonic() + delay
            self._tasks[task.id] = task
            task.future.add_done_callback(lambda future: self._wake())
            if task.resource in self._actions:
                self._hold(task, *self._actions[task.resource])
            self._cv.notify_all()
            return Task(task.id, task.future, lambda: self._read_task(task))

    def get(self, task_id: int) -> Optional[TaskSnapshot]:
        with self._cv:
            task = self._tasks.get(task_id)
            return self._snapshot(task) if task else None

    def _wake(self):
        with self._cv:
            self._cv.notify_all()

    def _read_task(self, task):
        with self._cv:
            return self._snapshot(task)

    def _snapshot(self, task):
        wait_reason, ready_in = "", None
        if task.state in ("queued", "retry_wait"):
            now = time.monotonic()
            limit = self._limits.get(task.resource, ResourceLimit(self.max_workers))
            ready_in = max(0.0, max(task.available_at, self._next_start.get(task.resource, 0)) - now)
            if self._next_start.get(task.resource, 0) > now:
                wait_reason = "rate_limit"
            elif task.available_at > now:
                wait_reason = "retry_delay"
            elif self._busy.get(task.resource, 0) >= limit.concurrency:
                wait_reason = "source_busy"
            else:
                wait_reason = "capacity"
        return TaskSnapshot(
            task.id, task.kind, task.resource, task.owner, task.priority, task.state,
            task.attempts, task.failures, task.error,
            MappingProxyType(dict(task.action)) if task.action else None,
            max(0.0, task.available_at - time.monotonic()) if task.state == "retry_wait" else None,
            task.created_at, task.started_at, task.finished_at, task.id in self._active,
            wait_reason, ready_in,
        )

    def tasks(self) -> list:
        with self._cv:
            return [self._snapshot(task) for task in self._tasks.values()]

    def prioritize(self, task_id: int, priority: int) -> bool:
        if not isinstance(priority, int):
            raise ValueError("priority must be an integer")
        with self._cv:
            task = self._tasks.get(task_id)
            if task is None or task.done or task.id in self._active:
                return False
            task.priority = priority
            self._cv.notify_all()
            return True

    def prioritize_many(self, priorities: Mapping[int, int]) -> int:
        """Replace a view's priorities atomically with respect to dispatch."""
        if any(not isinstance(value, int) for value in priorities.values()):
            raise ValueError("priority must be an integer")
        with self._cv:
            changed = 0
            for task_id, priority in priorities.items():
                task = self._tasks.get(task_id)
                if task is not None and not task.done and task_id not in self._active:
                    task.priority = priority
                    changed += 1
            self._cv.notify_all()
            return changed

    def cancel(self, task_id: int, *, running: bool = True) -> bool:
        with self._cv:
            task = self._tasks.get(task_id)
            if task is None or task.done or (not running and task_id in self._active):
                return False
            if task.context:
                task.context.cancelled.set()
            self._finish(task, "cancelled", error=CancelledError("job cancelled"))
            self._cv.notify_all()
            return True

    def cancel_many(self, task_ids, *, running: bool = True) -> int:
        """Cancel a group without allowing dispatch between its members."""
        with self._cv:
            return sum(self.cancel(task_id, running=running) for task_id in task_ids)

    def pause(self, resource: str, action: ActionRequired) -> None:
        with self._cv:
            # Keep the first deadline: repeated challenges cannot extend a wait forever.
            record = self._actions.setdefault(resource, (action, time.monotonic()))
            for task in self._tasks.values():
                if task.resource == resource and not task.done and task.id not in self._active:
                    self._hold(task, *record)
            self._cv.notify_all()

    def resolve_action(self, resource: str) -> int:
        with self._cv:
            self._actions.pop(resource, None)
            resumed = 0
            for task in self._tasks.values():
                if task.resource == resource and task.state == "waiting_action":
                    task.state, task.action, task.error = "queued", None, ""
                    resumed += 1
            self._cv.notify_all()
            return resumed

    def _hold(self, task: _Task, action: ActionRequired, since: float) -> None:
        task.state, task.action, task.error = "waiting_action", action.describe(), str(action)
        task.action_deadline = since + task.action_timeout

    def _finish(self, task: _Task, state: str, value: Any = None, error: Optional[BaseException] = None):
        task.state = state
        task.error = str(error) if error else ""
        task.finished_at = datetime.now(timezone.utc)
        task.action = None
        if len(self._history) == self._history.maxlen:
            old = self._history[0]
            if old not in self._active:
                self._tasks.pop(old, None)
        self._history.append(task.id)
        self._notifications.append(("finished", task, value, error, self._snapshot(task)))

    def _loop(self):
        while True:
            with self._cv:
                now = time.monotonic()
                for task in list(self._tasks.values()):
                    if task.done:
                        continue
                    if task.future.cancelled():
                        if task.context:
                            task.context.cancelled.set()
                        self._finish(task, "cancelled", error=CancelledError("job cancelled"))
                    elif task.state == "waiting_action" and now >= task.action_deadline:
                        self._finish(task, "timed_out", error=JobTimeout("user action was not resolved in time"))
                    elif task.id in self._active and now >= task.context.deadline:
                        task.context.cancelled.set()
                        self._finish(task, "timed_out", error=JobTimeout("job attempt exceeded its deadline"))

                # Capacity follows physical threads, including timed-out handlers.
                if not self._closed and not self._notifications and len(self._active) < self.max_workers:
                    for task in sorted(self._tasks.values(), key=lambda t: (t.priority, t.id)):
                        if task.state not in ("queued", "retry_wait") or task.id in self._active:
                            continue
                        if task.resource in self._actions:
                            self._hold(task, *self._actions[task.resource])
                            continue
                        limit = self._limits.get(task.resource, ResourceLimit(self.max_workers))
                        if (now < max(task.available_at, self._next_start.get(task.resource, 0))
                                or self._busy.get(task.resource, 0) >= limit.concurrency):
                            continue
                        if not task.future.running() and not task.future._mark_running():
                            self._finish(task, "cancelled", error=CancelledError("job cancelled"))
                            continue
                        task.state, task.error, task.action = "running", "", None
                        task.attempts += 1
                        task.started_at = datetime.now(timezone.utc)
                        task.context = JobContext(task)
                        self._active[task.id] = task
                        self._busy[task.resource] = self._busy.get(task.resource, 0) + 1
                        self._next_start[task.resource] = now + limit.min_interval
                        self._pool.submit(self._execute, task)
                        if len(self._active) >= self.max_workers:
                            break
                notices = list(self._notifications)
                self._notifications.clear()
                exiting = self._closed and not self._active and not notices
                if not notices and not exiting:
                    self._cv.wait(timeout=self._wait_time())
            # No client callback runs while holding the queue lock.
            for event, task, value, error, observation in notices:
                if event == "finished" and not task.future.done():
                    if error:
                        task.future._resolve(error=error)
                    else:
                        task.future._resolve(value=value)
                if self._on_event:
                    try:
                        self._on_event(event, observation)
                    except Exception:
                        # Observers cannot change execution or strand futures.
                        logging.getLogger(__name__).exception("queue observer failed")
            if exiting:
                return

    def _wait_time(self):
        """Sleep until the next deadline or eligible start; workers wake us earlier."""
        now, due = time.monotonic(), []
        for task in self._tasks.values():
            if task.done:
                continue
            if task.id in self._active:
                due.append(task.context.deadline)
            elif task.state == "waiting_action":
                due.append(task.action_deadline)
            elif len(self._active) < self.max_workers:
                limit = self._limits.get(task.resource, ResourceLimit(self.max_workers))
                if self._busy.get(task.resource, 0) < limit.concurrency:
                    due.append(max(task.available_at, self._next_start.get(task.resource, 0)))
        return max(0.001, min(due) - now) if due else None

    def _execute(self, task: _Task):
        value, error = None, None
        token = _CONTEXT.set(task.context)
        try:
            task.context.check()
            value = self._handlers[task.kind](task.payload, task.context)
            task.context.check()
        except BaseException as exc:
            error = exc
        finally:
            _CONTEXT.reset(token)
        with self._cv:
            self._active.pop(task.id, None)
            self._busy[task.resource] -= 1
            # A response received while cancellation/timeout is winding down
            # still imposes a source-wide cooldown on every subsequent task.
            if isinstance(error, RateLimited):
                self._next_start[task.resource] = max(
                    self._next_start.get(task.resource, 0), time.monotonic() + error.retry_after)
            if not task.done:
                if isinstance(error, ActionRequired):
                    task.action_requests += 1
                    if task.action_requests > 3:
                        self._finish(task, "failed", error=PermanentError("user action requested repeatedly"))
                    else:
                        self.pause(task.resource, error)
                        self._notifications.append(("action_required", task, None, error, self._snapshot(task)))
                elif isinstance(error, CancelledError):
                    self._finish(task, "cancelled", error=error)
                elif error is not None:
                    task.failures += 1
                    if (isinstance(error, (RetryableError, TimeoutError, ConnectionError))
                            and task.failures < task.retry.max_attempts and not self._closed):
                        task.state, task.error = "retry_wait", str(error)
                        task.available_at = time.monotonic() + task.retry.delay(task.failures)
                        self._notifications.append(("retry", task, None, error, self._snapshot(task)))
                    else:
                        self._finish(task, "timed_out" if isinstance(error, TimeoutError) else "failed", error=error)
                else:
                    self._finish(task, "done", value=value)
            elif task.id not in self._history:
                self._tasks.pop(task.id, None)
            self._cv.notify_all()

    def snapshot(self) -> dict:
        with self._cv:
            counts = {s: 0 for s in ("queued", "running", "retry_wait", "waiting_action")}
            for task in self._tasks.values():
                if task.state in counts:
                    counts[task.state] += 1
            return {**counts, "workers_busy": len(self._active), "max_workers": self.max_workers,
                    "closed": self._closed}

    def shutdown(self, wait: bool = True) -> None:
        with self._cv:
            self._closed = True
            for task in list(self._tasks.values()):
                if not task.done:
                    self.cancel(task.id)
            self._cv.notify_all()
        if wait:
            self._dispatcher.join()
        self._pool.shutdown(wait=wait)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.shutdown()

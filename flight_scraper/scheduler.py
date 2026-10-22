"""Flight-specific adapter over the shared background task queue."""
from __future__ import annotations

import os
import threading
import time
from concurrent.futures import CancelledError, Future
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path
from types import MappingProxyType
from typing import Callable, Dict, List, Optional

from . import errorlog
from .cache import offers_from_dicts, offers_to_dicts
from .challenge import ChallengeCoordinator
from .models import SearchQuery
from .query_jobs import belongs_to, query_job_id
from .sources import REGISTRY, ChallengeRequired, Source, SourceResult
from .store import DEFAULT_MAX_RETRIES, DEFAULT_TTL, FlightStore, query_key
from .task_queue import (
    ActionRequired,
    QueueClosed,
    QueueFull,
    ResourceLimit,
    RetryPolicy,
    Task,
    TaskQueue,
)

ProgressHook = Callable[[str, dict], None]
DEFAULT_MAX_WORKERS = 12
FOREGROUND = 0
BACKGROUND = 10


def _noop(event, data):
    pass


class ScrapeFuture(Future):
    """A normal result future with the queue ID, absent for cached answers."""

    def __init__(self):
        super().__init__()
        self.job_id: Optional[int] = None


@dataclass
class _Subscriber:
    future: Future
    owner: str
    on_progress: ProgressHook
    cancelled: Optional[threading.Event]


@dataclass
class _ScrapeJob:
    source_obj: Source
    query: SearchQuery
    refresh: bool
    key: str
    subscribers: List[_Subscriber] = field(default_factory=list)
    task: Optional[Task] = None
    fetch_id: Optional[int] = None
    count: int = 0
    url: str = ""
    ttl: object = None
    cached: Optional[SourceResult] = None
    restored_snapshot: Optional[dict] = None
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    @property
    def id(self):
        return self.task.id if self.task else None

    @property
    def source(self):
        return self.source_obj.name


@dataclass(frozen=True)
class JobSnapshot:
    _data: object = field(repr=False)

    @property
    def id(self):
        return self._data["id"]

    @property
    def state(self):
        return self._data["state"]

    @property
    def done(self):
        return self._data["queue_state"] in ("done", "failed", "timed_out", "cancelled")

    def describe(self):
        data = dict(self._data)
        if data["action"]:
            data["action"] = dict(data["action"])
        return data



class Scheduler:
    def __init__(self, max_workers=DEFAULT_MAX_WORKERS, db_path="flights.db", ttl=None,
                 max_retries=DEFAULT_MAX_RETRIES, *, max_pending=10000,
                 action_timeout=900, retry_policy=None):
        self.max_workers = max_workers
        self.database_path = str(Path(db_path).resolve()) if db_path else None
        self.ttl = DEFAULT_TTL if ttl is None else ttl
        self.max_retries = max_retries
        self.action_timeout, self.retry_policy = action_timeout, retry_policy
        self.store = FlightStore(db_path) if db_path else None
        self._store_lock = threading.RLock()
        self._lock = threading.RLock()
        self._pending: Dict[str, _ScrapeJob] = {}
        self._jobs: Dict[int, _ScrapeJob] = {}
        # Latest source state per exact query. History is bounded by whole groups,
        # so finishing many other sources cannot erase half of a query job.
        self._query_jobs: Dict[str, Dict[str, _ScrapeJob]] = {}
        self._selection = None
        self._selection_set = False
        self._closed = False
        self.stats = {"cached": 0, "shared": 0, "scraped": 0}
        self.queue = TaskQueue(max_workers, max_pending, on_event=self._queue_event)
        self.queue.register("scrape", self._execute)
        for name, cls in REGISTRY.items():
            self.queue.limit(name, ResourceLimit(cls.max_concurrency, cls.min_interval))
        self.challenge_control = ChallengeCoordinator(
            self.store, self.queue, ledger_lock=self._store_lock,
        )

    def submit(self, source, query, on_progress=_noop, cancelled=None, refresh=False,
               owner="", priority=BACKGROUND, *, ttl=None, delay=0):
        """Push a scrape and immediately get its future. Identical live work is shared."""
        subscriber = _Subscriber(ScrapeFuture(), owner, on_progress, cancelled)
        if cancelled is not None and cancelled.is_set():
            subscriber.future.set_result(SourceResult(source=source.name, error="cancelled"))
            return subscriber.future
        with self._lock:
            if self._closed:
                raise QueueClosed("scheduler is shutting down")
            if cancelled is not None and cancelled.is_set():
                subscriber.future.set_result(SourceResult(source=source.name, error="cancelled"))
                return subscriber.future
            key = query_key(source.name, query)
            if self._selection_set:
                priority = FOREGROUND if self._matches(query) else BACKGROUND
            job = self._pending.get(key)
            # Until completion removes this entry, it also owns notification of
            # every subscriber, even if the worker has just become terminal.
            if job is not None:
                job.subscribers.append(subscriber)
                subscriber.future.job_id = job.id
                self.stats["shared"] += 1
                if priority < self.queue.get(job.id).priority:
                    self.queue.prioritize(job.id, priority)
                return subscriber.future
            settled = self._precheck(source, query, on_progress, refresh, ttl)
            if settled is not None:
                cached = _ScrapeJob(source, query, refresh, key, url=_safe_url(source, query),
                                    ttl=ttl, cached=settled, count=settled.count)
                self._remember(cached)
                subscriber.future.set_result(settled)
                return subscriber.future
            self.queue.limit(source.name, ResourceLimit(source.max_concurrency, source.min_interval))
            self._prune_jobs()
            job = _ScrapeJob(source, query, refresh, key, [subscriber], url=_safe_url(source, query), ttl=ttl)
            # The handler takes this lock before it reads the assigned task.
            job.task = self.queue.submit(
                "scrape", job, resource=source.name, owner=owner, priority=priority,
                timeout=source.job_timeout, action_timeout=self.action_timeout,
                retry=self.retry_policy or RetryPolicy(max_attempts=source.retries),
                delay=delay,
            )
            self._pending[key] = job
            self._jobs[job.id] = job
            self._remember(job)
            subscriber.future.job_id = job.id
            job.task.future.add_done_callback(lambda future: self._complete(job, future))
        return subscriber.future

    def _precheck(self, source, query, on_progress, refresh, ttl=None):
        if self.store is None or refresh:
            return None
        with self._store_lock:
            plan = self.store.plan(query, [source.name], ttl=self.ttl if ttl is None else ttl,
                                   max_retries=self.max_retries)[source.name]
        # A challenge is resumable work rather than a cached error.
        if plan["fetch"] or plan["why"] == "needs a human":
            return None
        if plan["why"] != "fresh":
            return SourceResult(source=source.name, url=_safe_url(source, query), error=plan["why"])
        self.stats["cached"] += 1
        self._notify(on_progress, "source_done", {
            "source": source.name, "day": query.depart, "ret": query.ret,
            "scrape_id": None, "attempt": 0, "count": plan.get("count", 0),
            "error": "", "elapsed": 0.0, "origin": "cache",
            "age_hours": plan.get("age_hours"), "url": _safe_url(source, query),
        })
        return SourceResult(source=source.name, url=_safe_url(source, query), found=plan.get("count", 0))

    def _execute(self, job, context):
        with self._lock:
            live = [s for s in job.subscribers if not s.future.done()
                    and not (s.cancelled and s.cancelled.is_set())]
            if not live:
                raise CancelledError("search cancelled")
            # Subsequent attempts own the loading row and must not skip themselves.
            cached = self._precheck(job.source_obj, job.query, _noop, job.refresh, job.ttl) if job.fetch_id is None else None
            if cached is not None:
                return cached
            if self.store is not None:
                with self._store_lock:
                    job.fetch_id = self.store.begin_fetch(job.query, job.source)
        self._emit(job, "source_start", source=job.source, day=job.query.depart)
        try:
            result = job.source_obj.run_once(job.query)
            context.check()
        except ChallengeRequired as challenge:
            with self._lock:
                context.check()
                self.challenge_control.record(job.source, challenge.url, job.fetch_id)
            raise ActionRequired("captcha", str(challenge), challenge.url) from challenge
        # Late results after cancellation or timeout never write to storage.
        with self._lock:
            context.check()
            if self.store is not None and job.fetch_id is not None:
                with self._store_lock:
                    self.store.complete_fetch(job.fetch_id, result.offers)
            job.count = result.count
            self.stats["scraped"] += 1
        return result

    def _complete(self, job, future):
        try:
            result = future.result()
        except BaseException as exc:
            result = SourceResult(source=job.source, url=job.url,
                                  error=f"{type(exc).__name__}: {exc}")
            # Preserve durable challenge records even when the waiting job expires
            # or is cancelled. A failing ledger must not strand its subscribers.
            try:
                with self._lock:
                    challenged = job.source in self.challenge_control.pending()
                    with self._store_lock:
                        if self.store is not None and job.fetch_id is not None and not challenged:
                            self.store.fail_fetch(job.fetch_id, result.error)
            except Exception as ledger_error:
                errorlog.record("scheduler.ledger", ledger_error, job=job.id)
            if not isinstance(exc, CancelledError):
                errorlog.record(f"source.{job.source}", result.error, job=job.id,
                                route=f"{job.query.origin}-{job.query.destination}",
                                depart=job.query.depart, ret=job.query.ret,
                                attempts=job.task.attempts, url=job.url)
        with self._lock:
            if self._pending.get(job.key) is job:
                self._pending.pop(job.key, None)
            subscribers = list(job.subscribers)
        for index, subscriber in enumerate(subscribers):
            if subscriber.future.done():
                continue
            answer = result
            if subscriber.cancelled and subscriber.cancelled.is_set():
                answer = SourceResult(source=job.source, error="cancelled")
            elif index and result.offers:
                answer = SourceResult(source=result.source, url=result.url, error=result.error,
                                      elapsed=result.elapsed, found=result.found,
                                      offers=offers_from_dicts(offers_to_dicts(result.offers), job.source, job.query))
            self._notify(subscriber.on_progress, "source_done", {
                "source": job.source, "day": job.query.depart, "ret": job.query.ret,
                "scrape_id": job.id, "attempt": job.task.attempts, "count": answer.count,
                "error": answer.error, "elapsed": answer.elapsed,
                "origin": "shared" if index else "scrape", "url": answer.url,
            })
            with self._lock:
                if not subscriber.future.done():
                    subscriber.future.set_result(answer)

    @staticmethod
    def _notify(callback, event, data):
        try:
            callback(event, data)
        except Exception as exc:
            errorlog.record("scheduler.progress", exc, event=event)

    def _emit(self, job, event, **data):
        data = {"scrape_id": job.id, "attempt": job.task.attempts,
                "ret": job.query.ret, **data}
        with self._lock:
            subscribers = list(job.subscribers)
        for subscriber in subscribers:
            if not subscriber.future.done():
                self._notify(subscriber.on_progress, event, data)

    def _queue_event(self, event, task):
        if task.kind != "scrape":
            return
        with self._lock:
            job = self._jobs.get(task.id)
        if job is None:
            return
        if event == "action_required":
            self._emit(job, "challenge_required", source=job.source, day=job.query.depart,
                       url=(task.action or {}).get("url", ""))
        elif event == "retry":
            self._emit(job, "source_retry", source=job.source, day=job.query.depart,
                       attempt=task.attempts, error=task.error,
                       retry_in=task.retry_in)

    def focus(self, owner):
        count = 0
        with self._lock:
            if self._selection_set:
                return 0  # The selected filters own priority once a view is attached.
            for task in self.queue.tasks():
                job = self._jobs.get(task.id)
                if job and not task.done:
                    priority = FOREGROUND if any(s.owner == owner and not s.future.done()
                        for s in job.subscribers) else BACKGROUND
                    count += self.queue.prioritize(task.id, priority)
        return count

    def cancel_owner(self, owner):
        count = 0
        with self._lock:
            for job in list(self._pending.values()):
                for sub in job.subscribers:
                    if sub.owner == owner and not sub.future.done():
                        sub.future.set_result(SourceResult(source=job.source, error="cancelled"))
                        count += 1
                if all(s.future.done() for s in job.subscribers):
                    self.queue.cancel(job.id, running=False)
        return count

    def cancel_job(self, job_id):
        task = self.queue.get(job_id)
        if task is None or task.done:
            return "gone"
        return "cancelled" if self.queue.cancel(job_id) else "gone"

    def cancel_queued(self):
        return sum(self.queue.cancel(t.id, running=False) for t in self.queue.tasks() if t.kind == "scrape")

    def promote_job(self, job_id):
        with self._lock:
            job = self._jobs.get(job_id)
            priority = FOREGROUND if not self._selection_set or (job and self._matches(job.query)) else 5
            return self.queue.prioritize(job_id, priority)

    @staticmethod
    def _query_fields(query):
        return {"origin": query.origin, "destination": query.destination,
                "route": f"{query.origin}-{query.destination}",
                "depart": query.depart.isoformat(), "ret": query.ret.isoformat() if query.ret else "",
                "adults": query.adults, "children": query.children, "infants": query.infants,
                "cabin": query.cabin, "currency": query.currency}

    def _matches(self, query):
        return belongs_to(self._query_fields(query), self._selection)

    def select_query(self, selection):
        """Replace foreground selection for both existing and future work."""
        with self._lock:
            self._selection_set = True
            self._selection = dict(selection) if selection else None
            self.queue.prioritize_many({job.id: FOREGROUND if self._matches(job.query) else BACKGROUND
                                        for job in self._jobs.values()})

    def _remember(self, job):
        group_id = query_job_id(job.query)
        group = self._query_jobs.pop(group_id, {})
        group[job.source] = job
        self._query_jobs[group_id] = group
        self._prune_jobs()

    def _prune_jobs(self):
        # Retain the most recently updated 100 completed groups and every live
        # group, including cancelled handlers still releasing their source slot.
        completed = [key for key, group in self._query_jobs.items()
                     if all(j.task is None or (j.task.done and not j.task.snapshot().worker_busy)
                            for j in group.values())]
        for key in completed[:-100]:
            del self._query_jobs[key]
        retained = {task.id for task in self.queue.tasks()}
        retained.update(j.id for group in self._query_jobs.values() for j in group.values() if j.id is not None)
        self._jobs = {key: job for key, job in self._jobs.items() if key in retained}

    def _describe_job(self, job, task):
        if task is None and job.restored_snapshot is not None:
            return JobSnapshot(MappingProxyType(dict(job.restored_snapshot)))
        q = job.query
        params = []
        if (q.adults, q.children, q.infants) != (1, 0, 0):
            params.append(f"{q.adults} adults, {q.children} children, {q.infants} infants")
        if q.cabin != "economy":
            params.append(q.cabin.title())
        if task is None:
            data = {"id": None, "state": "done" if job.cached.ok else "failed",
                    "queue_state": "done" if job.cached.ok else "failed", "status": "cached" if job.cached.ok else "failed",
                    "source": job.source, "query_id": query_job_id(q), **self._query_fields(q),
                    "params": " · ".join(params), "owner": "", "priority": BACKGROUND,
                    "attempts": 0, "failures": 0, "queued_at": job.created_at.isoformat(),
                    "created_at": job.created_at.isoformat(), "started_at": None,
                    "finished_at": job.created_at.isoformat(), "count": job.count,
                    "error": job.cached.error, "action": None, "elapsed": None, "waited": 0,
                    "worker_busy": False, "retry_in": None, "ready_in": None, "wait_reason": ""}
            return JobSnapshot(MappingProxyType(data))
        end = task.finished_at or datetime.now(timezone.utc)
        status = {"queued": "waiting", "retry_wait": "retrying", "waiting_action": "waiting_input",
                  "done": "completed"}.get(task.state, task.state)
        if task.state == "queued" and task.wait_reason == "rate_limit":
            status = "rate_limited"
        if task.done and task.worker_busy:
            status = "cancelling" if task.state == "cancelled" else "stopping"
        data = {
            **task.describe(),
            "state": {"retry_wait": "queued", "waiting_action": "blocked", "timed_out": "failed"}.get(task.state, task.state),
            "queue_state": task.state, "source": job.source,
            "status": status, "query_id": query_job_id(q),
            "origin": q.origin, "destination": q.destination, "currency": q.currency,
            "route": f"{q.origin}-{q.destination}", "depart": q.depart.isoformat(),
            "ret": q.ret.isoformat() if q.ret else "", "params": " · ".join(params),
            "adults": q.adults, "children": q.children, "infants": q.infants, "cabin": q.cabin,
            "queued_at": task.created_at.isoformat(), "count": job.count,
            "elapsed": round((end - task.started_at).total_seconds(), 1) if task.started_at else None,
            "waited": round(((task.started_at or end) - task.created_at).total_seconds(), 1),
        }
        if data["action"]:
            data["action"] = MappingProxyType(data["action"])
        return JobSnapshot(MappingProxyType(data))

    def find_job(self, job_id):
        with self._lock:
            job = self._jobs.get(job_id)
            return self._describe_job(job, job.task.snapshot()) if job else None

    def retry_job(self, job_id):
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None or not job.task.done or job.task.snapshot().worker_busy:
                return None
            pending = self._pending.get(job.key)
            if pending is job:
                if not job.task.future.done():
                    return None  # Completion has not delivered the old subscribers yet.
                self._pending.pop(job.key, None)
            future = self.submit(job.source_obj, job.query, refresh=True, owner=job.task.snapshot().owner,
                                 priority=FOREGROUND, ttl=job.ttl)
            return future.job_id

    def query_jobs(self):
        with self._lock:
            self._prune_jobs()
            result = []
            for group_id, group in self._query_jobs.items():
                jobs = [self._describe_job(j, j.task.snapshot() if j.task else None).describe()
                        for j in group.values()]
                first = next(iter(group.values()))
                result.append({"id": group_id, **self._query_fields(first.query),
                               "mine": self._matches(first.query),
                               "sources": sorted(jobs, key=lambda j: j["source"]),
                               "created_at": min(j["queued_at"] for j in jobs)})
            return result

    def restore_query_jobs(self, groups, *, captured_at=None):
        """Restore a trusted maintenance snapshot without retrying settled work.

        Finished rows remain history. Unfinished tasks resume through the normal
        dispatcher, retaining their priority, source gates and remaining cooldowns.
        Call only on a fresh scheduler before serving requests.
        """
        elapsed = max(0, time.time() - captured_at) if captured_at is not None else 0
        sources, resume = {}, []
        with self._lock:
            if self._query_jobs:
                raise ValueError("queue restoration requires a fresh scheduler")
            for group in groups:
                query = SearchQuery(group["origin"], group["destination"], date.fromisoformat(group["depart"]),
                                    date.fromisoformat(group["ret"]) if group.get("ret") else None,
                                    group["adults"], group["children"], group["infants"], group["cabin"], group["currency"])
                for data in group["sources"]:
                    name = data["source"]
                    if name not in sources:
                        sources[name] = REGISTRY[name]()
                    source = sources[name]
                    state = data["queue_state"]
                    if state not in ("done", "failed", "timed_out", "cancelled"):
                        if state == "waiting_action" and (data.get("action") or {}).get("url"):
                            self.block_source(name, data["action"]["url"])
                        delay = max(0, (data.get("ready_in") or 0) - elapsed)
                        if state == "running":
                            delay = max(delay, source.min_interval - (data.get("elapsed") or 0) - elapsed)
                        resume.append((data, source, query, delay))
                        continue
                    error = "" if state == "done" else (data.get("error") or state)
                    result = SourceResult(source=name, error=error, found=data.get("count", 0))
                    snapshot = {**data, "id": None, "worker_busy": False, "retry_in": None, "ready_in": None}
                    if state != "done":
                        snapshot["status"] = state
                    job = _ScrapeJob(source, query, False, query_key(name, query),
                                     cached=result, count=data.get("count", 0), restored_snapshot=snapshot,
                                     created_at=datetime.fromisoformat(data["queued_at"]))
                    self._remember(job)
            for data, source, query, delay in sorted(resume, key=lambda entry: (entry[0]["priority"], entry[0]["id"])):
                self.submit(source, query, refresh=True, owner=data["owner"], priority=data["priority"], delay=delay)

    def query_action(self, group_id, action, source=None):
        """Apply an action to the latest tasks of exactly one query job."""
        with self._lock:
            group = self._query_jobs.get(group_id)
            if group is None or (source is not None and source not in group):
                return None
            jobs = [group[source]] if source else list(group.values())
            counts = {"cancelled": 0, "retried": 0, "skipped": 0, "errors": []}
            if action == "cancel":
                counts["cancelled"] = self.queue.cancel_many(j.id for j in jobs if j.task)
                counts["skipped"] = len(jobs) - counts["cancelled"]
                return counts
            for job in jobs:
                if action == "retry":
                    # Group retry preserves successful sources. Source retry is
                    # also available for a successful result as an explicit refresh.
                    state = job.task.state if job.task else ("done" if job.cached.ok else "failed")
                    if (job.task and (not job.task.done or job.task.snapshot().worker_busy)) or (not source and state == "done"):
                        counts["skipped"] += 1
                        continue
                    try:
                        if job.task:
                            new_id = self.retry_job(job.id)
                        else:
                            new_id = self.submit(job.source_obj, job.query, refresh=True, ttl=job.ttl).job_id
                        counts["retried" if new_id is not None else "skipped"] += 1
                    except (QueueClosed, QueueFull) as exc:
                        counts["skipped"] += 1
                        counts["errors"].append({"source": job.source, "error": str(exc)})
            return counts

    def selection_action(self, selection, action):
        """Apply a range action to all matching groups under one scheduler lock.

        Membership comes from the supplied filters, never the latest search
        subscription or the process-wide foreground selection.
        """
        if action not in ("cancel", "retry"):
            raise ValueError("unknown queue action")
        with self._lock:
            groups = [(group_id, group) for group_id, group in self._query_jobs.items()
                      if belongs_to(self._query_fields(next(iter(group.values())).query), selection)]
            result = {"groups": len(groups), "cancelled": 0, "retried": 0, "skipped": 0, "errors": []}
            if action == "cancel":
                jobs = [job for _, group in groups for job in group.values()]
                result["cancelled"] = self.queue.cancel_many(job.id for job in jobs if job.task)
                result["skipped"] = len(jobs) - result["cancelled"]
            else:
                for group_id, _ in groups:
                    outcome = self.query_action(group_id, "retry")
                    for name in ("cancelled", "retried", "skipped"):
                        result[name] += outcome[name]
                    result["errors"].extend(outcome["errors"])
            return result

    def jobs(self):
        with self._lock:
            self._prune_jobs()
            return [self._describe_job(self._jobs[t.id], t).describe()
                    for t in self.queue.tasks() if t.id in self._jobs]

    def challenges(self):
        return self.challenge_control.pending()

    def block_source(self, source, url):
        self.challenge_control.record(source, url)
        return sum(t.resource == source and t.state == "waiting_action" for t in self.queue.tasks())

    def clear_challenge(self, source):
        return self.challenge_control.clear(source)

    def snapshot(self):
        state = self.queue.snapshot()
        with self._lock:
            return {**self.stats, **state, "queued": state["queued"] + state["retry_wait"],
                    "in_flight": state["workers_busy"], "challenges": self.challenges()}

    def stored_offers(self, query):
        """Read from the same ledger the scrape writes, under its owning lock."""
        with self._store_lock:
            return self.store.offers_for_search(query) if self.store is not None else None

    def validate_settings(self, **kwargs):
        if "db_path" in kwargs:
            requested = str(Path(kwargs["db_path"]).resolve()) if kwargs["db_path"] else None
            if os.path.normcase(requested or "") != os.path.normcase(self.database_path or ""):
                raise ValueError("database conflicts with the configured process ledger; start a separate server with --db")
        for name in ("max_workers", "ttl", "max_retries"):
            if name in kwargs and kwargs[name] is not None and kwargs[name] != getattr(self, name):
                raise ValueError(f"{name} conflicts with the configured process settings")

    def shutdown(self, wait=False):
        with self._lock:
            self._closed = True
        self.challenge_control.close(wait=wait)
        self.queue.shutdown(wait=wait)
        # Let in-flight HTTP calls unwind before closing their store.
        def close():
            self.queue.shutdown(wait=True)
            with self._lock, self._store_lock:
                if self.store is not None:
                    self.store.close()
                    self.store = None
        if wait:
            close()
        else:
            threading.Thread(target=close, name="scheduler-close", daemon=True).start()


_DEFAULT = None
_DEFAULT_LOCK = threading.Lock()


def execution_settings():
    """Observe process defaults without opening a database during input parsing."""
    with _DEFAULT_LOCK:
        return {
            "workers": _DEFAULT.max_workers if _DEFAULT else DEFAULT_MAX_WORKERS,
            "db": _DEFAULT.database_path if _DEFAULT else str(Path("flights.db").resolve()),
        }


def validate_execution_settings(**kwargs):
    """Reject conflicting requests before admitting a search, without creating resources."""
    with _DEFAULT_LOCK:
        if _DEFAULT is not None:
            _DEFAULT.validate_settings(**kwargs)


def default_scheduler(**kwargs):
    global _DEFAULT
    with _DEFAULT_LOCK:
        if _DEFAULT is None:
            _DEFAULT = Scheduler(**kwargs)
        else:
            _DEFAULT.validate_settings(**kwargs)
        return _DEFAULT


def reset_default_scheduler():
    global _DEFAULT
    with _DEFAULT_LOCK:
        if _DEFAULT is not None:
            _DEFAULT.shutdown()
        _DEFAULT = None


def _safe_url(source, query):
    try:
        return source.search_url(query)
    except Exception:
        return ""

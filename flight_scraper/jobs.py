"""Searches as addressable, replayable things rather than one-shot streams.

The first version of the web UI kept a job's progress in a ``queue.Queue`` and
had the stream endpoint read from it. That works for exactly one listener,
once: a queue hands each event to whoever gets there first, so a second client
sees half the run and a dropped connection loses the rest.

Here a job keeps an append-only log instead. Every event has a sequence number,
subscribers each get their own feed, and a client that reconnects says how far
it got and is caught up from there. That is what makes the same search
watchable by a phone and a laptop at once, and what makes ``Last-Event-ID``
work on an SSE reconnect.

Jobs are also reaped: without it the registry is a dictionary that only ever
grows.
"""

from __future__ import annotations

import queue
import threading
import uuid
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterator, List, Optional

from . import errorlog

#: How long a finished job stays addressable before it is forgotten.
DEFAULT_JOB_TTL = timedelta(hours=1)

#: Backlog kept per job. Long date ranges emit a few events per (source, date);
#: this is generous enough to replay a whole run to a late joiner.
MAX_EVENTS = 5000


class EventLog:
    """Append-only event list with fan-out to any number of subscribers."""

    def __init__(self, limit: int = MAX_EVENTS):
        if limit < 1:
            raise ValueError("event retention must be positive")
        self._events: List[Dict[str, Any]] = []
        self._subscribers: List["queue.Queue[Optional[Dict[str, Any]]]"] = []
        self._lock = threading.Lock()
        self._limit = limit
        self._closed = False
        self._seq = 0

    @property
    def last_seq(self) -> int:
        with self._lock:
            return self._seq

    def append(self, event: Dict[str, Any]) -> Dict[str, Any]:
        with self._lock:
            if self._closed:
                return event
            self._seq += 1
            stamped = {
                **event,
                "seq": self._seq,
                "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            }
            self._events.append(stamped)
            if len(self._events) > self._limit:
                del self._events[: len(self._events) - self._limit]
            # Publish under the append lock so concurrent producers and close()
            # cannot deliver a later event or the close sentinel first.
            for listener in self._subscribers:
                listener.put(stamped)
        return stamped

    def close(self) -> None:
        """Signal every live subscriber that nothing more is coming."""
        with self._lock:
            self._closed = True
            for listener in self._subscribers:
                listener.put(None)

    def snapshot(self, after: int = 0) -> List[Dict[str, Any]]:
        with self._lock:
            return [e for e in self._events if e["seq"] > after]

    def subscribe(self, after: int = 0) -> Iterator[Dict[str, Any]]:
        """Yield the backlog past ``after``, then live events until the log closes.

        Registering the listener before copying the backlog is what stops an
        event slipping through the gap between the two.
        """
        listener: "queue.Queue[Optional[Dict[str, Any]]]" = queue.Queue()
        with self._lock:
            self._subscribers.append(listener)
            backlog = [e for e in self._events if e["seq"] > after]
            already_closed = self._closed
            seen = backlog[-1]["seq"] if backlog else after

        try:
            for event in backlog:
                yield event
            if already_closed:
                return
            while True:
                try:
                    event = listener.get(timeout=20)
                except queue.Empty:
                    yield {"event": "keepalive", "seq": seen}
                    continue
                if event is None:
                    return
                if event["seq"] <= seen:
                    continue  # already delivered from the backlog
                seen = event["seq"]
                yield event
        finally:
            with self._lock:
                if listener in self._subscribers:
                    self._subscribers.remove(listener)


class Job:
    """Own one search lifecycle; observers receive copies of its state."""

    def __init__(self, id, params=None, fingerprint="", log=None):
        self.id, self.fingerprint = id, fingerprint
        self._params = deepcopy(params or {})
        self._status = "queued"
        self.created_at = datetime.now(timezone.utc)
        self.finished_at = None
        self._error = ""
        self.log = log or EventLog()
        self._days, self._totals = [], {}
        self._csv_path = self._json_path = None
        self._cancelled = False
        self._started = False
        self._aggregator = None
        self._lock = threading.RLock()

    @property
    def params(self):
        with self._lock:
            return deepcopy(self._params)

    @property
    def status(self):
        with self._lock:
            return self._status

    @property
    def cancelled(self):
        with self._lock:
            return self._cancelled

    @property
    def error(self):
        with self._lock:
            return self._error

    @property
    def days(self):
        with self._lock:
            return deepcopy(self._days)

    def emit(self, event: str, **data: Any) -> Dict[str, Any]:
        return self.log.append({"event": event, **data})

    @property
    def done(self) -> bool:
        with self._lock:
            return self._status in ("done", "failed", "cancelled")

    def cancel(self):
        with self._lock:
            if self.done:
                return False
            self._cancelled = True
            aggregator = self._aggregator
        if aggregator is not None:
            aggregator.cancel()
        return True

    def attach(self, aggregator):
        """Attachment and cancellation share one lock, including startup races."""
        with self._lock:
            self._aggregator = aggregator
            cancelled = self._cancelled or self.done
        if cancelled:
            aggregator.cancel()
        return not cancelled

    def record_day(self, trip, snapshot):
        with self._lock:
            snapshot = {**deepcopy(snapshot), "trip": trip}
            for index, existing in enumerate(self._days):
                if existing.get("trip") == trip:
                    self._days[index] = snapshot
                    break
            else:
                self._days.append(snapshot)

    def update_results(self, *, offers, itineraries, errors, csv=None, json=None):
        with self._lock:
            self._totals = {"offers": offers, "itineraries": itineraries, "errors": errors}
            self._csv_path, self._json_path = csv, json

    def run(self, runner, *args):
        """Own every exit path, including startup and export failures."""
        with self._lock:
            if self.done or self._started:
                return
            self._started = True
            execute = not self._cancelled
            self._status = "running"
        try:
            if execute:
                runner(*args)
        except Exception as exc:
            message = f"{type(exc).__name__}: {exc}"
            errorlog.record("search", exc, search=self.id, **self.params)
            self.emit("error", message=message)
            with self._lock:
                self._error = message
                self._totals["errors"] = self._totals.get("errors", 0) + 1
        finally:
            self.finish()

    def finish(self, status: Optional[str] = None, error: str = "") -> None:
        if status is not None and status not in ("done", "failed", "cancelled"):
            raise ValueError("a search must finish in a terminal state")
        with self._lock:
            if self.done:
                return
            self._error = error or self._error
            if self._error and not self._totals.get("errors"):
                self._totals["errors"] = 1
            self._status = status or ("cancelled" if self._cancelled else "failed" if self._error else "done")
            self.finished_at = datetime.now(timezone.utc)
            self.emit("done", total=self._totals.get("offers", 0),
                      itineraries=self._totals.get("itineraries", 0), errors=self._totals.get("errors", 0),
                      csv=self._csv_path, json=self._json_path, cancelled=self._cancelled)
            self.log.close()
            self._aggregator = None

    def summary(self) -> Dict[str, Any]:
        with self._lock:
            return self._summary_locked()

    def _summary_locked(self):
        return {
            "search_id": self.id,
            "status": self._status,
            "params": deepcopy(self._params),
            "created_at": self.created_at.isoformat(timespec="seconds"),
            "finished_at": self.finished_at.isoformat(timespec="seconds")
            if self.finished_at else None,
            "error": self._error,
            "last_seq": self.log.last_seq,
            "days_done": len(self._days),
            **self._totals,
            "csv": self._csv_path,
            "json": self._json_path,
        }


class JobRegistry:
    """Live jobs, addressable by id and by the search they represent."""

    def __init__(self, ttl: timedelta = DEFAULT_JOB_TTL):
        self.ttl = ttl
        self._jobs: Dict[str, Job] = {}
        self._by_fingerprint: Dict[str, str] = {}
        self._lock = threading.Lock()

    def start(self, params, fingerprint, runner, *, force=False):
        """Atomically join/create a search, then run it with lifecycle protection."""
        with self._lock:
            self._reap_locked()
            job_id = self._by_fingerprint.get(fingerprint)
            existing = self._jobs.get(job_id)
            if not force and existing is not None and not existing.done:
                return existing, True
            job = Job(id=uuid.uuid4().hex[:12], params=deepcopy(params), fingerprint=fingerprint)
            self._jobs[job.id] = job
            self._by_fingerprint[fingerprint] = job.id
        try:
            threading.Thread(target=job.run, args=(runner, job), daemon=True).start()
        except Exception as exc:
            job.emit("error", message=str(exc))
            job.finish("failed", str(exc))
        return job, False

    def get(self, job_id: str) -> Optional[Job]:
        with self._lock:
            return self._jobs.get(job_id)

    def list(self, limit: int = 50) -> List[Job]:
        with self._lock:
            jobs = sorted(self._jobs.values(), key=lambda j: j.created_at, reverse=True)
        return jobs[:limit]

    def reap(self) -> int:
        with self._lock:
            return self._reap_locked()

    def _reap_locked(self) -> int:
        cutoff = datetime.now(timezone.utc) - self.ttl
        stale = [
            job_id for job_id, job in self._jobs.items()
            if job.done and job.finished_at is not None and job.finished_at < cutoff
        ]
        for job_id in stale:
            job = self._jobs.pop(job_id)
            if job.fingerprint and self._by_fingerprint.get(job.fingerprint) == job_id:
                del self._by_fingerprint[job.fingerprint]
        return len(stale)

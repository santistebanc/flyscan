"""Where errors go to be read later, by a person or by a machine.

A scraper fails for reasons that are gone by the time anyone looks: a site
answered differently, a poll timed out, a payload changed shape. The error
string alone never says enough — "poll returned HTTP 404" is the same sentence
whether the route was wrong, the session expired, or the site is blocking us.

So each entry carries the *context* it happened in: which source, which trip,
which party, how far the search had got. That is the difference between an
error someone can act on and one they can only nod at. Entries are JSON lines
so they can be grepped, filtered and counted without a parser, and the file is
capped so it can be read whole.

Nothing here raises. A failure to record a failure must never become the
failure being reported.
"""

from __future__ import annotations

import json
import os
import threading
import traceback
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

#: Where the log lives. Beside the database rather than in a temp directory,
#: because the point is that it survives to be read.
LOG_DIR = Path(os.environ.get("FLIGHT_SCRAPER_ERROR_DIR", ".errors"))
LOG_FILE = LOG_DIR / "errors.jsonl"

#: Entries kept. Old ones are dropped when the file is trimmed, so the file
#: stays small enough to read in one go — which is the whole point of it.
KEEP = 500

#: Longest traceback stored. A runaway recursion can produce megabytes, and
#: the first frames are the ones that say anything.
MAX_TRACEBACK = 8_000

_lock = threading.Lock()


def record(
    where: str,
    error: BaseException | str,
    /,
    **context: Any,
) -> str:
    """Write one error down, and hand back its id.

    ``where`` is the part of the system that failed, dotted from the general
    to the specific — ``source.ff-sky``, ``api.searches``, ``ui.results`` — so
    that filtering by prefix gives you a subsystem.

    Everything else becomes context. Pass what you would want to know: the
    query, the source, the trip, the URL that answered. Values that cannot be
    serialised are stringified rather than dropped, since a rough note beats a
    missing one.
    """
    entry: Dict[str, Any] = {
        "id": uuid.uuid4().hex[:12],
        "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "where": where,
        "kind": type(error).__name__ if isinstance(error, BaseException) else "error",
        "message": str(error),
        "context": {key: _plain(value) for key, value in context.items()},
    }
    if isinstance(error, BaseException):
        frames = "".join(traceback.format_exception(type(error), error, error.__traceback__))
        entry["traceback"] = frames[:MAX_TRACEBACK]

    try:
        with _lock:
            LOG_DIR.mkdir(parents=True, exist_ok=True)
            with LOG_FILE.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(entry, default=str) + "\n")
            _trim()
    except Exception:
        # Recording a failure must never become the failure. A lost error line
        # is a smaller problem than an exception thrown from an except block.
        pass
    return entry["id"]


def recent(limit: int = 20, where: Optional[str] = None) -> List[Dict[str, Any]]:
    """The newest entries first, optionally filtered by a ``where`` prefix."""
    entries = [e for e in _read() if not where or e.get("where", "").startswith(where)]
    return list(reversed(entries))[:limit]


def summary() -> List[Dict[str, Any]]:
    """Errors grouped by where and kind, commonest first.

    The shape of a problem is usually in the counts: forty of one thing is a
    site that changed, one of forty is a fluke.
    """
    seen: Dict[tuple, Dict[str, Any]] = {}
    for entry in _read():
        key = (entry.get("where", "?"), entry.get("kind", "?"), entry.get("message", "")[:80])
        row = seen.setdefault(
            key,
            {
                "where": key[0],
                "kind": key[1],
                "message": key[2],
                "count": 0,
                "first": entry.get("at"),
                "last": entry.get("at"),
            },
        )
        row["count"] += 1
        row["last"] = entry.get("at")
    return sorted(seen.values(), key=lambda row: -row["count"])


def clear() -> int:
    """Forget everything recorded. Returns how many entries went."""
    with _lock:
        entries = _read()
        LOG_FILE.unlink(missing_ok=True)
    return len(entries)


# -- innards ---------------------------------------------------------------


def _plain(value: Any) -> Any:
    """Something JSON can hold, without losing what the value said."""
    if isinstance(value, (str, int, float, bool, type(None))):
        return value
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def _read() -> List[Dict[str, Any]]:
    if not LOG_FILE.exists():
        return []
    entries: List[Dict[str, Any]] = []
    for line in LOG_FILE.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entries.append(json.loads(line))
        except ValueError:
            continue  # a half-written line from a killed process
    return entries


def _trim() -> None:
    """Keep the file to `KEEP` entries. Called with the lock held."""
    lines = LOG_FILE.read_text(encoding="utf-8", errors="replace").splitlines()
    if len(lines) <= KEEP * 2:  # trim in batches rather than every write
        return
    LOG_FILE.write_text("\n".join(lines[-KEEP:]) + "\n", encoding="utf-8")


def entries() -> Iterator[Dict[str, Any]]:
    """Every entry, oldest first."""
    yield from _read()

"""When a source asks for proof you are human, hand the question to the human.

The Kayak engine answers a flagged request with a 403 whose body carries a
``captchaRedirectUrl`` — a real page with a Continue button and reCAPTCHA
Enterprise behind it. That is a challenge a person can clear in a few seconds
and software has no business trying to.

ChallengeCoordinator owns the pending/cleared lifecycle and queue resumption.
The browser and cookie-file adapters supply the clearance a person earned;
they never solve, answer, or work around a challenge on the person's behalf.

The cookies are kept per source alongside a browser profile directory. Trying
the cookies in the plain HTTP client first is worth it — it keeps the fast path
fast — but the profile is what makes the fallback possible if the site binds its
answer to the browser that earned it.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from .challenge_page import CHECK_PAGE_TWEAKS, check_page_script

DEFAULT_DIR = Path(".challenges")

#: How long a cleared challenge is assumed to hold before it is worth redoing.
DEFAULT_TTL = timedelta(hours=12)

#: The size the check window is given (the factory's virtual screen is the same size).
SCREEN = (1280, 900)

#: Nothing about this page means "solved" as reliably as leaving it does.
CHECK_MARKER = "/security/check"


class ChallengeStore:
    """Per-source cookies earned by a human clearing a challenge."""

    def __init__(self, path: Path | str = DEFAULT_DIR, ttl: timedelta = DEFAULT_TTL):
        self.path = Path(path)
        self.ttl = ttl
        self._lock = threading.Lock()

    # -- paths -------------------------------------------------------------

    def _file(self, source: str) -> Path:
        return self.path / f"{source}.json"

    def profile_dir(self, source: str) -> Path:
        """Browser profile kept between unblocks, so the site sees a returning visitor."""
        directory = self.path / f"{source}-profile"
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    # -- reading and writing -----------------------------------------------

    def save(
        self,
        source: str,
        cookies: Dict[str, str],
        url: str = "",
        durable: Optional[Iterable[str]] = None,
    ) -> None:
        """Keep the cookies; ``durable`` names those that outlive a browser session."""
        record = {
            "source": source,
            "cookies": cookies,
            "url": url,
            "solved_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        if durable is not None:
            record["durable"] = sorted(durable)
        with self._lock:
            self._write(source, record)

    def _write(self, source: str, record: Dict[str, Any]) -> None:
        """Replace the record whole: another process may be reading it at any moment."""
        self.path.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", dir=self.path, suffix=".tmp", delete=False
            ) as stream:
                temporary = stream.name
                json.dump(record, stream, indent=1)
            os.replace(temporary, self._file(source))
        finally:
            if temporary and os.path.exists(temporary):
                os.unlink(temporary)

    def load(self, source: str) -> Dict[str, str]:
        """Read the latest clearance on every session, including another process's write."""
        with self._lock:
            try:
                record = json.loads(self._file(source).read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                return {}
        if not isinstance(record, dict) or self._age(record.get("solved_at", "")) > self.ttl:
            return {}
        cookies = record.get("cookies")
        return dict(cookies) if isinstance(cookies, dict) else {}

    def narrow_to_durable(self, source: str) -> bool:
        """Keep only the cookies that outlive a browser session; False if that changes nothing.

        A session cookie belongs to the session that earned it: replayed in a new one it can
        make the source ask again. The full set is kept aside for ``restore_full``.
        """
        return self._rewrite(source, narrow=True)

    def restore_full(self, source: str) -> bool:
        return self._rewrite(source, narrow=False)

    def _rewrite(self, source: str, narrow: bool) -> bool:
        with self._lock:
            try:
                record = json.loads(self._file(source).read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                return False
            if not isinstance(record, dict) or not isinstance(record.get("cookies"), dict):
                return False
            if narrow:
                keep = record.get("durable")
                if keep is None or "full" in record:
                    return False
                kept = {k: v for k, v in record["cookies"].items() if k in set(keep)}
                if len(kept) == len(record["cookies"]):
                    return False
                record["full"], record["cookies"] = record["cookies"], kept
            else:
                if "full" not in record:
                    return False
                record["cookies"] = record.pop("full")
            self._write(source, record)
            return True

    def clear(self, source: str) -> None:
        with self._lock:
            try:
                self._file(source).unlink()
            except FileNotFoundError:
                pass

    def status(self) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        if not self.path.exists():
            return out
        for file in sorted(self.path.glob("*.json")):
            if file.name == "pending.json":
                continue  # ignore legacy pending files; SQLite now owns pending challenges
            try:
                record = json.loads(file.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            age = self._age(record.get("solved_at", ""))
            out.append(
                {
                    "source": record.get("source", file.stem),
                    "solved_at": record.get("solved_at", ""),
                    "cookies": len(record.get("cookies") or {}),
                    "fresh": age <= self.ttl,
                    "age_hours": round(age.total_seconds() / 3600, 1),
                }
            )
        return out

    @staticmethod
    def _age(stamp: str) -> timedelta:
        try:
            solved = datetime.fromisoformat(stamp)
        except (ValueError, TypeError):
            return timedelta.max
        if solved.tzinfo is None:
            solved = solved.replace(tzinfo=timezone.utc)
        return datetime.now(timezone.utc) - solved


#: The store the sources read from.
STORE = ChallengeStore()


class ChallengeCoordinator:
    """One owner for challenge persistence, clearance adapters and live queue holds.

    SQLite is authoritative for persisted challenges. A live scheduler reconciles
    it so a standalone CLI can clear the same database without an IPC dependency.
    Explicit holds without a fetch remain process-local.
    """

    def __init__(
        self,
        ledger=None,
        queue=None,
        *,
        ledger_lock=None,
        cookies=None,
        reconcile_interval=0.2,
        owns_ledger=False,
    ):
        self._ledger, self._queue = ledger, queue
        self._ledger_lock = ledger_lock or threading.RLock()
        self.cookies = cookies or STORE
        self._lock = threading.RLock()
        self._drained = threading.Condition(self._lock)
        self._active_recoveries = 0
        self._closed = False
        self._pending = {}
        self._known_sources = set()
        self._ephemeral = {}
        self._solving = set()
        self._recovery_errors = {}
        self._stopped = threading.Event()
        self._owns_ledger = owns_ledger
        self.reconcile()
        self._monitor = None
        if ledger is not None and queue is not None:
            self._monitor = threading.Thread(
                target=self._watch,
                args=(reconcile_interval,),
                name="challenge-reconcile",
                daemon=True,
            )
            self._monitor.start()

    @classmethod
    def for_database(cls, path, **kwargs):
        from .store import FlightStore

        return cls(FlightStore(path) if path else None, owns_ledger=True, **kwargs)

    def _watch(self, interval):
        while not self._stopped.wait(interval):
            try:
                self.reconcile()
            except Exception:
                logging.getLogger(__name__).exception("challenge reconciliation failed")

    def reconcile(self):
        from .task_queue import ActionRequired

        with self._lock:
            if self._closed:
                return dict(self._pending)
            with self._ledger_lock:
                stored = self._ledger.pending_challenges() if self._ledger else {}
            pending = {**stored, **self._ephemeral}
            self._known_sources.update(pending)
            if self._queue:
                for source in self._known_sources - pending.keys():
                    self._queue.resolve_action(source)
                for source, url in pending.items():
                    if self._pending.get(source) != url:
                        self._queue.pause(
                            source, ActionRequired("captcha", "source needs a human", url)
                        )
            self._pending = pending
            return dict(pending)

    def pending(self):
        return self.reconcile()

    def record(self, source, url, fetch_id=None):
        from .task_queue import ActionRequired

        with self._lock:
            if self._closed:
                raise RuntimeError("challenge coordinator is closed")
            self._known_sources.add(source)
            self._recovery_errors.pop(source, None)
            if self._ledger is not None and fetch_id is not None:
                with self._ledger_lock:
                    self._ledger.challenge_fetch(fetch_id, url)
            else:
                self._ephemeral[source] = url
            self._pending[source] = url
            if self._queue:
                self._queue.pause(source, ActionRequired("captcha", "source needs a human", url))

    def clear(self, source):
        with self._lock:
            if self._closed:
                return False
            with self._ledger_lock:
                cleared = self._ledger.clear_challenges(source) if self._ledger else 0
            live = self._pending.pop(source, None) is not None
            self._ephemeral.pop(source, None)
            self._recovery_errors.pop(source, None)
            resumed = self._queue.resolve_action(source) if self._queue else 0
            return bool(cleared or live or resumed)

    def accept_cookies(self, source, cookies, url=""):
        with self._lock:
            if self._closed:
                raise RuntimeError("challenge coordinator is closed")
            self.cookies.save(source, cookies, url)
            self.clear(source)
            return len(cookies)

    def recover(self, source, *, url=None, wait_seconds=300):
        """Shared CLI/browser flow: probe, choose a URL, solve, and clear."""
        with self._lock:
            if self._closed:
                return self._cancelled(source)
            self._active_recoveries += 1
        try:
            return self._recover(source, url=url, wait_seconds=wait_seconds)
        finally:
            with self._drained:
                self._active_recoveries -= 1
                self._close_owned_ledger()
                self._drained.notify_all()

    @staticmethod
    def _cancelled(source):
        return {"source": source, "solved": False, "cookies": 0, "cancelled": True}

    def _recover(self, source, *, url, wait_seconds):
        if not url:
            url, outcome = probe_challenge(source)
            if self._stopped.is_set():
                return self._cancelled(source)
            if outcome == "clear":
                self.clear(source)
                return {"source": source, "solved": True, "cookies": 0, "outcome": "clear"}
            if outcome == "error":
                url = self.pending().get(source)
        if not url:
            return {
                "source": source,
                "solved": False,
                "cookies": 0,
                "error": "could not obtain a challenge URL",
            }
        if self._stopped.is_set():
            return self._cancelled(source)
        report = solve(
            source, url, store=self.cookies, wait_seconds=wait_seconds, cancelled=self._stopped
        )
        if self._stopped.is_set():
            return self._cancelled(source)
        if report.get("solved"):
            self._keep_cookies_that_clear(source)
            self.clear(source)
        return report

    def _keep_cookies_that_clear(self, source):
        """Make sure the cookies a person just earned are ones the source accepts.

        The browser's whole jar is the natural thing to keep, but replaying a session's own
        cookies in a new session can get the source to ask again (Momondo does, with its session
        id), and the check would reappear as soon as the waiting work resumed. So if the source
        still challenges, try the cookies that outlive a browser session instead.
        """
        store = self.cookies
        if not hasattr(store, "narrow_to_durable"):
            return
        _, outcome = probe_challenge(source)
        if outcome != "challenged" or not store.narrow_to_durable(source):
            return
        _, outcome = probe_challenge(source)
        if outcome != "clear":
            store.restore_full(source)

    def solving(self):
        with self._lock:
            return frozenset(self._solving)

    def recovery_errors(self):
        with self._lock:
            return dict(self._recovery_errors)

    def start_recovery(self, source):
        """Reserve one browser per source; errors leave the challenge pending."""
        with self._lock:
            if self._closed or source in self._solving:
                return False
            # Verify is an explicit request to open the challenge already recorded.
            # A full source probe can take a minute and must not precede that window.
            url = self.reconcile().get(source)
            self._recovery_errors.pop(source, None)
            self._solving.add(source)

        def run():
            try:
                report = self.recover(source, url=url)
                if not report.get("solved") and not report.get("cancelled"):
                    with self._lock:
                        self._recovery_errors[source] = (
                            report.get("error") or "Verification wasn’t completed. Try again."
                        )
            except Exception as exc:
                with self._lock:
                    self._recovery_errors[source] = str(exc)
                logging.getLogger(__name__).exception("challenge recovery failed for %s", source)
            finally:
                with self._drained:
                    self._solving.discard(source)
                    self._drained.notify_all()

        with self._lock:
            if self._closed:
                self._solving.discard(source)
                self._drained.notify_all()
                return False
            try:
                threading.Thread(target=run, name=f"solve-{source}", daemon=True).start()
            except BaseException:
                self._solving.discard(source)
                self._drained.notify_all()
                raise
        return True

    def _close_owned_ledger(self):
        if (
            self._closed
            and not self._active_recoveries
            and self._owns_ledger
            and self._ledger is not None
        ):
            with self._ledger_lock:
                self._ledger.close()
                self._ledger = None

    def close(self, wait=True):
        with self._drained:
            self._closed = True
            self._stopped.set()
            if wait:
                self._drained.wait_for(lambda: not self._active_recoveries and not self._solving)
            self._close_owned_ledger()
        if self._monitor is not None:
            self._monitor.join()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def probe_challenge(source_name: str) -> Tuple[Optional[str], str]:
    """Ask the source, now, whether it actually wants a human.

    Returns ``(url, outcome)`` where outcome is one of:

    ``challenged``
        It is blocking, and ``url`` is a **current** check page. The ``t=``
        token in these is short-lived, so one recorded an hour ago may not work.
    ``clear``
        It answered normally. There is nothing to solve — these blocks lift on
        their own, and by the time anyone clicks it may already have.
    ``error``
        Something else went wrong, so we cannot tell either way.

    The three used to collapse into ``None``, which made "not blocking" look
    identical to "probe failed" — and the caller then opened a captcha for a
    source that had already recovered.
    """
    from datetime import date
    from datetime import timedelta as _td

    from .models import SearchQuery
    from .sources import ChallengeRequired, build

    source = build([source_name])[0]
    query = SearchQuery(origin="BER", destination="LON", depart=date.today() + _td(days=30))
    try:
        source.search(query)
    except ChallengeRequired as challenge:
        return challenge.url, "challenged"
    except Exception:
        return None, "error"
    return None, "clear"


def _fit_window(context, page, bounds: Dict[str, int]) -> None:
    """Put the window at ``bounds``: Chromium restores an app window's last size over the flags."""
    try:
        session = context.new_cdp_session(page)
        window_id = session.send("Browser.getWindowForTarget")["windowId"]
        session.send(
            "Browser.setWindowBounds",
            {"windowId": window_id, "bounds": {**bounds, "windowState": "normal"}},
        )
    except Exception:
        logging.getLogger(__name__).warning("could not size the check window", exc_info=True)


def solve(
    source: str,
    url: str,
    store: Optional[ChallengeStore] = None,
    wait_seconds: int = 300,
    headless: bool = False,
    cancelled: Optional[threading.Event] = None,
) -> Dict[str, Any]:
    """Open ``url`` for a person to clear, and keep the cookies they earn.

    Returns a report; ``solved`` is True once the browser has left the check
    page. Blocks until that happens or ``wait_seconds`` runs out — the waiting
    is the point, since the whole design is that a human does this part.
    """
    store = store or STORE
    report: Dict[str, Any] = {"source": source, "url": url, "solved": False, "cookies": 0}

    def was_cancelled():
        if cancelled is not None and cancelled.is_set():
            report.update(solved=False, cancelled=True)
            return True
        return False

    if was_cancelled():
        return report
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:  # pragma: no cover - depends on install
        raise RuntimeError(
            "clearing a challenge needs Playwright: pip install playwright "
            "&& playwright install chromium"
        ) from exc

    profile = store.profile_dir(source)
    tidy = check_page_script(source)
    # The profile outlives a killed browser: don't greet the person with "Restore pages?".
    args = ["--hide-crash-restore-bubble", "--noerrdialogs"]
    if tidy:
        # A bare window: no tabs or address bar around the check. It has to be the app's own
        # address (about:blank would leave Playwright holding a second, ordinary window); the
        # goto below then reloads it with the tidy script installed.
        args.append(f"--app={url}")
        # Zoom the whole browser (not the page: the captcha's image grid lives outside it) and
        # shrink the window to match, so it still fills the same screen.
        scale = CHECK_PAGE_TWEAKS[source].scale
        window = {
            "left": 0,
            "top": 0,
            "width": round(SCREEN[0] / scale),
            "height": round(SCREEN[1] / scale),
        }
        args += [
            f"--force-device-scale-factor={scale}",
            f"--window-size={window['width']},{window['height']}",
            "--window-position=0,0",
        ]

    with sync_playwright() as driver:
        # no_viewport: the window itself sets the page size (an emulated viewport would not zoom).
        viewport = {"no_viewport": True} if tidy else {"viewport": {"width": 1280, "height": 900}}
        context = driver.chromium.launch_persistent_context(
            str(profile), headless=headless, locale="en-GB", args=args, **viewport
        )
        try:
            if was_cancelled():
                return report
            if tidy:
                context.add_init_script(tidy)
            page = context.pages[0] if context.pages else context.new_page()
            if tidy:
                _fit_window(context, page, window)
            page.goto(url, wait_until="domcontentloaded", timeout=60_000)

            deadline = time.monotonic() + wait_seconds
            while time.monotonic() < deadline:
                if was_cancelled():
                    return report
                if CHECK_MARKER not in (page.url or ""):
                    report["solved"] = True
                    break
                page.wait_for_timeout(1000)

            if report["solved"]:
                # Let the redirect settle so every cookie is set before we look.
                page.wait_for_timeout(2500)
                if was_cancelled():
                    return report
                earned = [
                    c
                    for c in context.cookies()
                    if "flightsfinder" in c.get("domain", "")
                    or "kayak" in c.get("domain", "")
                    or "momondo" in c.get("domain", "")
                ]
                cookies = {c["name"]: c["value"] for c in earned}
                # A session cookie has no expiry (Playwright reports -1).
                durable = {c["name"] for c in earned if c.get("expires", -1) not in (-1, None)}
                store.save(source, cookies, url, durable=durable)
                report["cookies"] = len(cookies)
                report["landed_on"] = page.url
        finally:
            context.close()

    return report

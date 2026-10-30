"""Shut the process down when whoever spawned it goes away.

The desktop shell kills its sidecar when the main window is destroyed, but that
only covers the tidy exit. Ctrl+C in a ``tauri dev`` terminal, a crash, or a
rebuild that restarts the shell all kill the parent without any window event, and
the sidecar is left running — holding its port, the database, and (on Windows)
the very file the next ``cargo`` build has to delete before it can copy a new
one. That failure looks like an unrelated ``PermissionDenied`` in a build script,
which is a long way from its cause.

So the child watches the parent as well, and no orphan survives regardless of how
the parent died.
"""

from __future__ import annotations

import os
import sys
import threading

#: Rights needed only to wait on a process handle.
_SYNCHRONIZE = 0x00100000
_INFINITE = 0xFFFFFFFF


def _wait_windows(pid: int) -> None:
    import ctypes

    kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
    # NOTE: os.kill(pid, 0) is not a liveness test on Windows — CPython maps it
    # onto TerminateProcess, so it would kill the parent instead of checking it.
    handle = kernel32.OpenProcess(_SYNCHRONIZE, False, pid)
    if not handle:
        return  # already gone, or not ours to watch
    try:
        kernel32.WaitForSingleObject(handle, _INFINITE)
    finally:
        kernel32.CloseHandle(handle)


def _wait_posix(pid: int) -> None:
    import time

    while True:
        try:
            os.kill(pid, 0)  # safe here: signal 0 really is a liveness check
        except OSError:
            return
        time.sleep(1.0)


def exit_with_parent(pid: int) -> None:
    """Exit this process once *pid* exits. Returns immediately.

    Uses ``os._exit`` rather than raising: the point is to go away even if a
    request is in flight, and a half-finished scrape is worth less than a
    process that will not die.
    """
    if pid <= 0:
        return

    wait = _wait_windows if sys.platform == "win32" else _wait_posix

    def watch() -> None:
        wait(pid)
        os._exit(0)

    threading.Thread(target=watch, name="parent-watch", daemon=True).start()

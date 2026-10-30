"""Tests. Run them with `python -m unittest discover -s tests -t .` from the repo root."""

import tempfile
from pathlib import Path
from unittest import mock

from flyscan import errorlog


def quiet_errorlog(case) -> Path:
    """Point the error log at a temp directory for the duration of one test.

    Anything that calls `Source.run` records its failures, and a test suite
    full of deliberate failures would otherwise fill the real log with
    make-believe — `source.always-fails` sitting in the same list as the real
    ones is worse than no log at all.
    """
    directory = Path(tempfile.mkdtemp())
    for attribute, value in (("LOG_DIR", directory), ("LOG_FILE", directory / "errors.jsonl")):
        patch = mock.patch.object(errorlog, attribute, value)
        patch.start()
        case.addCleanup(patch.stop)
    return directory

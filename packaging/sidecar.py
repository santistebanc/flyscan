"""Entry point for the packaged sidecar a desktop shell spawns.

Defaults to serving the API rather than printing usage: a desktop app wants a
process that comes up, says where it is listening, and stays there. Anything
that does not start with a known subcommand is treated as arguments to
``serve``, so ``sidecar --port 5111`` does the obvious thing while every CLI
subcommand stays reachable — which keeps the binary useful on its own.
"""

import sys

# Frozen Python does not honor PYTHONUNBUFFERED. Keep startup diagnostics
# available immediately in the desktop shell's redirected log.
for stream in (sys.stdout, sys.stderr):
    if stream is not None and hasattr(stream, "reconfigure"):
        stream.reconfigure(line_buffering=True, write_through=True)

from flight_scraper.cli import build_parser, main


def _subcommands() -> set:
    for action in build_parser()._actions:
        if getattr(action, "choices", None) and action.dest == "command":
            return set(action.choices)
    return set()


if __name__ == "__main__":
    if len(sys.argv) == 1 or sys.argv[1] not in _subcommands():
        sys.argv.insert(1, "serve")
    sys.exit(main())

"""Deployment policy shared by every execution entry point."""

import os

# Kayak and Momondo are searched only by the desktop app, from the user's own machine.
WEB_DISABLED = frozenset({"ff-kayak", "momondo"})


def web_mode():
    mode = os.environ.get("FLYSCAN_MODE", "desktop")
    if mode not in {"desktop", "web"}:
        raise ValueError("FLYSCAN_MODE must be desktop or web")
    return mode == "web"


def allowed_sources(names):
    known = list(names)
    allowed = [n for n in known if not (web_mode() and n in WEB_DISABLED)]
    configured = os.environ.get("FLYSCAN_ENABLED_SOURCES")
    if configured is not None:
        requested = [n.strip() for n in configured.split(",") if n.strip()]
        unknown = set(requested) - set(known)
        if unknown:
            raise ValueError("unknown configured source(s): " + ", ".join(sorted(unknown)))
        allowed = [n for n in allowed if n in requested]
    return allowed


def require_source(name):
    from .sources import REGISTRY

    if name not in allowed_sources([*REGISTRY, name]):
        raise ValueError(f"source disabled on the web: {name}")

"""Build edition and deployment policy shared by every execution entry point."""

import os
import sys

try:
    from ._build import EDITION
except ImportError:
    EDITION = "public" if getattr(sys, "frozen", False) else "development"

PUBLIC_DISABLED = frozenset({"ff-kayak", "momondo"})


def edition():
    # Packaged binaries cannot turn a public build into a private one with an env var.
    value = EDITION
    if value == "development" and not getattr(sys, "frozen", False):
        value = os.environ.get("FLYSCAN_EDITION", value)
    if value not in {"development", "public", "private"}:
        raise ValueError("FLYSCAN_EDITION must be development, public or private")
    return value


def web_mode():
    mode = os.environ.get("FLYSCAN_MODE", "desktop")
    if mode not in {"desktop", "web"}:
        raise ValueError("FLYSCAN_MODE must be desktop or web")
    return mode == "web"


def allowed_sources(names):
    known = list(names)
    allowed = [
        n
        for n in known
        if not (edition() == "public" or web_mode() and edition() != "private")
        or n not in PUBLIC_DISABLED
    ]
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
        raise ValueError(f"source disabled in this edition: {name}")

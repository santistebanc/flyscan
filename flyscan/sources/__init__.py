"""The source registry.

Adding a source means writing a :class:`~flyscan.sources.base.Source`
subclass and listing it here; the CLI, the web UI and the aggregator all read
this registry rather than naming sources themselves.
"""

from __future__ import annotations

from typing import Dict, List, Type

from ..deployment import allowed_sources
from .base import ChallengeRequired, Source, SourceError, SourceResult
from .flightsfinder import FlightsFinderKiwi, FlightsFinderSky
from .kayak import FlightsFinderKayak, Momondo
from .travelpayouts import Travelpayouts

#: Every known source, in the order the UI lists them.
SOURCE_CLASSES: List[Type[Source]] = [
    FlightsFinderKayak,
    FlightsFinderSky,
    FlightsFinderKiwi,
    Momondo,
    Travelpayouts,
]

REGISTRY: Dict[str, Type[Source]] = {cls.name: cls for cls in SOURCE_CLASSES}

#: Sources enabled unless --sources narrows the list.
DEFAULT_SOURCES = [cls.name for cls in SOURCE_CLASSES]


def build(names=None, **kwargs) -> List[Source]:
    """Instantiate the named sources, or every default one."""
    enabled = allowed_sources(REGISTRY)
    chosen = list(enabled if names is None else names)
    unknown = [n for n in chosen if n not in REGISTRY]
    if unknown:
        known = ", ".join(REGISTRY)
        raise ValueError(f"unknown source(s): {', '.join(unknown)} (known: {known})")
    disabled = set(chosen) - set(enabled)
    if disabled:
        raise ValueError("source(s) disabled in this edition: " + ", ".join(sorted(disabled)))
    return [REGISTRY[name](**kwargs) for name in chosen]


__all__ = [
    "Source",
    "SourceError",
    "SourceResult",
    "ChallengeRequired",
    "REGISTRY",
    "SOURCE_CLASSES",
    "DEFAULT_SOURCES",
    "build",
]

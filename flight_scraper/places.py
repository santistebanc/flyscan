"""Turn free text like "berlin" into the IATA code every source understands.

Every source speaks IATA: either an airport (``TXL``) or a city metacode
that covers all of a city's airports (``LON``, ``NYC``, ``BER``). That is a
happy accident of picking these sources, and it means place lookup is one
shared step rather than six.

The lookup itself uses Travelpayouts' open autocomplete endpoint — no key, no
Skyscanner. Results are cached on disk because place names do not change.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import List, Optional

from curl_cffi import requests

AUTOCOMPLETE = "https://autocomplete.apistp.com/places2"
CACHE_PATH = Path(".places_cache.json")

# A bare 3-letter code is already an IATA code, so there is nothing to resolve.
_CODE_RE = re.compile(r"^[A-Za-z]{3}$")


@dataclass(frozen=True)
class Place:
    code: str
    name: str
    country: str = ""
    kind: str = ""  # "city" or "airport"
    detail: str = ""
    city: str = ""

    def __str__(self) -> str:
        code = self.code.upper()
        if self.name.upper() == code and not self.country:
            return code  # a bare code the user typed; "BER — BER" helps nobody
        bits = [self.name]
        if self.country:
            bits.append(self.country)
        return f"{code} — {', '.join(bits)}"


class PlaceLookupError(RuntimeError):
    pass


def _load_cache() -> dict:
    if not CACHE_PATH.exists():
        return {}
    try:
        cached = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}
    return cached if isinstance(cached, dict) else {}


def _save_cache(cache: dict) -> None:
    try:
        CACHE_PATH.write_text(json.dumps(cache, indent=1), encoding="utf-8")
    except OSError:
        pass  # a read-only cwd should never fail a lookup


def search_places(query: str, limit: int = 8, timeout: int = 25) -> List[Place]:
    """Autocomplete matches for ``query``, best first."""
    query = (query or "").strip()
    if not query:
        return []

    try:
        response = requests.get(
            AUTOCOMPLETE,
            params={"types[]": ["city", "airport"], "term": query, "locale": "en"},
            impersonate="chrome",
            timeout=timeout,
        )
    except Exception as exc:
        raise PlaceLookupError(f"place lookup failed for {query!r}: {exc}") from exc

    if response.status_code != 200:
        raise PlaceLookupError(f"place lookup returned HTTP {response.status_code}")

    try:
        payload = response.json()
    except ValueError as exc:
        raise PlaceLookupError(f"could not read place lookup response for {query!r}") from exc

    places, seen = [], set()
    for entry in (payload or [])[: limit * 2]:
        code = (entry.get("code") or "").strip().upper()
        if not code or code in seen:
            continue
        seen.add(code)
        kind = entry.get("type") or ""
        name = entry.get("name") or code
        if kind == "city":
            name = f"{name} (all airports)"
        places.append(
            Place(
                code=code,
                name=name,
                country=entry.get("country_name") or "",
                kind=kind,
                detail=entry.get("main_airport_name") or entry.get("city_name") or "",
                city=entry.get("city_name") or (entry.get("name") if kind == "city" else "") or "",
            )
        )
        if len(places) >= limit:
            break
    return places


def resolve(query: str, prefer: str = "city", use_cache: bool = True) -> Place:
    """Resolve free text to one place.

    ``prefer='city'`` picks the multi-airport city entry when one exists, which
    is normally what "flights from London" means — and it is also the cheapest
    way to search, since one query then covers all five London airports.
    """
    query = (query or "").strip()
    if not query:
        raise PlaceLookupError("empty place query")

    if _CODE_RE.match(query):
        # Already an IATA code; trust it rather than guessing at a rename.
        return Place(code=query.upper(), name=query.upper(), kind="code")

    cache = _load_cache() if use_cache else {}
    key = f"{prefer}|{query.casefold()}"
    if key in cache:
        try:
            return Place(**cache[key])
        except TypeError:
            pass  # a cache written by an older version; fall through and refetch

    matches = search_places(query)
    if not matches:
        raise PlaceLookupError(f"no place matched {query!r}")

    chosen = matches[0]
    if prefer == "city":
        chosen = next((p for p in matches if p.kind == "city"), matches[0])

    if use_cache:
        cache[key] = asdict(chosen)
        _save_cache(cache)
    return chosen


def resolve_optional(query: str, **kwargs) -> Optional[Place]:
    try:
        return resolve(query, **kwargs)
    except PlaceLookupError:
        return None

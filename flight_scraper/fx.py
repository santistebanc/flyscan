"""Convert every source's prices into one currency for display.

The sources do not agree on currency. Three of them take a ``currency``
parameter and honour it; the Kayak engine quotes whatever its host site uses,
regardless of what it is asked for. So rather than trying to force one currency
upstream, each offer records the currency it was quoted in, and is converted
here.

Rates come from a free no-key endpoint and are cached on disk for a day —
exchange rates move far slower than flight prices, and a scrape that fans out
across every source and date should not also hit an FX API a thousand times.
"""

from __future__ import annotations

import json
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, Optional

from curl_cffi import requests

CACHE_PATH = Path(".fx_cache.json")
CACHE_TTL = timedelta(hours=24)

# Primary has ~160 currencies; the ECB-backed fallback has ~30 but is very
# stable. Either alone is enough for the currencies these sources quote in.
PROVIDERS = (
    ("open.er-api.com", "https://open.er-api.com/v6/latest/{base}"),
    ("frankfurter", "https://api.frankfurter.dev/v1/latest?base={base}"),
)

_LOCK = threading.Lock()
_MEMORY: Dict[str, "RateTable"] = {}


class RateTable:
    """Units of each currency per one unit of ``base``."""

    def __init__(self, base: str, rates: Dict[str, float], fetched_at: str, provider: str = ""):
        self.base = base.upper()
        self.rates = {k.upper(): float(v) for k, v in rates.items()}
        self.rates.setdefault(self.base, 1.0)
        self.fetched_at = fetched_at
        self.provider = provider

    @property
    def age(self) -> timedelta:
        try:
            stamp = datetime.fromisoformat(self.fetched_at)
        except ValueError:
            return CACHE_TTL * 2
        if stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=timezone.utc)
        return datetime.now(timezone.utc) - stamp

    @property
    def stale(self) -> bool:
        return self.age > CACHE_TTL

    def convert(self, amount: Optional[float], currency: str) -> Optional[float]:
        """``amount`` in ``currency`` expressed in :attr:`base`."""
        if amount is None:
            return None
        currency = (currency or self.base).upper()
        if currency == self.base:
            return round(float(amount), 2)
        rate = self.rates.get(currency)
        if not rate:
            return None
        return round(float(amount) / rate, 2)

    def to_dict(self) -> Dict:
        return {
            "base": self.base,
            "rates": self.rates,
            "fetched_at": self.fetched_at,
            "provider": self.provider,
        }


def _read_cache(base: str) -> Optional[RateTable]:
    if not CACHE_PATH.exists():
        return None
    try:
        blob = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    entry = blob.get(base.upper())
    if not entry:
        return None
    return RateTable(**entry)


def _write_cache(table: RateTable) -> None:
    blob = {}
    if CACHE_PATH.exists():
        try:
            blob = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            blob = {}
    blob[table.base] = table.to_dict()
    try:
        CACHE_PATH.write_text(json.dumps(blob, indent=1), encoding="utf-8")
    except OSError:
        pass  # a read-only cwd should never fail a scrape


def _fetch(base: str, timeout: int = 20) -> Optional[RateTable]:
    for name, template in PROVIDERS:
        try:
            response = requests.get(template.format(base=base), timeout=timeout)
            if response.status_code != 200:
                continue
            rates = (response.json() or {}).get("rates") or {}
            if not rates:
                continue
            return RateTable(
                base=base,
                rates=rates,
                fetched_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
                provider=name,
            )
        except Exception:
            continue  # try the next provider; FX must never break a scrape
    return None


def get_rates(base: str = "EUR", refresh: bool = False) -> RateTable:
    """Rate table for ``base``, from memory, then disk, then the network.

    Always returns a table. If every provider is unreachable and nothing is
    cached, the table holds only ``base`` itself, so same-currency offers still
    convert and everything else reports ``None`` rather than a made-up number.
    """
    base = base.upper()
    with _LOCK:
        table = _MEMORY.get(base)
        if table and not table.stale and not refresh:
            return table

        if not refresh:
            cached = _read_cache(base)
            if cached and not cached.stale:
                _MEMORY[base] = cached
                return cached

        fresh = _fetch(base)
        if fresh:
            _MEMORY[base] = fresh
            _write_cache(fresh)
            return fresh

        # Network is down: a stale table still beats no conversion at all.
        fallback = _MEMORY.get(base) or _read_cache(base)
        if fallback:
            _MEMORY[base] = fallback
            return fallback

        empty = RateTable(
            base, {}, datetime.now(timezone.utc).isoformat(timespec="seconds"), "none"
        )
        _MEMORY[base] = empty
        return empty


def convert(amount: Optional[float], currency: str, base: str = "EUR") -> Optional[float]:
    """Convenience wrapper: one amount into ``base``."""
    return get_rates(base).convert(amount, currency)


SYMBOLS = {
    "EUR": "€",
    "USD": "$",
    "GBP": "£",
    "CHF": "CHF",
    "PLN": "zł",
    "SEK": "kr",
    "NOK": "kr",
    "DKK": "kr",
    "CZK": "Kč",
    "HUF": "Ft",
    "CAD": "CA$",
    "AUD": "A$",
    "JPY": "¥",
}


def format_money(amount: Optional[float], currency: str) -> str:
    if amount is None:
        return ""
    symbol = SYMBOLS.get((currency or "").upper(), "")
    body = f"{amount:,.0f}" if amount >= 100 else f"{amount:,.2f}"
    if symbol and len(symbol) == 1:
        return f"{symbol}{body}"
    return f"{body} {symbol or currency}".strip()

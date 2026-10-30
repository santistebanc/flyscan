"""Flattening offers so one scrape can be handed to two callers.

:class:`Offer` is mutable and carries a computed base-currency price, so two
searches that collapse into a single scrape must not share the objects. Round
-tripping through here is how each caller gets its own copy.

This used to be a response cache as well, storing every offer as JSON against
the search that produced it. That was a second copy of what the database already
held — tens of megabytes, nearly half of it booking URLs — so the record of
*what has been asked* moved into the `fetches` table, where the answer already
lived. See :mod:`flyscan.store`.
"""

from __future__ import annotations

from typing import Any, Dict, List

from .models import Itinerary, Leg, Offer, SearchQuery


def offers_to_dicts(offers: List[Offer]) -> List[Dict[str, Any]]:
    """Flatten offers so they can be rebuilt per caller."""
    return [_offer_to_dict(o) for o in offers]


def offers_from_dicts(data: List[Dict[str, Any]], source: str, query: SearchQuery) -> List[Offer]:
    """Rebuild offers against the search that is asking for them."""
    return [_offer_from_dict(item, source, query) for item in data]


def _offer_to_dict(offer: Offer) -> Dict[str, Any]:
    itinerary = offer.itinerary
    return {
        "price": offer.price,
        "currency": offer.currency,
        "agent": offer.agent,
        "deeplink": offer.deeplink,
        "source_id": offer.source_id,
        "seen_at": offer.seen_at,
        "outbound": itinerary.outbound.to_dict(),
        "inbound": itinerary.inbound.to_dict() if itinerary.inbound else None,
    }


def _offer_from_dict(data: Dict[str, Any], source: str, query: SearchQuery) -> Offer:
    # The query is not carried per offer: the caller supplies the search that is
    # asking, so the itinerary is rebuilt against it.
    itinerary = Itinerary(
        query=query,
        outbound=Leg.from_dict(data.get("outbound") or {}),
        inbound=Leg.from_dict(data["inbound"]) if data.get("inbound") else None,
    )
    return Offer(
        itinerary=itinerary,
        source=source,
        price=float(data["price"]),
        currency=data.get("currency") or query.currency,
        agent=data.get("agent") or "",
        deeplink=data.get("deeplink") or "",
        source_id=data.get("source_id") or "",
        **({"seen_at": data["seen_at"]} if data.get("seen_at") else {}),
    )

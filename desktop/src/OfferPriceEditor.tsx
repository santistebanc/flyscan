import { useState } from "react";
import type { Offer } from "./api";
import { useCurrency } from "./currency";

export type CorrectOfferPrice = (trip: string, offer: Offer, eur: number | null) => void;
export function OfferPriceEditor({ trip, offer, onSave, onClose }: {
  trip: string; offer: Offer; onSave: CorrectOfferPrice; onClose: () => void;
}) {
  const view = useCurrency();
  // Keep the editor's currency and conversion fixed while the person types.
  const [editing] = useState(() => ({ currency: view.currency, convert: view.toEur,
    amount: offer.price_base == null ? "" : view.amountIn(offer.price_base).toFixed(2) }));
  const [amount, setAmount] = useState(editing.amount);
  const [error, setError] = useState("");
  const save = (eur: number | null) => {
    try { onSave(trip, offer, eur); onClose(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The price could not be saved."); }
  };
  return <form className="detail-price-editor" onSubmit={(event) => {
    event.preventDefault();
    const value = Number(amount);
    if (!amount.trim() || !Number.isFinite(value) || value <= 0) { setError("Enter a price greater than zero."); return; }
    save(editing.convert(value));
  }}>
    <label>Corrected total in {editing.currency}<input type="number" min="0.01" step="0.01" required autoFocus
      value={amount} onChange={(event) => { setAmount(event.target.value); setError(""); }} /></label>
    <p>Saved for this offer, party and cabin until you restore the source price. Survives source refreshes.</p>
    {error && <p role="alert" className="detail-booking-error">{error}</p>}
    <div className="detail-price-actions"><button type="submit" className="primary">Save price</button>
      <button type="button" onClick={onClose}>Cancel</button>
      {offer.manual_price && <button type="button" onClick={() => save(null)}>Restore source price</button>}
    </div>
  </form>;
}

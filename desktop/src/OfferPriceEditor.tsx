import { useState } from "react";
import type { Offer } from "./api";
import { CURRENCIES, useCurrency } from "./currency";

export type CorrectOfferPrice = (trip: string, offer: Offer, eur: number | null) => void;
export function OfferPriceEditor({ trip, offer, onSave, onClose }: {
  trip: string; offer: Offer; onSave: CorrectOfferPrice; onClose: () => void;
}) {
  const view = useCurrency();
  const stale = offer.stale_price_base;
  const [currency, setCurrency] = useState(view.currency);
  const [amount, setAmount] = useState(() => offer.price_base == null ? "" : view.amountIn(offer.price_base).toFixed(2));
  const codes = CURRENCIES.includes(view.currency) ? CURRENCIES : [view.currency, ...CURRENCIES];
  // What the typed amount comes to in the display currency, when it is another one.
  const typed = Number(amount);
  const typedEur = currency !== view.currency && amount.trim() && Number.isFinite(typed) && typed > 0 ? view.eurFrom(typed, currency) : null;
  const [error, setError] = useState("");
  const save = (eur: number | null) => {
    try { onSave(trip, offer, eur); onClose(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The price could not be saved."); }
  };
  return <form className="detail-price-editor" onSubmit={(event) => {
    event.preventDefault();
    const value = Number(amount);
    if (!amount.trim() || !Number.isFinite(value) || value <= 0) { setError("Enter a price greater than zero."); return; }
    const eur = view.eurFrom(value, currency);
    if (eur === null) { setError(`There is no exchange rate for ${currency} yet. Pick another currency.`); return; }
    save(eur);
  }}>
    <div className="manual-price-amount">
      <label>Corrected total<input type="number" min="0.01" step="0.01" required autoFocus inputMode="decimal"
        value={amount} onChange={(event) => { setAmount(event.target.value); setError(""); }} /></label>
      <label>Currency<select value={currency} onChange={(event) => { setCurrency(event.target.value); setError(""); }}>
        {codes.map((code) => <option key={code} value={code}>{code}</option>)}
      </select></label>
    </div>
    {typedEur !== null && <p className="detail-price-equivalent" aria-live="polite">≈ {view.money(typedEur)} in {view.currency}</p>}
    <p>{stale === undefined ? "Saved for this offer, party and cabin. It stays until the source quotes a new price; then the fresh price wins and this one is kept to reapply."
      : `The source has quoted a new price since you corrected it to ${view.money(stale)}. Reapply that, or enter a new correction.`}</p>
    {error && <p role="alert" className="detail-booking-error">{error}</p>}
    <div className="detail-price-actions"><button type="submit" className="primary">Save price</button>
      <button type="button" onClick={onClose}>Cancel</button>
      {stale !== undefined && <button type="button" onClick={() => save(stale)}>Reapply {view.money(stale)}</button>}
      {offer.manual_price && <button type="button" onClick={() => save(null)}>Restore source price</button>}
      {stale !== undefined && <button type="button" onClick={() => save(null)}>Forget correction</button>}
    </div>
  </form>;
}

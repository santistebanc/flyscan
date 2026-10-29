import { useState } from "react";
import type { Cabin } from "./api";
import { CURRENCIES, useCurrency } from "./currency";
import { CABINS, CABIN_LABELS, Stepper } from "./TravellersPicker";

export interface ManualParty { adults: number; children: number; infants: number; cabin: Cabin }
export interface ManualPriceValues { eur: number; agent: string; deeplink: string; party: ManualParty }

export function describeManualParty(party: ManualParty): string {
  const count = party.adults + party.children + party.infants;
  return `For ${count === 1 ? "1 adult" : `${count} travellers`} · ${CABIN_LABELS[party.cabin]}`;
}

/**
 * The price half of a hand-entered fare: what was paid, to whom, and where to
 * book it. Typed in any currency with a known rate; stored in EUR like every
 * price. The party is the search's unless changed, and only when `partyEditable`.
 */
export function ManualPriceForm({ initial, party: defaultParty, partyEditable, submitLabel, note, onSubmit, onCancel }: {
  initial?: { eur?: number | null; agent?: string; deeplink?: string };
  party: ManualParty; partyEditable: boolean; submitLabel: string; note?: string;
  onSubmit: (values: ManualPriceValues) => Promise<void>; onCancel: () => void;
}) {
  const view = useCurrency();
  const [currency, setCurrency] = useState(view.currency);
  const [amount, setAmount] = useState(() =>
    initial?.eur == null ? "" : view.amountIn(initial.eur).toFixed(2));
  const [agent, setAgent] = useState(initial?.agent ?? "");
  const [deeplink, setDeeplink] = useState(initial?.deeplink ?? "");
  const [party, setParty] = useState(defaultParty);
  const [choosingParty, setChoosingParty] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const codes = CURRENCIES.includes(view.currency) ? CURRENCIES : [view.currency, ...CURRENCIES];

  return <form className="manual-price-form" onSubmit={async (event) => {
    event.preventDefault();
    const value = Number(amount);
    if (!amount.trim() || !Number.isFinite(value) || value <= 0) { setError("Enter a price greater than zero."); return; }
    const eur = view.eurFrom(value, currency);
    if (eur === null) { setError(`There is no exchange rate for ${currency} yet. Pick another currency.`); return; }
    const link = deeplink.trim();
    if (link && !/^https?:\/\//i.test(link)) { setError("The booking link has to start with http:// or https://."); return; }
    setSaving(true);
    setError("");
    try { await onSubmit({ eur, agent: agent.trim(), deeplink: link, party }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The price could not be saved."); }
    finally { setSaving(false); }
  }}>
    <div className="manual-price-amount">
      <label>Total price<input type="number" min="0.01" step="0.01" required autoFocus inputMode="decimal"
        value={amount} onChange={(event) => { setAmount(event.target.value); setError(""); }} /></label>
      <label>Currency<select value={currency} onChange={(event) => setCurrency(event.target.value)}>
        {codes.map((code) => <option key={code} value={code}>{code}</option>)}
      </select></label>
    </div>
    <label>Seller<input type="text" placeholder="e.g. ryanair.com" value={agent} maxLength={80}
      onChange={(event) => setAgent(event.target.value)} /></label>
    <label>Booking link <span className="manual-optional">optional</span>
      <input type="url" placeholder="https://" value={deeplink} onChange={(event) => setDeeplink(event.target.value)} /></label>
    {partyEditable && <div className="manual-party">
      <span>{describeManualParty(party)}</span>
      <button type="button" className="manual-link" aria-expanded={choosingParty}
        onClick={() => setChoosingParty((open) => !open)}>{choosingParty ? "Done" : "Change"}</button>
      {choosingParty && <div className="manual-party-panel">
        <Stepper label="Adults" note="12 and over" value={party.adults} min={1} max={9}
          onChange={(adults) => setParty((was) => ({ ...was, adults }))} />
        <Stepper label="Children" note="2–11" value={party.children} min={0} max={8}
          onChange={(children) => setParty((was) => ({ ...was, children }))} />
        <Stepper label="Infants" note="Under 2, on lap" value={party.infants} min={0} max={8}
          onChange={(infants) => setParty((was) => ({ ...was, infants }))} />
        <div className="cabin-options" role="group" aria-label="Cabin">
          {CABINS.map((option) => <button type="button" key={option} aria-pressed={party.cabin === option}
            onClick={() => setParty((was) => ({ ...was, cabin: option }))}>{CABIN_LABELS[option]}</button>)}
        </div>
      </div>}
    </div>}
    {note && <p className="manual-note">{note}</p>}
    {error && <p role="alert" className="detail-booking-error">{error}</p>}
    <div className="detail-price-actions">
      <button type="submit" className="primary" disabled={saving}>{saving ? "Saving…" : submitLabel}</button>
      <button type="button" onClick={onCancel}>Cancel</button>
    </div>
  </form>;
}

import { useCallback, useRef } from "react";
import type { Cabin } from "./api";
import { SearchSegment, useDismiss, useKeepInView } from "./Popover";
import { Icon } from "./Icon";

export const CABINS: Cabin[] = ["economy", "premiumeconomy", "business", "first"];
export const CABIN_LABELS: Record<Cabin, string> = {
  economy: "Economy",
  premiumeconomy: "Premium economy",
  business: "Business",
  first: "First",
};

export interface Party { adults: number; children: number; infants: number; cabin: Cabin; currency: string }

export function Stepper({ label, note, value, min, max, onChange }: {
  label: string; note: string; value: number; min: number; max: number; onChange: (next: number) => void;
}) {
  return <div className="stepper" role="group" aria-label={label}>
    <span className="stepper-label">{label}<span>{note}</span></span>
    <button type="button" disabled={value <= min} aria-label={`Fewer ${label.toLowerCase()}`}
      onClick={() => onChange(value - 1)}>−</button>
    <b aria-live="polite">{value}</b>
    <button type="button" disabled={value >= max} aria-label={`More ${label.toLowerCase()}`}
      onClick={() => onChange(value + 1)}>+</button>
  </div>;
}

/**
 * Party, cabin and quote currency. Part of the search itself: changing any of
 * it re-reads the database for exactly that party, and a scrape asks for it.
 */
export function TravellersPicker({ party, currencies, open, onToggle, onChange }: {
  party: Party; currencies: string[]; open: boolean; onToggle: (open: boolean) => void;
  onChange: (next: Partial<Party>) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = useCallback(() => onToggle(false), [onToggle]);
  useDismiss(open, close, root);
  useKeepInView(open, panel);
  const count = party.adults + party.children + party.infants;
  const cabin = party.cabin === "premiumeconomy" ? "Premium" : CABIN_LABELS[party.cabin];
  const who = count === 1 ? "adult" : "travellers";
  const rest = `${cabin}${party.currency !== "EUR" ? ` · ${party.currency}` : ""}`;
  // The word gives way to a person icon when the header is narrow (styles.css).
  return <SearchSegment label="Travellers" value={String(count)} open={open} root={root}
    hint={<><span className="party-word">{who}</span><Icon name="person" className="party-icon" /> · {rest}</>}
    hintText={`${who} · ${rest}`}
    onToggle={() => onToggle(!open)}>
    <div className="popover travellers-popover" ref={panel} role="dialog" aria-label="Travellers and cabin">
      <Stepper label="Adults" note="12 and over" value={party.adults} min={1} max={9} onChange={(adults) => onChange({ adults })} />
      <Stepper label="Children" note="2–11" value={party.children} min={0} max={8} onChange={(children) => onChange({ children })} />
      <Stepper label="Infants" note="Under 2, on lap" value={party.infants} min={0} max={8} onChange={(infants) => onChange({ infants })} />
      <div className="travellers-heading">Cabin</div>
      <div className="cabin-options" role="group" aria-label="Cabin">
        {CABINS.map((option) => <button type="button" key={option} aria-pressed={party.cabin === option}
          onClick={() => onChange({ cabin: option })}>{CABIN_LABELS[option]}</button>)}
      </div>
      <label className="quote-field">Quote in
        <select value={party.currency} onChange={(event) => onChange({ currency: event.target.value })}>
          {currencies.map((code) => <option key={code} value={code}>{code}</option>)}
        </select>
      </label>
      <p className="popover-note">Changing travellers shows the prices stored for exactly this party. Nothing is fetched until you press Fetch.</p>
    </div>
  </SearchSegment>;
}

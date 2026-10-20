/** Compact controls for the flights already listed; changes never scrape. */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useCurrency } from "./currency";
import { Icon } from "./Icon";
import { elapsed } from "./flightTimeline";
import { roundLimitPresets, timePresets, type ConnectionFilterOptions, type FilterRanges } from "./filterSuggestions";
import { DEFAULT_FILTERS, OPEN_FILTERS, filtersActive, filtersChanged, formatClock,
  type DirectionTimes, type ListFilters } from "./flightFilters";

export const FILTERS_KEY = "flight-scraper:list-filters";
type Panel = "stops" | "price" | "duration" | "layovers" | "times";
const TITLES: Record<Panel, string> = { stops: "Stops", price: "Price", duration: "Journey duration", layovers: "Layovers", times: "Departure & arrival" };
const timeOptions = Array.from({ length: 49 }, (_, i) => i * 30);

function LimitInput({ label, unit, value, onCommit }: {
  label: string; unit: string; value: number | null; onCommit: (value: number | null) => void;
}) {
  const format = (n: number | null) => n === null ? "" : String(Math.round(n * 100) / 100);
  const [text, setText] = useState(() => format(value));
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(format(value)); }, [value]);
  const parse = (raw: string) => raw.trim() && Number.isFinite(Number(raw)) && Number(raw) > 0 ? Number(raw) : null;
  return <label className="filter-limit-label">
    <span>{label}</span>
    <span className="filter-limit-field">
      <input data-autofocus inputMode="decimal" aria-label={label} placeholder="No limit" value={text}
        onFocus={() => { focused.current = true; }}
        onChange={(e) => { setText(e.target.value); onCommit(parse(e.target.value)); }}
        onBlur={() => { focused.current = false; setText(format(value)); }} />
      <span>{unit}</span>
    </span>
  </label>;
}

function TimeBound({ label, accessibleLabel, value, minimum, suggestions, onChange }: {
  label: string; accessibleLabel: string; value: number; minimum: boolean; suggestions: number[]; onChange: (next: number) => void;
}) {
  const unrestricted = minimum ? 0 : 1440;
  return <div className="filter-time-range">
    <label className="filter-time-bound-label">
      <span>{label}</span>
      <select aria-label={accessibleLabel} value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {timeOptions.map((m) => <option key={m} value={m}>{m === unrestricted ? "Any time" : formatClock(m)}</option>)}
      </select>
    </label>
    <span className="time-range-track">
      <span className="time-range-rail" />
      <span className="time-range-fill" style={{ left: `${minimum ? value / 1440 * 100 : 0}%`, width: `${(minimum ? 1440 - value : value) / 1440 * 100}%` }} />
      <input type="range" min={0} max={48} step={1} value={value / 30}
        aria-label={`${accessibleLabel} slider`} aria-valuetext={value === unrestricted ? "Any time" : formatClock(value)}
        onChange={(e) => onChange(Number(e.target.value) * 30)} />
    </span>
    <div className="filter-dayparts" role="group" aria-label={`${accessibleLabel} quick times`}>
      {[...new Set(suggestions.filter((minutes) => minutes !== unrestricted)), unrestricted].map((minutes) => <button type="button" key={minutes}
        aria-pressed={value === minutes} onClick={() => onChange(minutes)}>
        {minutes === unrestricted ? "Any time" : formatClock(minutes)}
      </button>)}
    </div>
  </div>;
}

export function FlightFiltersBar({ filters, onChange, shown, total, roundTrip = true, suggestions, connectionOptions }: {
  filters: ListFilters; onChange: (next: ListFilters) => void; shown: number; total: number; roundTrip?: boolean; suggestions: FilterRanges;
  connectionOptions: ConnectionFilterOptions;
}) {
  const { currency, roundedIn, toEur, money } = useCurrency();
  const [open, setOpen] = useState<Panel | null>(null);
  const [direction, setDirection] = useState<"outbound" | "inbound">("outbound");
  const root = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const triggers = useRef<Partial<Record<Panel, HTMLButtonElement>>>({});
  const id = useId();
  const [position, setPosition] = useState({ left: 12, top: 0, maxHeight: 600 });
  const effective = roundTrip ? filters : { ...filters, inbound: OPEN_FILTERS.inbound };
  const active = filtersActive(effective);
  const changed = filtersChanged(effective);
  const timeCount = [effective.outbound.depart.from > 0, effective.outbound.arrive.to < 1440,
    effective.inbound.depart.from > 0, effective.inbound.arrive.to < 1440].filter(Boolean).length;
  const close = () => { if (open) triggers.current[open]?.focus({ preventScroll: true }); setOpen(null); };
  const displayedDirection = roundTrip ? direction : "outbound";
  const times = filters[displayedDirection];
  const changeTimes = (next: DirectionTimes) => onChange({ ...filters, [displayedDirection]: next });
  // Only these few display values depend on currency. The dataset scan is
  // memoized by App, so opening a filter or editing a limit never rescans it.
  const prices = suggestions.priceEur && { min: roundedIn(suggestions.priceEur.min), max: roundedIn(suggestions.priceEur.max) };
  const priceValues = suggestions.limits.priceEur.map(roundedIn);
  const priceSpan = priceValues.length ? priceValues[priceValues.length - 1]! - priceValues[0]! : 0;
  const priceStep = Math.max(1, 10 ** Math.floor(Math.log10(Math.max(1, priceSpan) / 5)));
  const pricePresets = roundLimitPresets(priceValues, prices?.max, priceStep);
  const durationRange = suggestions.durationMinutes;
  const durationValues = suggestions.limits.durationMinutes;
  const durationSpan = durationValues.length ? durationValues[durationValues.length - 1]! - durationValues[0]! : 0;
  const durationPresets = open === "layovers"
    ? [...new Set([...connectionOptions.layoverMinutes, ...(filters.maxLayoverMinutes === null ? [] : [filters.maxLayoverMinutes])])].sort((a, b) => a - b)
    : roundLimitPresets(durationValues, durationRange?.max, durationSpan > 180 ? 30 : 5);
  const stopChoices = [...new Set([...connectionOptions.stops, ...(filters.maxStops === null ? [] : [filters.maxStops])])].sort((a, b) => a - b);

  useLayoutEffect(() => {
    if (!open || !popup.current || !triggers.current[open]) return;
    const anchor = triggers.current[open]!.getBoundingClientRect();
    const width = popup.current.getBoundingClientRect().width;
    const height = Math.min(popup.current.scrollHeight, innerHeight - 24);
    const below = innerHeight - anchor.bottom - 20;
    const top = below >= Math.min(height, 240) || below >= anchor.top - 20
      ? anchor.bottom + 8 : Math.max(12, anchor.top - height - 8);
    const right = Math.min(innerWidth, root.current?.closest(".results-bar")?.getBoundingClientRect().right ?? innerWidth);
    const next = { left: Math.max(12, Math.min(anchor.left, right - width - 12)), top, maxHeight: Math.max(80, innerHeight - top - 12) };
    setPosition((old) => old.left === next.left && old.top === next.top && old.maxHeight === next.maxHeight ? old : next);
  }, [open, filters]);
  useEffect(() => {
    if (!open) return;
    popup.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true });
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) setOpen(null);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); triggers.current[open]?.focus({ preventScroll: true }); setOpen(null); }
    };
    const resize = () => setOpen(null);
    document.addEventListener("pointerdown", away);
    window.addEventListener("keydown", key, true);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", resize);
    };
  }, [open]);

  const controls: { name: Panel; label: string; value?: string; active: boolean; icon: "stops" | "price" | "waiting" | "connection" }[] = [
    { name: "stops", label: "Stops", value: filters.maxStops === 0 ? "Nonstop" : filters.maxStops === null ? filters.excludeRepeatedAirports ? undefined : "All routes" : `≤ ${filters.maxStops}`, active: filters.maxStops !== DEFAULT_FILTERS.maxStops || filters.excludeRepeatedAirports !== DEFAULT_FILTERS.excludeRepeatedAirports, icon: "stops" },
    { name: "price", label: "Price", value: filters.maxPriceEur === null ? undefined : `≤ ${money(filters.maxPriceEur)}`, active: filters.maxPriceEur !== null, icon: "price" },
    { name: "duration", label: "Duration", value: filters.maxDurationMinutes === null ? undefined : `≤ ${elapsed(filters.maxDurationMinutes)}`, active: filters.maxDurationMinutes !== null, icon: "waiting" },
    { name: "layovers", label: "Layovers", value: filters.maxLayoverMinutes === null ? "No limit" : `≤ ${elapsed(filters.maxLayoverMinutes)}`, active: filters.maxLayoverMinutes !== DEFAULT_FILTERS.maxLayoverMinutes, icon: "connection" },
    { name: "times", label: "Times", value: timeCount ? String(timeCount) : undefined, active: timeCount > 0, icon: "waiting" },
  ];

  return <div className="flight-filters" ref={root} role="group" aria-label="Filter flights">
    {controls.map((control) => <button type="button" key={control.name}
      ref={(node) => { if (node) triggers.current[control.name] = node; }}
      className="flight-filter-trigger" data-active={control.active || undefined}
      aria-label={control.value ? `${control.label}: ${control.value}` : control.label}
      aria-haspopup="dialog" aria-expanded={open === control.name}
      aria-controls={open === control.name ? id : undefined}
      onClick={() => setOpen((was) => was === control.name ? null : control.name)}>
      <Icon name={control.icon} /><span>{control.label}</span>{control.value && <b>{control.value}</b>}<Icon name="chevron-down" />
    </button>)}
    {(active || changed) && <span className="filter-count" role="status" aria-live="polite" aria-atomic="true">{shown.toLocaleString()} of {total.toLocaleString()}</span>}
    {changed && <button type="button" className="filter-reset-all" onClick={() => onChange(DEFAULT_FILTERS)} title="Restore default filters"><Icon name="retry" /> Reset</button>}
    {open && createPortal(<div id={id} ref={popup} className={`flight-filter-panel${open === "times" ? " filter-times-panel" : ""}`}
      role="dialog" aria-label={TITLES[open]} style={position}>
      <div className="filter-panel-heading"><h3>{TITLES[open]}</h3><button type="button" aria-label="Close filter" title="Close" onClick={close}><Icon name="cancel" /></button></div>
      {open === "stops" && <>
        <p className="filter-panel-note">Maximum stops in each direction.</p>
        <div className="filter-stop-options" role="group" aria-label="Maximum stops">
          {[...stopChoices, null].map((stops) =>
            <button type="button" key={stops ?? "any"} data-autofocus={filters.maxStops === stops || undefined}
              aria-pressed={filters.maxStops === stops} onClick={() => onChange({ ...filters, maxStops: stops })}>
              <span>{stops === null ? "Any number of stops" : stops === 0 ? "Nonstop only" : `Up to ${stops} stop${stops === 1 ? "" : "s"}`}</span>
              {filters.maxStops === stops && <Icon name="done" />}
            </button>)}
        </div>
        <label className="filter-checkbox">
          <input type="checkbox" checked={filters.excludeRepeatedAirports}
            onChange={(event) => onChange({ ...filters, excludeRepeatedAirports: event.target.checked })} />
          Hide routes that revisit an airport
        </label>
        <p className="filter-panel-note">Checked separately for outbound and return journeys.</p>
      </>}
      {open === "price" && <>
        <LimitInput label="Maximum total price" unit={currency} value={filters.maxPriceEur === null ? null : roundedIn(filters.maxPriceEur)}
          onCommit={(amount) => onChange({ ...filters, maxPriceEur: amount === null ? null : toEur(amount) })} />
        <div className="filter-presets" role="group" aria-label="Price quick limits">
          {[...pricePresets, null].map((amount) => <button type="button" key={amount ?? "any"}
            aria-pressed={amount === null ? filters.maxPriceEur === null : filters.maxPriceEur !== null && roundedIn(filters.maxPriceEur) === amount}
            onClick={() => onChange({ ...filters, maxPriceEur: amount === null ? null : toEur(amount) })}>{amount === null ? "Any price" : money(toEur(amount))}</button>)}
        </div>
      </>}
      {(open === "duration" || open === "layovers") && <>
        <LimitInput label={open === "duration" ? "Maximum journey time" : "Maximum connection time"} unit="hours"
          value={(open === "duration" ? filters.maxDurationMinutes : filters.maxLayoverMinutes) === null ? null : (open === "duration" ? filters.maxDurationMinutes! : filters.maxLayoverMinutes!) / 60}
          onCommit={(hours) => onChange({ ...filters, [open === "duration" ? "maxDurationMinutes" : "maxLayoverMinutes"]: hours === null ? null : Math.max(1, Math.round(hours * 60)) })} />
        <div className="filter-presets" role="group" aria-label="Duration quick limits">
          {[...durationPresets, null].map((minutes) => <button type="button" key={minutes ?? "any"}
            aria-pressed={(open === "duration" ? filters.maxDurationMinutes : filters.maxLayoverMinutes) === minutes}
            onClick={() => onChange({ ...filters, [open === "duration" ? "maxDurationMinutes" : "maxLayoverMinutes"]: minutes })}>{minutes === null ? "No limit" : elapsed(minutes)}</button>)}
        </div>
        <p className="filter-panel-note">{open === "duration" ? "Includes flights and connections, per direction." : "Applies to each connection in both directions, including airport changes. Overnight connections within the limit are included."}</p>
      </>}
      {open === "times" && <>
        {roundTrip && <div className="filter-direction-tabs" role="group" aria-label="Journey direction">
          <button type="button" data-autofocus={displayedDirection === "outbound" || undefined} aria-pressed={displayedDirection === "outbound"} onClick={() => setDirection("outbound")}>Outbound</button>
          <button type="button" data-autofocus={displayedDirection === "inbound" || undefined} aria-pressed={displayedDirection === "inbound"} onClick={() => setDirection("inbound")}>Return</button>
        </div>}
        <TimeBound label="Depart after" accessibleLabel={`${displayedDirection === "outbound" ? "Outbound" : "Return"} depart after`} minimum value={times.depart.from}
          suggestions={timePresets(suggestions[displayedDirection].depart, true)}
          onChange={(from) => changeTimes({ ...times, depart: { from, to: 1440 } })} />
        <TimeBound label="Arrive before" accessibleLabel={`${displayedDirection === "outbound" ? "Outbound" : "Return"} arrive before`} minimum={false} value={times.arrive.to}
          suggestions={timePresets(suggestions[displayedDirection].arrive, false)}
          onChange={(to) => changeTimes({ ...times, arrive: { from: 0, to } })} />
        <div className="filter-times-footer"><span>Local airport times</span>{timeCount > 0 && <button type="button" onClick={() => onChange({ ...filters, outbound: OPEN_FILTERS.outbound, inbound: OPEN_FILTERS.inbound })}>Reset times</button>}</div>
      </>}
    </div>, document.body)}
  </div>;
}

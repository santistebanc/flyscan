/** Compact controls for the flights already listed; changes never scrape. */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useCurrency } from "./currency";
import { Icon } from "./Icon";
import { elapsed } from "./flightTimeline";
import { roundLimitPresets, type ConnectionFilterOptions, type FilterRanges } from "./filterSuggestions";
import { ANY_ARRIVAL, DEFAULT_FILTERS, filtersActive, filtersChanged, formatArrival, formatClock, setDirectionLimits,
  setSeparate, type DirectionLimits, type DirectionalFilter, type ListFilters } from "./flightFilters";

export const FILTERS_KEY = "flight-scraper:list-filters";
type Panel = "stops" | "price" | "duration" | "layovers" | "times";
type Direction = "outbound" | "inbound";
const TITLES: Record<Panel, string> = { stops: "Stops", price: "Price", duration: "Duration", layovers: "Layovers", times: "Departure and arrival times" };
const DIRECTION_NAMES: Record<Direction, string> = { outbound: "Outbound", inbound: "Return" };
/** Every half hour of a day, 00:00 to 23:30. */
const timeOptions = Array.from({ length: 48 }, (_, i) => i * 30);

function LimitInput({ label, accessibleLabel = label, unit, value, onCommit }: {
  label: string; accessibleLabel?: string; unit: string; value: number | null; onCommit: (value: number | null) => void;
}) {
  const format = (n: number | null) => n === null ? "" : String(Math.round(n * 100) / 100);
  const [text, setText] = useState(() => format(value));
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(format(value)); }, [value]);
  const parse = (raw: string) => raw.trim() && Number.isFinite(Number(raw)) && Number(raw) > 0 ? Number(raw) : null;
  return <label className="filter-limit-label">
    <span>{label}</span>
    <span className="filter-limit-field">
      <input data-autofocus inputMode="decimal" aria-label={accessibleLabel} placeholder="No limit" value={text}
        onFocus={() => { focused.current = true; }}
        onChange={(e) => { setText(e.target.value); onCommit(parse(e.target.value)); }}
        onBlur={() => { focused.current = false; setText(format(value)); }} />
      <span>{unit}</span>
    </span>
  </label>;
}

/** The design's quick picks; the dropdown still reaches any half hour. */
const DEPART_PRESETS = [0, 360, 540, 720, 900];
const ARRIVE_PRESETS = [ANY_ARRIVAL, 1080, 1320, 1440 + 720, 2 * 1440 + 720];
/** Arrival choices by day: the departure day, the next one, and the one after. */
const ARRIVE_DAYS = ["Departure day", "Next day", "Two days later"];

function TimeBound({ label, accessibleLabel, value, minimum, autoFocus, onChange }: {
  label: string; accessibleLabel: string; value: number; minimum: boolean; autoFocus?: boolean; onChange: (next: number) => void;
}) {
  const unrestricted = minimum ? 0 : ANY_ARRIVAL;
  const format = minimum ? formatClock : formatArrival;
  return <div className="filter-time-range">
    <label className="filter-time-bound-label">
      <span>{label}</span>
      <select data-autofocus={autoFocus || undefined} aria-label={accessibleLabel} value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {minimum ? timeOptions.map((m) => <option key={m} value={m}>{m === unrestricted ? "Any time" : format(m)}</option>) : <>
          <option value={unrestricted}>Any time</option>
          {ARRIVE_DAYS.map((day, d) => <optgroup key={day} label={day}>
            {timeOptions.map((m) => d * 1440 + m).filter((m) => m > 0).map((m) =>
              <option key={m} value={m}>{format(m)}</option>)}
          </optgroup>)}
        </>}
      </select>
    </label>
    <div className="filter-dayparts" role="group" aria-label={`${accessibleLabel} quick times`}>
      {(minimum ? DEPART_PRESETS : ARRIVE_PRESETS).map((minutes) => <button type="button" key={minutes}
        aria-pressed={value === minutes} onClick={() => onChange(minutes)}>
        {minutes === unrestricted ? "Any" : format(minutes)}
      </button>)}
    </div>
  </div>;
}

const timeBounds = (limits: DirectionLimits) => Number(limits.depart.from > 0) + Number(limits.arrive.to < ANY_ARRIVAL);
const stopsText = (stops: number | null) => stops === null ? undefined : stops === 0 ? "Nonstop" : `≤ ${stops}`;
const minutesText = (minutes: number | null) => minutes === null ? undefined : `≤ ${elapsed(minutes)}`;

export function FlightFiltersBar({ filters, onChange, shown, total, roundTrip = true, suggestions, connectionOptions }: {
  filters: ListFilters; onChange: (next: ListFilters) => void; shown: number; total: number; roundTrip?: boolean; suggestions: FilterRanges;
  connectionOptions: ConnectionFilterOptions;
}) {
  const { currency, roundedIn, toEur, money } = useCurrency();
  const [open, setOpen] = useState<Panel | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const triggers = useRef<Partial<Record<Panel, HTMLButtonElement>>>({});
  const id = useId();
  const [position, setPosition] = useState({ left: 12, top: 0, maxHeight: 600 });
  /** Return limits only exist for a round trip; on a one-way the outbound ones are all there is. */
  const separate = (filter: DirectionalFilter) => roundTrip && filters.separate[filter];
  const effective = roundTrip ? filters : { ...filters, inbound: filters.outbound };
  const active = filtersActive(effective);
  const changed = filtersChanged(effective);
  const timeCount = timeBounds(filters.outbound) + (separate("times") ? timeBounds(filters.inbound) : 0);
  const close = () => { if (open) triggers.current[open]?.focus({ preventScroll: true }); setOpen(null); };
  const set = (filter: DirectionalFilter, direction: Direction, patch: Partial<DirectionLimits>) =>
    onChange(setDirectionLimits(filters, filter, direction, patch));
  // Only these few display values depend on currency. The dataset scan is
  // memoized by App, so opening a filter or editing a limit never rescans it.
  const prices = suggestions.priceEur && { min: roundedIn(suggestions.priceEur.min), max: roundedIn(suggestions.priceEur.max) };
  const priceValues = suggestions.limits.priceEur.map(roundedIn);
  const priceSpan = priceValues.length ? priceValues[priceValues.length - 1]! - priceValues[0]! : 0;
  const priceStep = Math.max(1, 10 ** Math.floor(Math.log10(Math.max(1, priceSpan) / 5)));
  const pricePresets = roundLimitPresets(priceValues, prices?.max, priceStep);
  /** Choices for one direction's cap, or for both when the filter is not separate. */
  const durationPresets = (filter: "duration" | "layovers", direction: Direction) => {
    const own = separate(filter);
    if (filter === "layovers") {
      const current = filters[direction].maxLayoverMinutes;
      const options = own ? connectionOptions[direction].layoverMinutes : connectionOptions.layoverMinutes;
      return [...new Set([...options, ...(current === null ? [] : [current])])].sort((a, b) => a - b);
    }
    const range = own ? suggestions[direction].durationMinutes : suggestions.durationMinutes;
    const values = own ? suggestions[direction].limits : suggestions.limits.durationMinutes;
    const span = values.length ? values[values.length - 1]! - values[0]! : 0;
    return roundLimitPresets(values, range?.max, span > 180 ? 30 : 5);
  };

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

  /** A chip's value: one text when both directions agree, "outbound / return" when they differ. */
  const chip = (filter: DirectionalFilter, describe: (limits: DirectionLimits) => string | undefined, none = "Any") => {
    const outbound = describe(filters.outbound);
    if (!separate(filter)) return { value: outbound };
    const inbound = describe(filters.inbound);
    if (outbound === inbound) return { value: outbound };
    return { value: `${outbound ?? none} / ${inbound ?? none}`,
      title: `Outbound: ${outbound ?? none} · Return: ${inbound ?? none}` };
  };
  const either = (test: (limits: DirectionLimits) => boolean) => test(filters.outbound) || (roundTrip && test(filters.inbound));
  const stopsChip = chip("stops", (d) => stopsText(d.maxStops));
  const durationChip = chip("duration", (d) => minutesText(d.maxDurationMinutes));
  const layoversChip = chip("layovers", (d) => minutesText(d.maxLayoverMinutes) ?? "No limit", "No limit");
  const controls: { name: Panel; label: string; value?: string; title?: string; active: boolean }[] = [
    { name: "stops", label: "Stops", ...stopsChip,
      value: stopsChip.value ?? (filters.excludeRepeatedAirports ? undefined : "All routes"),
      active: either((d) => d.maxStops !== null) || filters.excludeRepeatedAirports !== DEFAULT_FILTERS.excludeRepeatedAirports },
    { name: "price", label: "Price", value: filters.maxPriceEur === null ? undefined : `≤ ${money(filters.maxPriceEur)}`, active: filters.maxPriceEur !== null },
    { name: "duration", label: "Duration", ...durationChip, active: either((d) => d.maxDurationMinutes !== null) },
    { name: "layovers", label: "Layovers", ...layoversChip,
      active: either((d) => d.maxLayoverMinutes !== DEFAULT_FILTERS.outbound.maxLayoverMinutes) },
    { name: "times", label: "Times", value: timeCount ? String(timeCount) : undefined, active: timeCount > 0 },
  ];

  /**
   * A panel's controls once for both directions, or under an Outbound and a
   * Return heading when the filter is separate, with the switch between them.
   */
  const directional = (filter: DirectionalFilter, body: (direction: Direction, name: string, first: boolean) => ReactNode) => <>
    {(separate(filter) ? ["outbound", "inbound"] as const : ["outbound"] as const).map((direction, i) => {
      const name = separate(filter) ? DIRECTION_NAMES[direction] : "";
      return <div key={direction} className="filter-direction" role={name ? "group" : undefined} aria-label={name || undefined}>
        {name && <h4 className="filter-direction-heading">{name}</h4>}
        {body(direction, name, i === 0)}
      </div>;
    })}
    {roundTrip && <label className="filter-checkbox filter-separate">
      <input type="checkbox" checked={filters.separate[filter]} onChange={(event) => onChange(setSeparate(filters, filter, event.target.checked))} />
      Set outbound and return separately
    </label>}
  </>;
  const labelled = (name: string, text: string) => name ? `${name} ${text.charAt(0).toLowerCase()}${text.slice(1)}` : text;

  return <div className="flight-filters" ref={root} role="group" aria-label="Filter flights">
    {controls.map((control) => <button type="button" key={control.name}
      ref={(node) => { if (node) triggers.current[control.name] = node; }}
      className="flight-filter-trigger" data-active={control.active || undefined} title={control.title}
      aria-label={control.value ? `${control.label}: ${control.title ?? control.value}` : control.label}
      aria-haspopup="dialog" aria-expanded={open === control.name}
      aria-controls={open === control.name ? id : undefined}
      onClick={() => setOpen((was) => was === control.name ? null : control.name)}>
      <span>{control.label}</span>{control.value && <b>{control.value}</b>}<Icon name="chevron-down" />
    </button>)}
    {(active || changed) && total > 0 && <span className="filter-count" role="status" aria-live="polite" aria-atomic="true">{shown.toLocaleString()} of {total.toLocaleString()}</span>}
    {changed && <button type="button" className="filter-reset-all" onClick={() => onChange(DEFAULT_FILTERS)} title="Restore default filters">Reset</button>}
    {open && createPortal(<div id={id} ref={popup} className={`flight-filter-panel${open === "times" ? " filter-times-panel" : ""}`}
      role="dialog" aria-label={TITLES[open]} style={position}>
      <div className="filter-panel-heading"><h3>{TITLES[open]}</h3><button type="button" aria-label="Close filter" title="Close" onClick={close}><Icon name="cancel" /></button></div>
      {open === "stops" && <>
        {!separate("stops") && <p className="filter-panel-note">Maximum stops in each direction.</p>}
        {directional("stops", (direction, name, first) => {
          const value = filters[direction].maxStops;
          const options = separate("stops") ? connectionOptions[direction].stops : connectionOptions.stops;
          const choices = [...new Set([...options, ...(value === null ? [] : [value])])].sort((a, b) => a - b);
          return <div className="filter-stop-options" role="group" aria-label={labelled(name, "Maximum stops")}>
            {[...choices, null].map((stops) =>
              <button type="button" key={stops ?? "any"} data-autofocus={(first && value === stops) || undefined}
                aria-pressed={value === stops} onClick={() => set("stops", direction, { maxStops: stops })}>
                <span>{stops === null ? "Any number of stops" : stops === 0 ? "Nonstop only" : `Up to ${stops} stop${stops === 1 ? "" : "s"}`}</span>
                {value === stops && <Icon name="done" />}
              </button>)}
          </div>;
        })}
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
        {directional(open, (direction, name) => {
          const field = open === "duration" ? "maxDurationMinutes" : "maxLayoverMinutes";
          const value = filters[direction][field];
          const label = open === "duration" ? "Maximum journey time" : "Maximum connection time";
          return <>
            <LimitInput key={direction} label={label} accessibleLabel={labelled(name, label)} unit="hours" value={value === null ? null : value / 60}
              onCommit={(hours) => set(open, direction, { [field]: hours === null ? null : Math.max(1, Math.round(hours * 60)) })} />
            <div className="filter-presets" role="group" aria-label={labelled(name, "Duration quick limits")}>
              {[...durationPresets(open, direction), null].map((minutes) => <button type="button" key={minutes ?? "any"}
                aria-pressed={value === minutes}
                onClick={() => set(open, direction, { [field]: minutes })}>{minutes === null ? "No limit" : elapsed(minutes)}</button>)}
            </div>
          </>;
        })}
        <p className="filter-panel-note">{open === "duration" ? "Includes flights and connections, per direction." : "Applies to each connection, including airport changes. Overnight connections within the limit are included."}</p>
      </>}
      {open === "times" && <>
        {directional("times", (direction, name, first) => {
          const times = filters[direction];
          return <>
            <TimeBound label="Depart after" accessibleLabel={labelled(name, "Depart after")} minimum value={times.depart.from} autoFocus={first}
              onChange={(from) => set("times", direction, { depart: { from, to: 1440 } })} />
            <TimeBound label="Arrive before" accessibleLabel={labelled(name, "Arrive before")} minimum={false} value={times.arrive.to}
              onChange={(to) => set("times", direction, { arrive: { from: 0, to } })} />
          </>;
        })}
        <div className="filter-times-footer"><span>Local airport times</span>{timeCount > 0 && <button type="button"
          onClick={() => onChange({ ...filters,
            outbound: { ...filters.outbound, depart: DEFAULT_FILTERS.outbound.depart, arrive: DEFAULT_FILTERS.outbound.arrive },
            inbound: { ...filters.inbound, depart: DEFAULT_FILTERS.inbound.depart, arrive: DEFAULT_FILTERS.inbound.arrive } })}>Reset times</button>}</div>
      </>}
    </div>, document.body)}
  </div>;
}

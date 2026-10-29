/**
 * Changing the flights of a trip only you sell.
 *
 * Two halves side by side. The builder: which direction, a form for one
 * flight, the flights added so far and a timeline of the trip they make. The
 * suggestions: stored itineraries and single flights that fit what is typed,
 * updating as it is typed. Picking an itinerary fills in every flight; picking
 * a flight lists the itineraries that use it.
 */

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { FlightRow, FlightScraperApi, Leg, ManualOfferRequest, Segment } from "./api";
import { useCurrency } from "./currency";
import { Icon } from "./Icon";
import {
  arrivalOffset, arrivalStamp, clockMinutes, draftLeg, draftProblem, emptyDraft, fieldOptions, itinerarySuggestions,
  legDrafts, legSuggestions, nextDraft, parseFlightLine, segmentDraft, segmentPayload, typed, datedLegs, departureDay,
  type Building, type Direction, type DraftField, type FieldOption, type FlightDraft, type LegSuggestion,
} from "./manualEntry";
import { useBackdropDismiss } from "./Popover";
import { PlaceInput } from "./PlaceInput";
import type { ManualParty } from "./ManualPriceForm";
import { FlightTimeline } from "./TimelineFlight";
import { elapsed, flightTimelines } from "./flightTimeline";
import { todayISO } from "./RangePicker";
import { TripDatesPicker, type TripDates } from "./TripDatesPicker";

export interface ManualSearch { origin: string; destination: string }
/** Everything about the entry except its price. */
export type ManualFlight = Omit<ManualOfferRequest, "price" | "agent" | "deeplink" | keyof ManualParty>;

const time = (iso: string) => iso.slice(11, 16);
const dayLabel = (iso: string) => {
  const day = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(day.getTime()) ? "" : day.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
};
const DIRECTION_LABEL: Record<Direction, string> = { outbound: "Outbound", inbound: "Return" };
/** A stored trip's dates: the days its first flights leave each way. */
const tripDatesOf = (row: FlightRow): TripDates => ({
  depart: row.depart_date || row.outbound.departure.slice(0, 10),
  ret: row.inbound ? row.return_date || row.inbound.departure.slice(0, 10) : "", roundTrip: Boolean(row.inbound),
});

// -- fields with suggestions ----------------------------------------------------

interface Option { value: string; label?: ReactNode; hint?: string }

/** An input whose dropdown offers the likeliest values; typing stays free. */
function SuggestInput({ label, value, onChange, options, className, type = "text", placeholder, onPaste, uppercase, footer }: {
  label: string; value: string; onChange: (next: string) => void; options: Option[]; className?: string;
  type?: "text" | "date" | "time"; placeholder?: string; uppercase?: boolean; footer?: ReactNode;
  onPaste?: (text: string) => boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const shown = options.filter((option) => option.value !== value);
  const pick = (option: Option) => { onChange(option.value); setOpen(false); setActive(-1); };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!open || !shown.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((at) => event.key === "ArrowDown" ? (at + 1) % shown.length : at <= 0 ? shown.length - 1 : at - 1);
    } else if (event.key === "Enter" && active >= 0) {
      event.preventDefault();
      pick(shown[active]!);
    } else if (event.key === "Escape") {
      // Closes the list, not the dialog around it.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };
  return <label className={`manual-field ${className ?? ""}`}>
    <span>{label}</span>
    <input type={type} value={value} placeholder={placeholder} autoComplete="off" spellCheck={false}
      role="combobox" aria-expanded={open && shown.length > 0} aria-controls={id} aria-autocomplete="list"
      aria-activedescendant={active >= 0 ? `${id}-${active}` : undefined}
      onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onKeyDown={onKeyDown}
      onChange={(event) => { onChange(uppercase ? event.target.value.toUpperCase() : event.target.value); setOpen(true); setActive(-1); }}
      onPaste={onPaste ? (event) => { if (onPaste(event.clipboardData.getData("text"))) event.preventDefault(); } : undefined} />
    {open && (shown.length > 0 || footer) && <ul className="manual-field-options" id={id} role="listbox" aria-label={`${label} suggestions`}>
      {shown.map((option, index) => <li key={option.value} id={`${id}-${index}`} role="option" aria-selected={index === active}
        onMouseEnter={() => setActive(index)} onMouseDown={(event) => { event.preventDefault(); pick(option); }}>
        <b>{option.label ?? option.value}</b>{option.hint && <span>{option.hint}</span>}
      </li>)}
      {footer}
    </ul>}
  </label>;
}

const stored = (options: FieldOption[], describe?: (option: FieldOption) => string): Option[] =>
  options.map((option) => ({ value: option.value,
    hint: [describe ? describe(option) : option.hint, `${option.count} in your list`].filter(Boolean).join(" · ") }));

// -- the builder ------------------------------------------------------------------

function LegForm({ draft, onChange, rows, building, api, editing, onAdd, onCancel, problem }: {
  draft: FlightDraft; onChange: (next: FlightDraft) => void; rows: readonly FlightRow[]; building: Building;
  api: FlightScraperApi | null; editing: boolean; onAdd: () => void; onCancel: () => void; problem: string;
}) {
  const [place, setPlace] = useState<"from" | "to" | null>(null);
  const options = (field: DraftField) => fieldOptions(rows, building, field);
  const airports = (field: "origin" | "destination") => options(field)
    .map((option) => ({ code: option.value, note: `${option.hint} · ${option.count} in your list` }));
  // Times and flight time decide the landing day, so changing one works it out again.
  const set = (field: Partial<FlightDraft>) => onChange({ ...draft, ...field,
    ...("departs" in field || "arrives" in field || "duration" in field ? { arrivesAfter: null } : {}) });
  const guess = clockMinutes(draft);
  const later = draft.arrives ? arrivalOffset(draft) : 0;
  return <div className="manual-leg-form">
    <SuggestInput label="Flight number" className="manual-number" value={draft.flight_number} uppercase placeholder="FR146"
      options={stored(options("flight_number"))} onChange={(flight_number) => set({ flight_number })}
      onPaste={(text) => { const parsed = parseFlightLine(text); if (parsed) set(parsed); return Boolean(parsed); }} />
    {/* The search bar's own place picker: any city, airport or code, with airports in your list first. */}
    <div className="manual-field manual-airport">
      <PlaceInput label="From" value={draft.origin} api={api} onChange={(origin) => set({ origin })}
        open={place === "from"} onToggle={(open) => setPlace(open ? "from" : null)}
        suggested={airports("origin")} suggestedCaption="In your list" />
    </div>
    <div className="manual-field manual-airport">
      <PlaceInput label="To" value={draft.destination} api={api} onChange={(destination) => set({ destination })}
        open={place === "to"} onToggle={(open) => setPlace(open ? "to" : null)}
        suggested={airports("destination")} suggestedCaption="In your list" />
    </div>
    <SuggestInput label="Leaves" type="time" className="manual-time" value={draft.departs}
      options={stored(options("departs"))} onChange={(departs) => set({ departs })} />
    <SuggestInput label={later ? `Lands · +${later} day${later === 1 ? "" : "s"}` : "Lands"} type="time" className="manual-time"
      value={draft.arrives} options={stored(options("arrives"))} onChange={(arrives) => set({ arrives })} />
    <SuggestInput label="Flight time" className="manual-duration" value={draft.duration}
      placeholder={guess ? `${elapsed(guess)} by the clock` : "2h 05m"}
      options={stored(options("duration"))} onChange={(duration) => set({ duration })} />
    <div className="manual-leg-form-actions">
      {problem && <p role="alert" className="detail-booking-error">{problem}</p>}
      {editing && <button type="button" onClick={onCancel}>Cancel</button>}
      <button type="button" className="primary" onClick={onAdd}><Icon name={editing ? "done" : "plus"} />{editing ? "Save flight" : "Add flight"}</button>
    </div>
  </div>;
}

function AddedLegs({ drafts, editing, onEdit, onRemove }: {
  drafts: FlightDraft[]; editing: number | null; onEdit: (index: number) => void; onRemove: (index: number) => void;
}) {
  if (!drafts.length) return null;
  return <ol className="manual-added">
    {drafts.map((draft, index) => {
      const before = drafts[index - 1];
      const wait = before ? (Date.parse(`${draft.date}T${draft.departs}:00Z`) - Date.parse(`${arrivalStamp(before)}:00Z`)) / 60_000 : null;
      return <li key={index} data-editing={editing === index || undefined}>
        {wait !== null && <span className="manual-added-wait">{before!.destination === draft.origin
          ? `Connect in ${draft.origin}` : `Change airports ${before!.destination} → ${draft.origin}`} · {Number.isFinite(wait) ? elapsed(wait) : "–"}</span>}
        <span className="manual-added-row">
          <b>{draft.flight_number || "Flight"}</b>
          <span>{dayLabel(draft.date)} · {draft.departs} {draft.origin} → {draft.arrives} {draft.destination}</span>
          <button type="button" className="detail-icon-button" aria-label={`Edit flight ${index + 1}`} title="Edit"
            onClick={() => onEdit(index)}><Icon name="edit" /></button>
          <button type="button" className="detail-icon-button" aria-label={`Remove flight ${index + 1}`} title="Remove"
            onClick={() => onRemove(index)}><Icon name="trash" /></button>
        </span>
      </li>;
    })}
  </ol>;
}

/** The trip so far, drawn like a row of the list. The flight being typed shows once it is complete. */
function TripPreview({ outbound, inbound }: { outbound: Leg | null; inbound: Leg | null }) {
  const timelines = useMemo(() => flightTimelines([{ outbound, inbound } as FlightRow]), [outbound, inbound]);
  if (!outbound && !inbound) return <p className="manual-preview-empty">Your trip appears here as you add flights.</p>;
  return <div className="trip manual-preview" aria-label="Your trip so far">
    {outbound && <FlightTimeline label="Outbound" leg={outbound} scale={null} timing={timelines.journeys.get(outbound)} mode="days" />}
    {inbound && <FlightTimeline label="Return" leg={inbound} scale={null} timing={timelines.journeys.get(inbound)} mode="days" />}
  </div>;
}

// -- the suggestions --------------------------------------------------------------

function SegmentLine({ segment }: { segment: Segment }) {
  return <span className="manual-segment">
    <b>{segment.flight_number}</b> {time(segment.departure)} {segment.origin} → {time(segment.arrival)} {segment.destination}
  </span>;
}

function LegLine({ leg, label }: { leg: Leg; label: string }) {
  const stops = leg.stops === 0 ? "Nonstop" : leg.stops == null ? "" : `${leg.stops} stop${leg.stops === 1 ? "" : "s"}`;
  return <span className="manual-leg">
    <span className="manual-leg-label">{label}</span>
    <span>{dayLabel(leg.departure)} · <b>{time(leg.departure)}</b> {leg.origin_airport} → <b>{time(leg.arrival)}</b> {leg.destination_airport}</span>
    <span className="manual-leg-meta">{[leg.flight_numbers.replace(/,/g, ", "), stops, leg.duration].filter(Boolean).join(" · ")}</span>
  </span>;
}

function ItineraryChoice({ row, onPick, action = "Use" }: { row: FlightRow; onPick: () => void; action?: string }) {
  const { money } = useCurrency();
  return <button type="button" className="manual-choice" onClick={onPick}>
    <span className="manual-choice-legs">
      <LegLine leg={row.outbound} label="Out" />
      {row.inbound && <LegLine leg={row.inbound} label="Back" />}
    </span>
    <span className="manual-choice-price">{money(row.best?.price_base)}<span>{action}</span></span>
  </button>;
}

function Suggestions({ itineraries, legs, direction, onPickRow, onUseLeg }: {
  itineraries: FlightRow[]; legs: LegSuggestion[]; direction: Direction;
  onPickRow: (row: FlightRow) => void; onUseLeg: (segment: Segment) => void;
}) {
  const [tab, setTab] = useState<"itineraries" | "legs">("itineraries");
  const [leg, setLeg] = useState<string | null>(null);
  const opened = legs.find((option) => option.key === leg) ?? null;
  return <aside className="manual-suggestions" aria-label="Suggestions from your list">
    <div className="manual-suggestions-head">
      <h3>In your list</h3>
      <div className="manual-tabs" role="tablist" aria-label="Suggestions">
        <button type="button" role="tab" aria-selected={tab === "itineraries"} onClick={() => { setTab("itineraries"); setLeg(null); }}>
          Trips<span>{itineraries.length}</span></button>
        <button type="button" role="tab" aria-selected={tab === "legs"} onClick={() => setTab("legs")}>
          {DIRECTION_LABEL[direction]} flights<span>{legs.length}</span></button>
      </div>
    </div>
    <div className="manual-suggestions-body">
      {tab === "itineraries" ? <>
        {itineraries.map((row) => <ItineraryChoice key={row.trip_key} row={row} onPick={() => onPickRow(row)} />)}
        {!itineraries.length && <p className="manual-empty">No stored trip fits what you have entered. Add the flights yourself.</p>}
      </> : opened ? <>
        <button type="button" className="manual-switch back" onClick={() => setLeg(null)}><Icon name="chevron-left" />All flights</button>
        <div className="manual-opened-leg">
          <SegmentLine segment={opened.segment} />
          <button type="button" className="primary" onClick={() => onUseLeg(opened.segment)}>Use this flight</button>
        </div>
        <p className="manual-caption">Trips with this flight</p>
        {opened.rows.map((row) => <ItineraryChoice key={row.trip_key} row={row} onPick={() => onPickRow(row)} />)}
      </> : <>
        {legs.map((option) => <button type="button" key={option.key} className="manual-leg-choice" onClick={() => setLeg(option.key)}>
          <span><SegmentLine segment={option.segment} /><span className="manual-leg-meta">
            {[dayLabel(option.segment.departure), option.segment.carrier_name, option.next ? "" : "later in a trip"].filter(Boolean).join(" · ")}</span></span>
          <span className="manual-leg-count">{option.rows.length} trip{option.rows.length === 1 ? "" : "s"}<Icon name="chevron-right" /></span>
        </button>)}
        {!legs.length && <p className="manual-empty">No stored flight fits the form.</p>}
      </>}
    </div>
  </aside>;
}

// -- the dialog -------------------------------------------------------------------

export function EditFlightDialog({ onClose, rows, search, party, carriers, api, editing, onReplace }: {
  onClose: () => void;
  /** Every stored flight for the search on screen, from every source. */
  rows: readonly FlightRow[];
  search: ManualSearch; party: ManualParty; carriers: ReadonlyMap<string, string>; api: FlightScraperApi | null;
  /** The flight only you sell being changed; the dialog is open while there is one. */
  editing: FlightRow | null;
  onReplace: (row: FlightRow, flight: ManualFlight) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const open = editing !== null;
  const [dates, setDates] = useState<TripDates>({ depart: "", ret: "", roundTrip: false });
  const [choosingDates, setChoosingDates] = useState(false);
  const roundTrip = dates.roundTrip;
  const [direction, setDirection] = useState<Direction>("outbound");
  const [legs, setLegs] = useState<Record<Direction, FlightDraft[]>>({ outbound: [], inbound: [] });
  const [form, setForm] = useState<FlightDraft>(emptyDraft());
  const [editingLeg, setEditingLeg] = useState<number | null>(null);
  const [formProblem, setFormProblem] = useState("");
  const [problem, setProblem] = useState("");
  const [saving, setSaving] = useState(false);

  /** The form for whatever comes next in a direction. */
  const freshForm = (which: Direction, added: Record<Direction, FlightDraft[]>, trip = dates) => which === "outbound"
    ? nextDraft(added.outbound, { date: trip.depart })
    : nextDraft(added.inbound, { date: trip.ret || arrivalStamp(added.outbound.at(-1) ?? emptyDraft()).slice(0, 10),
      origin: added.outbound.at(-1)?.destination ?? "" });

  // A fresh start every time it opens.
  useEffect(() => {
    if (!editing) return;
    const start = { outbound: legDrafts(editing.outbound), inbound: legDrafts(editing.inbound) };
    const trip = tripDatesOf(editing);
    setLegs(start);
    setDates(trip);
    setChoosingDates(false);
    setStored([]);
    setDirection("outbound");
    setForm(freshForm("outbound", start, trip));
    setEditingLeg(null); setFormProblem(""); setProblem(""); setSaving(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);
  const backdrop = useBackdropDismiss(onClose);

  /** The day each direction starts: the calendar's, or for a return not yet picked, when the outbound lands. */
  const tripDate = (which: Direction, trip = dates, added = legs) => which === "outbound" ? trip.depart
    : trip.ret || arrivalStamp(added.outbound.at(-1) ?? emptyDraft()).slice(0, 10);
  /** Every flight on the day that follows from the trip's dates and the flight before it. */
  const redate = (added: Record<Direction, FlightDraft[]>, trip = dates) => ({
    outbound: datedLegs(added.outbound, tripDate("outbound", trip, added)),
    inbound: datedLegs(added.inbound, tripDate("inbound", trip, added)),
  });
  // The form's day is never typed: it follows from the flight before it.
  const before = editingLeg !== null ? legs[direction][editingLeg - 1] : legs[direction].at(-1);
  const dated = useMemo(() => ({ ...form, date: departureDay(before, form.departs, tripDate(direction)) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [form, before, direction, dates, legs]);
  const building: Building = { ...legs, roundTrip, direction, form: dated };
  // The whole database, asked as the form changes; the list on screen answers at once meanwhile.
  const [stored, setStored] = useState<FlightRow[]>([]);
  const lookup = JSON.stringify([form.flight_number.trim(), form.origin.trim(), form.destination.trim(), dated.date, roundTrip]);
  useEffect(() => {
    if (!open || !api) return;
    const airports = [form.origin, form.destination].map((code) => code.trim().toUpperCase()).filter((code) => /^[A-Z]{3}$/.test(code));
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api.findTrips({ number: form.flight_number.trim(), airports, day: dated.date, roundTrip, ...party }, controller.signal)
        .then((answer) => setStored(answer.results))
        .catch(() => { /* the list on screen still suggests */ });
    }, 250);
    return () => { controller.abort(); window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, api, lookup, party]);
  const others = useMemo(() => {
    const byKey = new Map<string, FlightRow>();
    for (const row of [...rows, ...stored]) if (!byKey.has(row.trip_key)) byKey.set(row.trip_key, row);
    if (editing) byKey.delete(editing.trip_key);
    return [...byKey.values()];
  }, [rows, stored, editing]);
  const itineraries = useMemo(() => itinerarySuggestions(others, building),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [others, legs, roundTrip, direction, dated]);
  const legOptions = useMemo(() => legSuggestions(others, building),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [others, legs, roundTrip, direction, dated]);

  // The trip as it stands, with the flight in the form drawn once it is complete.
  const preview = (which: Direction) => {
    const added = legs[which];
    const withForm = which === direction && draftProblem(dated, "") === null
      ? editingLeg !== null ? added.map((draft, index) => index === editingLeg ? dated : draft) : [...added, dated] : added;
    return draftLeg(datedLegs(withForm, tripDate(which)), carriers);
  };
  const outboundLeg = useMemo(() => preview("outbound"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [legs, dated, direction, editingLeg, carriers, dates]);
  const inboundLeg = useMemo(() => roundTrip ? preview("inbound") : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [legs, dated, direction, editingLeg, carriers, roundTrip, dates]);

  const finalLegs = { outbound: legs.outbound, inbound: roundTrip ? legs.inbound : [] };

  const switchTo = (which: Direction) => {
    setDirection(which);
    setEditingLeg(null);
    setFormProblem("");
    setForm(freshForm(which, legs));
  };
  const addLeg = () => {
    const issue = draftProblem(dated, "This flight");
    if (issue) { setFormProblem(issue); return; }
    const added = legs[direction];
    const list = editingLeg !== null ? added.map((draft, index) => index === editingLeg ? dated : draft) : [...added, dated];
    const next = redate({ ...legs, [direction]: list });
    setLegs(next);
    setEditingLeg(null);
    setFormProblem("");
    setForm(freshForm(direction, next));
  };
  const fillFrom = (row: FlightRow) => {
    const next = { outbound: legDrafts(row.outbound), inbound: legDrafts(row.inbound) };
    const trip = tripDatesOf(row);
    const which = direction === "inbound" && !row.inbound ? "outbound" : direction;
    setLegs(next);
    setDates(trip);
    setEditingLeg(null);
    setFormProblem("");
    setProblem("");
    setDirection(which);
    setForm(freshForm(which, next, trip));
  };
  /** New trip dates: every flight added so far moves to the days that follow from them. */
  const changeDates = (trip: TripDates) => {
    const next = redate(legs, trip);
    const which = direction === "inbound" && !trip.roundTrip ? "outbound" : direction;
    setLegs(next);
    setDates(trip);
    if (which !== direction) {
      setDirection(which);
      setEditingLeg(null);
      setForm(freshForm(which, next, trip));
    }
  };

  const typedFlight = (): ManualFlight => ({
    origin: search.origin, destination: search.destination,
    outbound: finalLegs.outbound.map((draft) => segmentPayload(draft, carriers)),
    inbound: finalLegs.inbound.map((draft) => segmentPayload(draft, carriers)),
  });
  const ready = () => {
    const pending = typed(dated) && editingLeg === null ? "Add the flight in the form, or clear it, first." : "";
    const issue = pending || (!finalLegs.outbound.length ? "Add at least one outbound flight."
      : roundTrip && !finalLegs.inbound.length ? "Add the return flights, or make the trip one way in Trip dates." : "");
    setProblem(issue);
    return !issue;
  };

  const title = "Edit flight";
  return <dialog ref={dialog} className="manual-dialog" aria-label={title}
    onClose={onClose} onCancel={(event) => { event.preventDefault(); onClose(); }} {...backdrop}>
    {editing && <div className="manual-dialog-body">
      <header className="manual-dialog-head">
        <h2>{title}</h2>
        <button type="button" className="detail-icon-button" aria-label="Close" onClick={onClose}><Icon name="cancel" /></button>
      </header>

      <div className="manual-layout">
        <section className="manual-builder" aria-label="Your trip">
          <div className="manual-trip-dates">
            <TripDatesPicker dates={dates} min={todayISO()} open={choosingDates} onToggle={setChoosingDates} onChange={changeDates} />
          </div>
          <div className="manual-direction" role="tablist" aria-label="Which way you are adding flights for">
            {(["outbound", "inbound"] as const).map((which) => {
              const day = which === "outbound" ? dates.depart : dates.ret;
              const count = legs[which].length;
              return <button key={which} type="button" role="tab" aria-selected={direction === which}
                disabled={which === "inbound" && !roundTrip}
                title={which === "inbound" && !roundTrip ? "A one-way trip. Make it a round trip in Trip dates." : undefined}
                onClick={() => switchTo(which)}>
                <b>{DIRECTION_LABEL[which]}</b>
                <span>{which === "inbound" && !roundTrip ? "One way" : day ? dayLabel(day) : "Pick a date"}</span>
                <span className="manual-direction-count">{count ? `${count} flight${count === 1 ? "" : "s"}` : "No flights yet"}</span>
              </button>;
            })}
          </div>
          <AddedLegs drafts={legs[direction]} editing={editingLeg}
            onEdit={(index) => { setEditingLeg(index); setFormProblem(""); setForm(legs[direction][index]!); }}
            onRemove={(index) => {
              const next = redate({ ...legs, [direction]: legs[direction].filter((_, at) => at !== index) });
              setLegs(next);
              if (editingLeg !== null) { setEditingLeg(null); setForm(freshForm(direction, next)); }
            }} />
          <p className="manual-caption">{editingLeg !== null ? `Editing ${DIRECTION_LABEL[direction].toLowerCase()} flight ${editingLeg + 1}`
            : legs[direction].length ? `Next ${DIRECTION_LABEL[direction].toLowerCase()} flight, if it has a connection`
            : `First ${DIRECTION_LABEL[direction].toLowerCase()} flight`}</p>
          <LegForm draft={dated} onChange={(next) => { setForm(next); setFormProblem(""); setProblem(""); }} rows={others}
            building={building} api={api} editing={editingLeg !== null} problem={formProblem} onAdd={addLeg}
            onCancel={() => { setEditingLeg(null); setForm(freshForm(direction, legs)); }} />
          <p className="manual-note">Times are local at each airport. Paste a line like “FR146 BER 16:40 → STN 17:45” into Flight number to fill the form. Without a flight time it is guessed from the clock, which is only right within one time zone.</p>
          <TripPreview outbound={outboundLeg} inbound={inboundLeg} />
          {problem && <p role="alert" className="detail-booking-error">{problem}</p>}
          <div className="detail-price-actions manual-dialog-actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="button" className="primary" disabled={saving} onClick={async () => {
              if (!ready()) return;
              setSaving(true);
              try { await onReplace(editing, typedFlight()); onClose(); }
              catch (reason) { setProblem(reason instanceof Error ? reason.message : "The flight could not be saved."); }
              finally { setSaving(false); }
            }}>{saving ? "Saving…" : "Save flight"}</button>
          </div>
        </section>
        <Suggestions key={direction} itineraries={itineraries} legs={legOptions} direction={direction}
          onPickRow={fillFrom} onUseLeg={(segment) => { setForm(segmentDraft(segment)); setFormProblem(""); }} />
      </div>
    </div>}
  </dialog>;
}

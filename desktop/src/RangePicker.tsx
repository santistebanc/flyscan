/**
 * A range of dates, picked on a calendar drawn like the rest of the app.
 *
 * Used twice, and the second use is the reason it exists: departures are a
 * range and returns are a *separate* range. A search over 23–25 out and 24–25
 * back is not one span — it is five trips, every departure day priced against
 * every return day that is not before it, each one its own question to every
 * source.
 *
 * So this control knows nothing about outbound or inbound. It is one range,
 * with an optional empty state for the return leg of a one-way.
 *
 * Every date is handled as a `YYYY-MM-DD` string and every Date is built at
 * local noon. Midnight and UTC are how a picker ends up a day out.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { SearchSegment, useDismiss, useKeepInView } from "./Popover";

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
type RelatedRange = { from: string; to: string; label: string };

/** A day as the rest of the app spells it, from a Date. Never via UTC. */
function key(day: Date): string {
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}`
    + `-${String(day.getDate()).padStart(2, "0")}`;
}

const at = (iso: string) => new Date(`${iso}T12:00:00`);

export function initialCalendarView(from: string, to: string, min: string, selectionSide: "left" | "right" = "left") {
  const showOnRight = selectionSide === "right" && Boolean(from || to);
  const cursor = selectionSide === "right" ? (to || from || min) : (from || min);
  const selected = at(cursor);
  const first = new Date(selected.getFullYear(), selected.getMonth() - (showOnRight ? 1 : 0), 1, 12);
  return { cursor, month: { year: first.getFullYear(), month: first.getMonth() } };
}

const shift = (iso: string, days: number) => {
  const day = at(iso);
  day.setDate(day.getDate() + days);
  return key(day);
};

export const todayISO = () => key(new Date());

/** "Sep 6", and "Sep 6 2027" once it is not this year any more. */
export function readable(iso: string): string {
  if (!iso) return "";
  const day = at(iso);
  const sameYear = day.getFullYear() === new Date().getFullYear();
  return day.toLocaleDateString(undefined, {
    month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** "Nov 20", or "Nov 20 – 22" — the second month named only when it differs. */
export function readableRange(from: string, to: string): string {
  if (!from) return "";
  if (!to || to === from) return readable(from);
  const sameMonth = from.slice(0, 7) === to.slice(0, 7);
  return `${readable(from)} – ${sameMonth ? at(to).getDate() : readable(to)}`;
}

export const daysBetween = (from: string, to: string) =>
  Math.round((at(to).getTime() - at(from).getTime()) / 86_400_000);

/**
 * The cells of one month, Monday first, padded to six rows.
 *
 * Fixed height on purpose: a month needing five rows and one needing six would
 * otherwise resize the popup as you paged through them.
 */
function monthCells(year: number, month: number): (string | null)[] {
  const first = new Date(year, month, 1, 12);
  const lead = (first.getDay() + 6) % 7;          // Sunday is 0; we start Monday
  const days = new Date(year, month + 1, 0, 12).getDate();

  const cells: (string | null)[] = Array(lead).fill(null);
  for (let day = 1; day <= days; day++) cells.push(key(new Date(year, month, day, 12)));
  while (cells.length < 42) cells.push(null);
  return cells;
}

export function Month(
  { year, month, from, to, hover, drawing, cursor, min, relatedRange, nav, onPick, onHover }:
  {
    year: number; month: number;
    from: string; to: string;
    /** The day under the pointer, which previews the range being drawn. */
    hover: string; drawing: boolean; cursor: string; min: string;
    relatedRange?: RelatedRange;
    /** The paging arrow beside this month's title. */
    nav: { label: string; icon: "chevron-left" | "chevron-right"; onClick: () => void };
    onPick: (day: string) => void;
    onHover: (day: string) => void;
  },
) {
  const cells = monthCells(year, month);
  const title = new Date(year, month, 1, 12)
    .toLocaleDateString(undefined, { month: "long", year: "numeric" });

  // While the far end is being chosen, the day under the pointer stands in for
  // it, so the shading follows the pointer.
  const end = drawing && hover && hover > from ? hover : to;
  const now = todayISO();
  const relatedEnd = relatedRange?.to || relatedRange?.from;
  const page = <button type="button" className="cal-page" onClick={nav.onClick} aria-label={nav.label}>
    <Icon name={nav.icon} /></button>;

  return (
    <div className="cal-month">
      <div className="cal-title">
        {nav.icon === "chevron-left" && page}<span>{title}</span>{nav.icon === "chevron-right" && page}
      </div>
      <div className="cal-week">
        {WEEKDAYS.map((day) => <span key={day}>{day}</span>)}
      </div>
      <div className="cal-grid">
        {cells.map((day, index) => {
          if (!day) return <span key={index} className="cal-day blank" />;

          const past = day < min;
          const isFrom = Boolean(from) && day === from;
          const isTo = Boolean(end) && day === end;
          const band = Boolean(from && end) && from !== end && day >= from && day <= end;
          const related = Boolean(relatedRange?.from && day >= relatedRange.from && day <= relatedEnd!);
          const column = index % 7;
          // The band and the underline are drawn per cell; these say where each
          // one starts and stops so the ends round off at the right place.
          const rowStart = column === 0 || !cells[index - 1];
          const rowEnd = column === 6 || !cells[index + 1];

          const classes = ["cal-day"];
          if (past) classes.push("past");
          if (isFrom || isTo) classes.push("edge");
          if (band) classes.push("inside");
          if (band && (day === from || rowStart)) classes.push("band-start");
          if (band && (day === end || rowEnd)) classes.push("band-end");
          if (day === now) classes.push("today");
          if (day === cursor) classes.push("cursor");
          if (related) classes.push("related");
          if (related && day === relatedRange?.from) classes.push("related-start");
          if (related && day === relatedEnd) classes.push("related-end");

          return (
            <button
              key={day}
              type="button"
              className={classes.join(" ")}
              disabled={past}
              tabIndex={-1}
              aria-pressed={isFrom || isTo}
              aria-label={`${readable(day)}${related ? `, ${relatedRange!.label} range` : ""}`}
              data-date={day}
              onClick={() => onPick(day)}
              onMouseEnter={() => onHover(day)}
            >
              <span>{at(day).getDate()}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function RangePicker(
  { label, from, to, min, optional, empty, relatedRange, selectionSide = "left", open, onToggle, onChange }:
  {
    label: string;
    from: string;
    /** The last day of the range. Equal to `from` for a single day. */
    to: string;
    /** Nothing before this can be picked. */
    min: string;
    /** True for the return leg, which is allowed to be nothing at all. */
    optional?: boolean;
    /** What the trigger says when the range is empty. */
    empty?: string;
    relatedRange?: RelatedRange;
    /** Which month contains the selection on opening; empty ranges put `min` on the left. */
    selectionSide?: "left" | "right";
    open: boolean;
    onToggle: (open: boolean) => void;
    onChange: (from: string, to: string) => void;
  },
) {
  /** True once one end is down and the other is being chosen. */
  const [drawing, setDrawing] = useState(false);
  const [hover, setHover] = useState("");
  const openingView = initialCalendarView(from, to, min, selectionSide);
  const [cursor, setCursor] = useState(openingView.cursor);
  const [month, setMonth] = useState(openingView.month);

  const box = useRef<HTMLDivElement | null>(null);
  const popup = useRef<HTMLDivElement | null>(null);
  // Anywhere else is "done": there is nothing to confirm, since the range is
  // already applied by the time it is drawn.
  const close = useCallback(() => onToggle(false), [onToggle]);
  useDismiss(open, close, box);
  useKeepInView(open, popup);

  // Each opening starts from the selection, with the keyboard on it.
  useEffect(() => {
    if (!open) return;
    setMonth(openingView.month);
    setCursor(openingView.cursor);
    setDrawing(false);
    popup.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Follow the keyboard, but only when it walks off the two months on screen.
  // Paging on every step would send December away the moment the cursor
  // crossed into it from November, with December already sitting right there.
  useEffect(() => {
    if (!open || !cursor) return;
    const day = at(cursor);
    setMonth((was) => {
      const showing = [was.month, was.month + 1].some((m) => {
        const shown = new Date(was.year, m, 1, 12);
        return shown.getFullYear() === day.getFullYear()
          && shown.getMonth() === day.getMonth();
      });
      return showing ? was : { year: day.getFullYear(), month: day.getMonth() };
    });
  }, [cursor, open]);

  const step = (days: number) => setCursor((was) => {
    const next = shift(was || min, days);
    return next < min ? min : next;
  });

  const pick = (day: string) => {
    if (!drawing || !from || day < from) {
      // A single day is a range of one — a search of exactly that date. The
      // second click is what widens it.
      onChange(day, day);
      setDrawing(true);
    } else {
      onChange(from, day);
      setDrawing(false);
    }
    setCursor(day);
  };

  const span = from && to ? daysBetween(from, to) + 1 : 0;
  const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
  const note = drawing ? "Pick the last day of the range"
    : span ? `${days(span)} · click a day to start a new range` : "Pick a day";

  const next = { year: month.month === 11 ? month.year + 1 : month.year,
                 month: (month.month + 1) % 12 };
  // From whatever month is showing *now*: two quick presses of ‹ are two
  // months, not one twice over.
  const page = (by: number) => setMonth((was) => {
    const to = new Date(was.year, was.month + by, 1, 12);
    return { year: to.getFullYear(), month: to.getMonth() };
  });

  return (
    <SearchSegment label={label} value={from ? readableRange(from, to) : (empty ?? "Any")}
      hint={span ? days(span) : undefined} open={open} root={box} onToggle={() => onToggle(!open)}>
      <div
        className={`popover cal-popup${selectionSide === "right" ? " align-right" : ""}`}
        ref={popup}
        tabIndex={-1}
        role="dialog"
        aria-label={`Choose ${label}`}
        // Stops here rather than reaching the window, where ↑ and ↓ walk the
        // list of flights.
        onKeyDown={(event) => {
          const keys: Record<string, number> = {
            ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7,
            PageUp: -30, PageDown: 30,
          };
          if (event.key in keys) {
            event.preventDefault();
            event.stopPropagation();
            step(keys[event.key]!);
          } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            pick(cursor);
          }
        }}
      >
        <div className="cal-months" onMouseLeave={() => setHover("")}>
          <Month
            {...{ from, to, min, drawing, cursor, hover, relatedRange }}
            year={month.year} month={month.month}
            nav={{ label: "Earlier", icon: "chevron-left", onClick: () => page(-1) }}
            onPick={pick} onHover={setHover}
          />
          <Month
            {...{ from, to, min, drawing, cursor, hover, relatedRange }}
            year={next.year} month={next.month}
            nav={{ label: "Later", icon: "chevron-right", onClick: () => page(1) }}
            onPick={pick} onHover={setHover}
          />
        </div>

        <div className="cal-foot">
          {relatedRange?.from && <span className="cal-related-legend"><i aria-hidden="true" />
            {relatedRange.label} range</span>}
          <span className="cal-note">{note}</span>
          {optional && (
            <button type="button" className="cal-plain"
              onClick={() => { onChange("", ""); setDrawing(false); close(); }}>
              {empty ?? "Clear"}
            </button>
          )}
          <button type="button" className="cal-plain" onClick={close}>Done</button>
        </div>
      </div>
    </SearchSegment>
  );
}

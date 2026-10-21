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

import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
type RelatedRange = { from: string; to: string; label: string };

/** A day as the rest of the app spells it, from a Date. Never via UTC. */
function key(day: Date): string {
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}`
    + `-${String(day.getDate()).padStart(2, "0")}`;
}

const at = (iso: string) => new Date(`${iso}T12:00:00`);

const shift = (iso: string, days: number) => {
  const day = at(iso);
  day.setDate(day.getDate() + days);
  return key(day);
};

export const todayISO = () => key(new Date());

/** "Sep 6", and "Sep 6 2027" once it is not this year any more. */
function readable(iso: string): string {
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

function Month(
  { year, month, from, to, hover, drawing, cursor, min, relatedRange, onPick, onHover }:
  {
    year: number; month: number;
    from: string; to: string;
    /** The day under the pointer, which previews the range being drawn. */
    hover: string; drawing: boolean; cursor: string; min: string;
    relatedRange?: RelatedRange;
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

  return (
    <div className="cal-month">
      <div className="cal-title">{title}</div>
      <div className="cal-week">
        {WEEKDAYS.map((day) => <span key={day}>{day}</span>)}
      </div>
      <div className="cal-grid">
        {cells.map((day, index) => {
          if (!day) return <span key={index} className="cal-day blank" />;

          const past = day < min;
          const isFrom = Boolean(from) && day === from;
          const isTo = Boolean(end) && day === end;
          const inside = Boolean(from && end) && day > from && day < end;
          const related = Boolean(relatedRange?.from && day >= relatedRange.from && day <= (relatedRange.to || relatedRange.from));

          const classes = ["cal-day"];
          if (past) classes.push("past");
          if (isFrom || isTo) classes.push("edge");
          if (inside) classes.push("inside");
          if (day === now) classes.push("today");
          if (day === cursor) classes.push("cursor");
          if (related) classes.push("related");
          if (related && (day === relatedRange?.from || day === relatedRange?.to)) classes.push("related-edge");

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
              {at(day).getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function RangePicker(
  { label, from, to, min, optional, empty, hint, relatedRange, onChange }:
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
    /** A word on what this range costs, shown in the footer. */
    hint?: string;
    relatedRange?: RelatedRange;
    onChange: (from: string, to: string) => void;
  },
) {
  const [open, setOpen] = useState(false);
  /** True once one end is down and the other is being chosen. */
  const [drawing, setDrawing] = useState(false);
  const [hover, setHover] = useState("");
  const [cursor, setCursor] = useState(from || min);
  const [month, setMonth] = useState(() => {
    const start = at(from || min);
    return { year: start.getFullYear(), month: start.getMonth() };
  });

  const box = useRef<HTMLDivElement | null>(null);
  const popup = useRef<HTMLDivElement | null>(null);
  /** Hung from the right edge instead, when hanging left would run off screen. */
  const [flip, setFlip] = useState(false);

  // Opening lands on the range being edited rather than wherever it was left.
  useEffect(() => {
    if (!open) return;
    const start = at(from || min);
    setMonth({ year: start.getFullYear(), month: start.getMonth() });
    setCursor(from || min);
    setDrawing(false);
    popup.current?.focus();

    // Two months is wider than the field it hangs from, and the second of
    // these controls sits well to the right. Measure once it is up, and hang
    // it from the other edge if it would otherwise leave the window.
    const edge = popup.current?.getBoundingClientRect();
    setFlip(Boolean(edge) && edge!.right > document.documentElement.clientWidth - 6);
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

  // Anywhere else is "done": there is nothing to confirm, since the range is
  // already applied by the time it is drawn.
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

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
      setOpen(false);
    }
    setCursor(day);
  };

  const span = from && to ? daysBetween(from, to) + 1 : 0;
  const trigger = from ? readableRange(from, to) : (empty ?? "any");

  const next = { year: month.month === 11 ? month.year + 1 : month.year,
                 month: (month.month + 1) % 12 };
  // From whatever month is showing *now*: two quick presses of ‹ are two
  // months, not one twice over.
  const page = (by: number) => setMonth((was) => {
    const to = new Date(was.year, was.month + by, 1, 12);
    return { year: to.getFullYear(), month: to.getMonth() };
  });

  return (
    <div className="daterange" ref={box}>
      <label>
        {label}
        <button
          type="button"
          className={open ? "cal-trigger open" : "cal-trigger"}
          aria-expanded={open}
          onClick={() => setOpen((was) => !was)}
        >
          <span className={from ? "" : "muted"}>{trigger}</span>
          {span > 1 && <span className="cal-span">{span} days</span>}
        </button>
      </label>

      {open && (
        <div
          className={flip ? "cal-popup flip" : "cal-popup"}
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
            } else if (event.key === "Escape") {
              event.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <div className="cal-nav">
            <button type="button" className="queue-icon-button" onClick={() => page(-1)} aria-label="Earlier"><Icon name="chevron-left" /></button>
            <span className="muted">
              {drawing ? "pick the last day, or the same one again" : `${label}: pick the first day`}
            </span>
            <button type="button" className="queue-icon-button" onClick={() => page(1)} aria-label="Later"><Icon name="chevron-right" /></button>
          </div>

          <div className="cal-months" onMouseLeave={() => setHover("")}>
            <Month
              {...{ from, to, min, drawing, cursor, hover, relatedRange }}
              year={month.year} month={month.month}
              onPick={pick} onHover={setHover}
            />
            <Month
              {...{ from, to, min, drawing, cursor, hover, relatedRange }}
              year={next.year} month={next.month}
              onPick={pick} onHover={setHover}
            />
          </div>

          <div className="cal-foot">
            {relatedRange?.from && <span className="cal-related-legend"><i aria-hidden="true" />
              {relatedRange.label}: {readableRange(relatedRange.from, relatedRange.to)}</span>}
            {optional && (
              <button
                type="button"
                className="cal-plain"
                onClick={() => { onChange("", ""); setDrawing(false); setOpen(false); }}
              >
                {empty ?? "Clear"}
              </button>
            )}
            <span className="muted">{hint ?? (span > 1 ? `${span} days` : "")}</span>
          </div>
        </div>
      )}
    </div>
  );
}

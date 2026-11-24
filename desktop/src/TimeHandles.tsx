import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ANY_ARRIVAL, formatArrival, formatClock, withTimeBound, type DirectionTimes, type TimeWindow } from "./flightFilters";
import { timeWindowSpans, percent, timeFilterAxis, type JourneyTiming, type TimelineScale } from "./flightTimeline";

export type TimesPatch = Partial<DirectionTimes>;
/** The part of the timeline in sight, as percentages of its width. */
export type View = { from: number; to: number };
const STEP = 15;
const RANGES = [
  { kind: "depart", name: "departure", verb: "Depart", max: 1440, format: formatClock },
  { kind: "arrive", name: "arrival", verb: "Arrive", max: ANY_ARRIVAL, format: formatArrival },
] as const;
type Range = typeof RANGES[number];
type End = keyof TimeWindow;

export function limitAt(end: End, minute: number, base: number, max: number, scale: Pick<TimelineScale, "min" | "max">): number {
  const edge = (scale.max - scale.min) / 100;
  if (end === "from" && minute <= scale.min + edge) return 0;
  if (end === "to" && minute >= scale.max - edge) return max;
  return Math.min(max, Math.max(0, Math.round((minute - base) / STEP) * STEP));
}

/**
 * A handle at `place` against the part of the timeline in sight. The
 * stylesheet holds it at the edge in sight, while that edge is within the
 * `reach` of its limits; this says which edge, so its label reads inwards,
 * and `beyond` when its limit lies past it, out of sight. Scrolled past its
 * reach, it goes by with the timeline.
 */
export function handleAt(place: number, view: View, reach: View = { from: 0, to: 100 }): { edge?: "start" | "end"; beyond: boolean } {
  if (view.from >= reach.to || view.to <= reach.from) return { beyond: false };
  if (place <= view.from) return { edge: "start", beyond: place < view.from };
  if (place >= view.to) return { edge: "end", beyond: place > view.to };
  return { beyond: false };
}

export function TimeHandles({ timing, scale, times, title, view = { from: 0, to: 100 }, onChange }: {
  timing: JourneyTiming; scale: TimelineScale; times: DirectionTimes; title: string; view?: View;
  onChange: (patch: TimesPatch) => void;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ kind: Range["kind"]; end: End; window: TimeWindow } | null>(null);
  const axis = timeFilterAxis(timing);
  if (!axis) return null;
  const shown = drag ? { ...times, [drag.kind]: drag.window } : times;
  const span = scale.max - scale.min;
  const clamp = (minute: number) => Math.min(100, Math.max(0, percent(minute, scale)));
  const minuteAt = (clientX: number) => {
    const box = layer.current!.getBoundingClientRect();
    return scale.min + Math.min(1, Math.max(0, (clientX - box.left) / box.width)) * span;
  };

  const position = (value: number, open: number, edge: number, base: number) =>
    value === open ? edge : clamp(base + value);

  const renderHandle = ({ kind, name, verb, max, format }: Range, end: End) => {
    const window = shown[kind];
    const open = end === "from" ? 0 : max;
    const value = window[end];
    const active = value !== open;
    const dragging = drag?.kind === kind && drag.end === end;
    const minimum = end === "from" ? 0 : window.from;
    const maximum = end === "to" ? max : window.to;
    const place = position(value, open, end === "from" ? 0 : 100, axis[kind]);
    const close = Math.abs(position(window.from, 0, 0, axis[kind]) - position(window.to, max, 100, axis[kind])) < 5;
    const at = handleAt(place, view);
    const otherPlace = end === "from" ? position(window.to, max, 100, axis[kind]) : position(window.from, 0, 0, axis[kind]);
    const sameEdge = at.edge && at.edge === handleAt(otherPlace, view).edge;
    const label = active ? `${verb} ${end === "from" ? "after" : "before"} ${format(value)}`
      : `No ${end === "from" ? "earliest" : "latest"} ${name}`;

    const move = (event: PointerEvent) => {
      if (!dragging) return;
      const next = limitAt(end, minuteAt(event.clientX), axis[kind], max, scale);
      setDrag({ kind, end, window: withTimeBound(times[kind], end, next) });
    };
    const keyDown = (event: KeyboardEvent) => {
      const point = kind === "depart" ? timing.start : timing.parts[timing.parts.length - 1]!.end;
      const start = active ? value : Math.round((point - axis[kind]) / STEP) * STEP;
      const next = event.key === "ArrowLeft" || event.key === "ArrowDown" ? start - STEP
        : event.key === "ArrowRight" || event.key === "ArrowUp" ? start + STEP
        : event.key === "Home" ? minimum : event.key === "End" ? maximum
        : event.key === "Delete" ? open : null;
      if (next === null) return;
      event.preventDefault();
      event.stopPropagation();
      const bounded = Math.min(maximum, Math.max(minimum, next));
      if (bounded !== value) onChange({ [kind]: withTimeBound(times[kind], end, bounded) });
    };

    return <span key={`${kind}-${end}`} className={`time-handle-track ${kind}`} data-close={close || sameEdge || undefined}>
      <span className="time-handle-lead" style={{ width: `${place}%` }} />
      <span className={`time-handle ${end}`} data-active={active || undefined}
        data-edge={at.edge} data-beyond={at.beyond || undefined} data-dragging={dragging || undefined}
        role="slider" tabIndex={0} aria-label={`${title} ${end === "from" ? "earliest" : "latest"} ${name}`}
        aria-valuetext={label} aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={value} title={label}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          setDrag({ kind, end, window: times[kind] });
        }}
        onPointerMove={move}
        onPointerUp={() => {
          if (!dragging) return;
          setDrag(null);
          if (value !== times[kind][end]) onChange({ [kind]: window });
        }}
        onLostPointerCapture={() => setDrag(null)} onKeyDown={keyDown}>
        <span className="time-handle-grip" />
        <span className="time-handle-label" aria-hidden="true">{label}</span>
      </span>
    </span>;
  };

  return <div className="time-handles" ref={layer} data-dragging={drag ? true : undefined}>
    {timeWindowSpans(timing, scale, shown).map(({ start, end, kind, side }) =>
      <span key={`${kind}-${side}`} className={`time-filtered ${kind}`}
        style={{ left: `${percent(start, scale)}%`, width: `${(end - start) / span * 100}%` }} />)}
    {RANGES.map((range) => {
      const { kind, verb, max, format } = range;
      const { from, to } = shown[kind];
      const summary = from > 0 && to < max ? `${format(from)} - ${format(to)}`
        : from > 0 ? `after ${format(from)}` : to < max ? `before ${format(to)}` : "any time";
      return <span key={kind} className={`time-range-summary ${kind}`}>{verb} {summary}</span>;
    })}
    {RANGES.flatMap((range) => [renderHandle(range, "from"), renderHandle(range, "to")])}
  </div>;
}

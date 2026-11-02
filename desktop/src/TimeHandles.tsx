/**
 * Handles at either end of a Trip view timeline for the time filters: drag
 * the left one to depart no earlier, the right one to arrive no later. They
 * set the same limits as the Times filter above the list, and only when let
 * go, so the trips do not change under the finger.
 */
import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ANY_ARRIVAL, type DirectionTimes } from "./flightFilters";
import { filteredOutSpans, percent, timeFilterAxis, type JourneyTiming, type TimelineScale } from "./flightTimeline";

export type TimesPatch = { depart?: number; arrive?: number };
type Which = "depart" | "arrive";
const STEP = 15;

/** "07:30", or "01:15 +1" for a limit on a later day than the departure. */
export function limitClock(minutes: number): string {
  const day = Math.floor(minutes / 1440), within = minutes - day * 1440;
  const clock = `${String(Math.floor(within / 60)).padStart(2, "0")}:${String(within % 60).padStart(2, "0")}`;
  return day > 0 ? `${clock} +${day}` : clock;
}

/**
 * A limit from a place on the timeline, snapped to a quarter hour. The left
 * end means no earliest departure and the right end no latest arrival, so a
 * handle dragged all the way out lifts its limit.
 */
export function limitAt(which: Which, minute: number, base: number, scale: Pick<TimelineScale, "min" | "max">): number {
  const edge = (scale.max - scale.min) / 100;
  if (which === "depart") {
    if (minute <= scale.min + edge) return 0;
    return Math.min(1440, Math.max(0, Math.round((minute - base) / STEP) * STEP));
  }
  if (minute >= scale.max - edge) return ANY_ARRIVAL;
  return Math.min(ANY_ARRIVAL - STEP, Math.max(0, Math.round((minute - base) / STEP) * STEP));
}

export function TimeHandles({ timing, scale, times, title, onChange }: {
  timing: JourneyTiming; scale: TimelineScale; times: DirectionTimes; title: string;
  onChange: (patch: TimesPatch) => void;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ which: Which; value: number } | null>(null);
  const axis = timeFilterAxis(timing);
  if (!axis) return null;
  const value = (which: Which) => drag?.which === which ? drag.value : which === "depart" ? times.depart.from : times.arrive.to;
  const depart = value("depart"), arrive = value("arrive");
  const span = scale.max - scale.min;
  const clamp = (minute: number) => Math.min(100, Math.max(0, percent(minute, scale)));
  const place = (which: Which) => which === "depart"
    ? depart > 0 ? clamp(axis.depart + depart) : 0
    : arrive < ANY_ARRIVAL ? clamp(axis.arrive + arrive) : 100;
  const minuteAt = (clientX: number) => {
    const box = layer.current!.getBoundingClientRect();
    return scale.min + Math.min(1, Math.max(0, (clientX - box.left) / box.width)) * span;
  };
  const base = (which: Which) => which === "depart" ? axis.depart : axis.arrive;
  const label = (which: Which) => which === "depart"
    ? depart > 0 ? `Depart after ${limitClock(depart)}` : "Any departure time"
    : arrive < ANY_ARRIVAL ? `Arrive before ${limitClock(arrive)}` : "Any arrival time";

  const onPointerDown = (which: Which) => (event: PointerEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ which, value: value(which) });
  };
  const onPointerMove = (which: Which) => (event: PointerEvent) => {
    if (drag?.which !== which) return;
    setDrag({ which, value: limitAt(which, minuteAt(event.clientX), base(which), scale) });
  };
  const onPointerUp = (which: Which) => () => {
    if (drag?.which !== which) return;
    setDrag(null);
    if (drag.value !== (which === "depart" ? times.depart.from : times.arrive.to)) onChange({ [which]: drag.value });
  };
  // A quarter hour per arrow press; Home and End lift the limit.
  const onKeyDown = (which: Which) => (event: KeyboardEvent) => {
    const now = which === "depart" ? times.depart.from : times.arrive.to;
    const open = which === "depart" ? 0 : ANY_ARRIVAL;
    // From no limit, the first press starts at the trip's own departure or arrival.
    const from = now !== open ? now : which === "depart"
      ? Math.max(0, Math.round((timing.start - axis.depart) / STEP) * STEP)
      : Math.round((timing.parts[timing.parts.length - 1]!.end - axis.arrive) / STEP) * STEP;
    const next = event.key === "ArrowLeft" ? from - STEP : event.key === "ArrowRight" ? from + STEP
      : event.key === "Home" || event.key === "End" ? open : null;
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    onChange({ [which]: which === "depart" ? Math.min(1440, Math.max(0, next)) : Math.min(ANY_ARRIVAL, Math.max(0, next)) });
  };

  const shaded = filteredOutSpans(timing, scale, depart > 0 ? depart : null, arrive < ANY_ARRIVAL ? arrive : null);
  return <div className="time-handles" ref={layer} data-dragging={drag ? true : undefined}>
    {shaded.map(({ start, end, side }) => <span key={side} className="time-filtered"
      style={{ left: `${percent(start, scale)}%`, width: `${(end - start) / span * 100}%` }} />)}
    {(["depart", "arrive"] as const).map((which) => {
      const active = which === "depart" ? depart > 0 : arrive < ANY_ARRIVAL;
      return <span key={which} className={`time-handle ${which}`} data-active={active || undefined}
        data-dragging={drag?.which === which || undefined} style={{ left: `${place(which)}%` }}
        role="slider" tabIndex={0} aria-label={`${title}: ${which === "depart" ? "earliest departure" : "latest arrival"}`}
        aria-valuetext={label(which)} aria-valuemin={0} aria-valuemax={which === "depart" ? 1440 : ANY_ARRIVAL}
        aria-valuenow={which === "depart" ? depart : arrive} title={`${label(which)}\nDrag, or use ← and →`}
        onPointerDown={onPointerDown(which)} onPointerMove={onPointerMove(which)}
        onPointerUp={onPointerUp(which)} onPointerCancel={() => setDrag(null)} onKeyDown={onKeyDown(which)}>
        <span className="time-handle-grip" />
        {(active || drag?.which === which) && <span className="time-handle-label">{label(which)}</span>}
      </span>;
    })}
  </div>;
}

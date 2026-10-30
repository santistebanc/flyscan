import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { Leg } from "./api";
import type { Rating } from "./flightRatings";
import { AirportLabel } from "./AirportLabel";
import { ANY_ARRIVAL, type DirectionTimes } from "./flightFilters";
import { airlineColor, clock, dayOffset, elapsed, filteredOutSpans, isOvernight, localHourMarks, localMidnights, partLabel, percent, timingNote,
  timelineScaleFor, timelineScaleLabel, type JourneyTiming, type TimelineMode, type TimelineScale } from "./flightTimeline";

/** An element's rendered width, kept current as the layout changes. */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * How much room a label in the strip above the bars needs: its offset from its
 * line, its text — short, fixed strings like "Dec 17" and "06:00", so a width
 * per character is close enough — and clear space before whatever comes next.
 */
const labelRoom = (text: string, perChar: number) => 4 + text.length * perChar + 10;

/**
 * Which labels to draw: each needs its room before the end of the plot and
 * before the next label's line. One that would run into the arrival time or
 * another label is left out; its line stays, with the date on hover.
 */
function fittingLabels<T extends { x: number; text: string }>(marks: T[], width: number, perChar: number): Set<T> {
  // Not measured yet (the first render, or no layout at all): every label, as before.
  if (width <= 0) return new Set(marks);
  const sorted = [...marks].sort((a, b) => a.x - b.x);
  return new Set(sorted.filter((mark, i) => {
    const next = sorted[i + 1]?.x ?? width;
    return Math.min(width, next) - mark.x >= labelRoom(mark.text, perChar);
  }));
}

/** One direction of a row: times flank the bars, duration and stops on the right. */
export function FlightTimeline({ label, leg, scale: sharedScale, timing, mode = "shared", rating, layoverRatings, times }: {
  label: string; leg: Leg | null; scale: TimelineScale | null; timing: JourneyTiming | null | undefined;
  mode?: TimelineMode; rating?: Rating; layoverRatings?: ReadonlyMap<number, Rating>;
  /** The direction's time filters, shaded where the timeline falls outside them. */
  times?: DirectionTimes;
}) {
  const [plot, plotWidth] = useWidth<HTMLSpanElement>();
  if (!leg) return null;
  const scale = timelineScaleFor(timing, sharedScale, mode);
  const later = dayOffset(leg.departure, leg.arrival);
  const note = timing ? timingNote(timing) : undefined;
  const midnights = timing && scale ? localMidnights(timing, scale) : [];
  const hours = timing && scale && plotWidth ? localHourMarks(timing, scale, plotWidth / (scale.max - scale.min)) : [];
  const waits = timing?.detailed ? timing.parts.filter(({ part }) => part.kind === "layover") : [];
  // Dates first: an hour label also gives way to a date line it would reach.
  const at = (time: number) => scale ? percent(time, scale) / 100 * plotWidth : 0;
  const dateMarks = midnights.map((m) => ({ ...m, x: at(m.at), text: m.label }));
  const shownDates = fittingLabels(dateMarks, plotWidth, 6.5);
  const hourMarks = hours.map((h) => ({ ...h, x: at(h.at), text: `${String(h.hour).padStart(2, "0")}:00` }));
  const fitting = fittingLabels([...hourMarks, ...dateMarks], plotWidth, 6);
  const shownHours = new Set(hourMarks.filter((hour) => fitting.has(hour) && !dateMarks.some((date) =>
    shownDates.has(date) && hour.x >= date.x && hour.x < date.x + labelRoom(date.text, 6.5))));
  const stops = leg.stops ? `${leg.stops} stop${leg.stops === 1 ? "" : "s"}` : "";
  return <span className="leg" aria-label={`${label}: ${leg.origin_airport} to ${leg.destination_airport}, ${leg.duration}`}>
    <span className="leg-end"><b className="clock">{clock(leg.departure)}</b><AirportLabel code={leg.origin_airport} showCity={false} /></span>
    <span className="leg-track">
      {timing && scale ? <span className="leg-plot" role="img" ref={plot}
        aria-label={`${timelineScaleLabel(scale, mode)} timeline`}>
        {times && filteredOutSpans(timing, scale,
          times.depart.from > 0 ? times.depart.from : null, times.arrive.to < ANY_ARRIVAL ? times.arrive.to : null).map(({ start, end, side }) =>
          <span key={side} className={`leg-filtered ${side}`}
            title={side === "before" ? "Before the earliest departure filter" : "After the latest arrival filter"}
            style={{ left: `${percent(start, scale)}%`, width: `${(end - start) / (scale.max - scale.min) * 100}%` }} />)}
        {dateMarks.map((mark) => {
          const left = percent(mark.at, scale);
          return <span key={mark.at}>
            <span className="leg-midnight" title={mark.label} style={{ left: `${left}%` }} />
            {shownDates.has(mark) && <span className="leg-date" aria-hidden="true" style={{ left: `${left}%` }}>{mark.label}</span>}
          </span>;
        })}
        {hourMarks.map((mark) => {
          const left = `${percent(mark.at, scale)}%`;
          return <span key={`h${mark.at}`}>
            <span className="leg-hour" style={{ left }} />
            {shownHours.has(mark) && <span className="leg-hour-label" aria-hidden="true" style={{ left }}>{mark.text}</span>}
          </span>;
        })}
        {timing.parts.filter((p) => p.end > p.start).map(({ part, start, end }, i) => <span key={i}
          title={partLabel(part)}
          className={`leg-part ${part.kind === "flight" ? part.detailed ? "airborne" : "summary" : part.transfer ? "layover transfer" : "layover"}`}
          style={{ left: `${percent(start, scale)}%`, width: `${(end - start) / (scale.max - scale.min) * 100}%`,
            "--airline": part.kind === "flight" ? airlineColor(part.segment.carrier) : undefined } as CSSProperties} />)}
      </span> : <span className="leg-unavailable">Schedule unavailable</span>}
      <span className="leg-connections">
        {waits.map(({ part }, i) => {
          if (part.kind !== "layover") return null;
          const wait = part.minutes === null ? undefined : layoverRatings?.get(part.minutes);
          return <span key={i} className={part.transfer ? "transfer" : undefined}
            title={[partLabel(part), wait?.description].filter(Boolean).join("\n")}>
            {part.transfer ? `${part.before.destination}→${part.after.origin}` : part.before.destination}{" "}
            <span data-rating={wait?.level}>{elapsed(part.minutes)}</span>
            {isOvernight(part) && <span className="leg-night" title="Overnight connection"> ☾</span>}
          </span>;
        })}
        {timing && !timing.detailed && leg.stops !== 0 && <span className="leg-summary-hint"
          title="Segment times unavailable. The total journey is placed on the timeline; open flight details for the itinerary.">Schedule not detailed</span>}
      </span>
    </span>
    <span className="leg-end arrival"><b className="clock">{clock(leg.arrival)}{later > 0 && <sup>+{later}</sup>}</b>
      <AirportLabel code={leg.destination_airport} showCity={false} /></span>
    <span className="leg-duration">
      {note && <span className="leg-warning" role="img" aria-label={note} title={note}>⚠</span>}
      <span data-rating={rating?.level} title={rating?.description}>{leg.duration}</span>
      {stops && <span className="leg-stops">{stops}</span>}
    </span>
  </span>;
}

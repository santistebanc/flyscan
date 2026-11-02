/** The selected flight's journey, drawn large: each flight and wait to scale, with its times and airports. */
import type { CSSProperties } from "react";
import type { Leg } from "./api";
import type { Rating } from "./flightRatings";
import { airlineColor, clock, elapsed, isOvernight, journeyHourMarks, journeyScale, journeyTiming, localMidnights,
  partLabel, percent, timelineScaleFor, type JourneyTiming, type TimelineScale } from "./flightTimeline";
import { fittingLabels, useWidth } from "./TimelineFlight";

/** Mono label widths per character, close enough for short fixed strings. */
const LABEL_CHAR = 7, SCALE_CHAR = 6.5, BAR_CHAR = 6.5;
const room = (text: string, perChar: number) => text.length * perChar + 8;

/** `x` in pixels, `pct` the same place as a share of the plot, for before it is measured. */
export interface EndLabel { x: number; pct: number; text: string; anchor: "start" | "end"; left: number }
/**
 * One row of labels: departures read rightwards from where their flight
 * starts, arrivals leftwards from where it ends. One that would run past the
 * plot is moved to fit inside it; one that would overlap the label before it
 * is left out, with its time still on hover and in the list below.
 * Unmeasured (width 0), every label is kept.
 */
export function placeEndLabels(marks: Omit<EndLabel, "left">[], width: number): EndLabel[] {
  const placed = marks.map((mark) => {
    const size = room(mark.text, LABEL_CHAR);
    const left = mark.anchor === "start" ? Math.min(mark.x, width - size) : Math.max(0, mark.x - size);
    return { ...mark, left: Math.max(0, left), size };
  }).sort((a, b) => a.left - b.left);
  if (width <= 0) return placed;
  let edge = -Infinity;
  return placed.filter((label) => {
    if (label.left < edge) return false;
    edge = label.left + label.size;
    return true;
  });
}

/** What a bar says inside itself, longest first, when there is room for it. */
function barText(part: JourneyTiming["parts"][number]["part"]): string[] {
  if (part.kind === "flight") {
    const s = part.segment;
    if (!part.detailed) return ["Schedule not detailed"];
    const number = s.flight_number || s.carrier || "";
    const time = part.minutes === null ? "" : elapsed(part.minutes);
    return [[s.carrier_name, number, time && `· ${time}`].filter(Boolean).join(" "),
      [number, time && `· ${time}`].filter(Boolean).join(" "), time, number].filter(Boolean);
  }
  const where = part.transfer ? `${part.before.destination}→${part.after.origin}` : part.before.destination;
  const wait = `${elapsed(part.minutes)}${isOvernight(part) ? " ☾" : ""}`;
  return [`${where} · ${wait}`, wait];
}

/**
 * `scale`: one axis for every trip in this direction, so the bars keep their
 * places from one trip to the next. Without it the journey alone fills the plot.
 * `bare`: the days and hours alone, no flight on them.
 */
export function JourneyTimeline({ leg, title, layoverRatings, scale: shared, bare }: {
  leg: Leg; title: string; layoverRatings?: ReadonlyMap<number, Rating>; scale?: TimelineScale | null; bare?: boolean;
}) {
  const [plot, width] = useWidth<HTMLDivElement>();
  const timing = journeyTiming(leg);
  if (!timing) return null;
  const scale: TimelineScale = shared ? timelineScaleFor(timing, shared, "shared")! : journeyScale(timing);
  const span = scale.max - scale.min;
  const at = (minute: number) => percent(minute, scale) / 100 * width;
  const midnights = localMidnights(timing, scale).map((m) => ({ ...m, x: at(m.at), text: m.label }));
  const shownDates = fittingLabels(midnights, width, SCALE_CHAR);
  const hours = (width ? journeyHourMarks(timing, scale, width / span) : [])
    .map((h) => ({ ...h, x: at(h.at), text: `${String(h.hour).padStart(2, "0")}:00` }));
  const fitting = fittingLabels([...hours, ...midnights], width, SCALE_CHAR);
  const shownHours = hours.filter((hour) => fitting.has(hour) && !midnights.some((date) =>
    shownDates.has(date) && hour.x >= date.x && hour.x < date.x + room(date.text, SCALE_CHAR) + 6));
  const parts = bare ? [] : timing.parts;
  const flights = parts.filter(({ part }) => part.kind === "flight");
  // Departures above the bars and arrivals below, so a stop's two never compete.
  const ends = (["start", "end"] as const).flatMap((anchor) => placeEndLabels(flights.flatMap(({ part, start, end }) => {
    if (part.kind !== "flight") return [];
    const s = part.segment, edge = anchor === "start" ? start : end;
    return [{ x: at(edge), pct: percent(edge, scale), anchor,
      text: anchor === "start" ? `${clock(s.departure)} ${s.origin}` : `${s.destination} ${clock(s.arrival)}` }];
  }), width));
  const position = (start: number, end: number): CSSProperties =>
    ({ left: `${percent(start, scale)}%`, width: `${(end - start) / span * 100}%` });
  return <div className="journey-timeline" role="img" ref={plot}
    aria-label={bare ? `${title} timeline, no flight`
      : `${title} timeline: ${leg.origin_airport} ${clock(leg.departure)} to ${leg.destination_airport} ${clock(leg.arrival)}, ${leg.duration}`}>
    {midnights.map((mark, i) => <span key={`d${i}`}>
      <span className="jt-midnight" title={mark.label} style={{ left: `${percent(mark.at, scale)}%` }} />
      {shownDates.has(mark) && <span className="jt-date" aria-hidden="true" style={{ left: `${percent(mark.at, scale)}%` }}>{mark.label}</span>}
    </span>)}
    {shownHours.map((mark, i) => <span key={`h${i}`}>
      <span className="jt-hour" style={{ left: `${percent(mark.at, scale)}%` }} />
      <span className="jt-hour-label" aria-hidden="true" style={{ left: `${percent(mark.at, scale)}%` }}>{mark.text}</span>
    </span>)}
    {parts.filter((p) => p.end > p.start).map(({ part, start, end }, i) => {
      const size = (end - start) / span * width;
      const text = barText(part).find((option) => !width || room(option, BAR_CHAR) <= size);
      const wait = part.kind === "layover" && part.minutes !== null ? layoverRatings?.get(part.minutes) : undefined;
      return <span key={i} title={[partLabel(part), wait?.description].filter(Boolean).join("\n")}
        className={`jt-part ${part.kind === "flight" ? part.detailed ? "airborne" : "summary" : part.transfer ? "layover transfer" : "layover"}`}
        data-rating={wait?.level}
        style={{ ...position(start, end), "--airline": part.kind === "flight" ? airlineColor(part.segment.carrier) : undefined } as CSSProperties}>
        {text && <span className="jt-part-text" aria-hidden="true">{text}</span>}
      </span>;
    })}
    {ends.map((label, i) => <span key={i} aria-hidden="true" className={`jt-end ${label.anchor === "start" ? "departs" : "arrives"}`}
      style={width ? { left: label.left } : label.anchor === "start"
        ? { left: `${label.pct}%` } : { left: `${label.pct}%`, transform: "translateX(-100%)" }}>{label.text}</span>)}
  </div>;
}

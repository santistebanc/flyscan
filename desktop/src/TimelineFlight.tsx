import type { CSSProperties } from "react";
import type { Leg } from "./api";
import type { Rating } from "./flightRatings";
import { Icon } from "./Icon";
import { TimelineHotspot } from "./TimelineTooltip";
import { TimelineDates } from "./TimelineDates";
import { TimelineHours } from "./TimelineHours";
import { AirportLabel } from "./AirportLabel";
import { airlineColor, clock, dayOffset, elapsed, isOvernight, localMidnights, percent, timingNote, timelineScaleFor, timelineScaleLabel,
  type JourneyTiming, type TimelineMode, type TimelineScale } from "./flightTimeline";

export function FlightTimeline({ leg, scale: sharedScale, timing, mode = "shared", layoverRatings }: { leg: Leg | null; scale: TimelineScale | null;
  timing: JourneyTiming | null | undefined; mode?: TimelineMode; layoverRatings?: ReadonlyMap<number, Rating> }) {
  if (!leg) return null;
  const scale = timelineScaleFor(timing, sharedScale, mode);
  const scaleLabel = scale ? timelineScaleLabel(scale, mode) : "";
  const shift = dayOffset(leg.departure, leg.arrival);
  const note = timing ? timingNote(timing) : undefined;
  const midnights = timing ? localMidnights(timing, scale ?? undefined) : [];
  const waits = timing?.detailed ? timing.parts.filter(({ part }) => part.kind === "layover") : [];
  return <span className="flight-timeline" aria-label={`${leg.origin_airport} to ${leg.destination_airport}, ${leg.duration}`}>
    <span className="timeline-meta">
      <span><b>{clock(leg.departure)}</b><AirportLabel code={leg.origin_airport} /></span>
      <span><AirportLabel code={leg.destination_airport} /><b>{clock(leg.arrival)}{shift > 0 && <sup>+{shift}</sup>}</b></span>
    </span>
    {timing && scale ? <span className="timeline-plot" aria-label={`${scaleLabel} timeline`}>
      <TimelineHours scale={scale} />
      {midnights.map(({ at }) => <span key={at} className="timeline-guide" aria-hidden="true" style={{ left: `${percent(at, scale)}%` }} />)}
      {timing.parts.filter((p) => p.end > p.start).map(({ part, start, end }, i) => <TimelineHotspot key={i} part={part}
        note={note}
        className={`timeline-part ${part.kind === "flight" ? part.detailed ? "airborne" : "summary" : "layover"}`}
        style={{ left: `${percent(start, scale)}%`, width: `${(end - start) / (scale.max - scale.min) * 100}%`,
          "--airline": part.kind === "flight" ? airlineColor(part.segment.carrier) : undefined } as CSSProperties}>
        <span className="timeline-ink" aria-hidden="true" />
      </TimelineHotspot>)}
      <TimelineDates dates={midnights} scale={scale} />
    </span> : <span className="timeline-unavailable">Schedule unavailable</span>}
    <span className="timeline-footer">
      <span className="timeline-stops">{timing && !timing.detailed ? <span className="timeline-summary-hint" title="Segment times unavailable. The total journey is placed on the timeline; open flight details for the itinerary.">{leg.stops === 0 ? "Nonstop" : leg.stops ? `${leg.stops} stop${leg.stops === 1 ? "" : "s"}` : ""}<Icon name="input" /></span>
        : waits.length ? waits.map(({ part }, i) => part.kind === "layover" && <span key={i} className="timeline-connection"
          data-rating={part.minutes === null ? undefined : layoverRatings?.get(part.minutes)?.level}
          title={part.minutes === null ? undefined : layoverRatings?.get(part.minutes)?.description}>
          <AirportLabel code={part.before.destination} />{part.transfer && <> → <AirportLabel code={part.after.origin} /></>}
          <span className="timeline-connection-duration" data-rating={part.minutes === null ? undefined : layoverRatings?.get(part.minutes)?.level}>{elapsed(part.minutes)}</span>
          {isOvernight(part) && <span className="layover-night" title="Overnight layover"><Icon name="moon" /></span>}</span>)
        : leg.stops === 0 ? "Nonstop" : leg.stops ? `${leg.stops} stops` : ""}</span>
      {scale && <span className="timeline-scale" title={mode === "days"
        ? "Range starts at midnight at the departure airport: 24 hours minimum, then 27, 30, 33 hours and so on. Positions and hour dividers advance by elapsed travel time on this reference clock. Compare bar lengths within the same range."
        : "All filtered flights in this direction share the same scale. Hour dividers use departure-airport reference time; flight details retain each airport's local times."}>{scaleLabel}</span>}
    </span>
  </span>;
}

export function LegDuration({ leg, timing, rating }: { leg: Leg | null; timing: JourneyTiming | null | undefined; rating?: Rating }) {
  if (!leg?.duration) return null;
  const note = timing ? timingNote(timing) : undefined;
  return <span className="timeline-duration" data-rating={rating?.level} title={rating?.description}>
    {note && <span className="timeline-timing-warning" role="img" aria-label={note} title={note}><Icon name="failed" /></span>}
    {leg.duration}
  </span>;
}

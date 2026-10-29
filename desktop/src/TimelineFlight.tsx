import { useContext, type CSSProperties } from "react";
import type { Leg } from "./api";
import type { Rating } from "./flightRatings";
import { AirportLabel } from "./AirportLabel";
import { AirlineColors } from "./airlineColors";
import { airlineColor, clock, dayOffset, elapsed, isOvernight, localMidnights, partLabel, percent, timingNote,
  timelineScaleFor, timelineScaleLabel, type JourneyTiming, type TimelineMode, type TimelineScale } from "./flightTimeline";

/** One direction of a row: times flank the bars, duration and stops on the right. */
export function FlightTimeline({ label, leg, scale: sharedScale, timing, mode = "shared", rating, layoverRatings }: {
  label: string; leg: Leg | null; scale: TimelineScale | null; timing: JourneyTiming | null | undefined;
  mode?: TimelineMode; rating?: Rating; layoverRatings?: ReadonlyMap<number, Rating>;
}) {
  const colors = useContext(AirlineColors);
  if (!leg) return null;
  const scale = timelineScaleFor(timing, sharedScale, mode);
  const later = dayOffset(leg.departure, leg.arrival);
  const note = timing ? timingNote(timing) : undefined;
  const midnights = timing && scale ? localMidnights(timing, scale) : [];
  const waits = timing?.detailed ? timing.parts.filter(({ part }) => part.kind === "layover") : [];
  const stops = leg.stops ? `${leg.stops} stop${leg.stops === 1 ? "" : "s"}` : "";
  return <span className="leg" aria-label={`${label}: ${leg.origin_airport} to ${leg.destination_airport}, ${leg.duration}`}>
    <span className="leg-label" aria-hidden="true">{label === "Outbound" ? "Out" : "Ret"}</span>
    <span className="leg-end"><b className="clock">{clock(leg.departure)}</b><AirportLabel code={leg.origin_airport} showCity={false} /></span>
    <span className="leg-track">
      {timing && scale ? <span className="leg-plot" role="img"
        aria-label={`${timelineScaleLabel(scale, mode)} timeline`}>
        {midnights.map(({ at, label: day }) => {
          const left = percent(at, scale);
          return <span key={at}>
            <span className="leg-midnight" title={day} style={{ left: `${left}%` }} />
            <span className="leg-date" aria-hidden="true" style={{ left: `${left}%` }}>{day}</span>
          </span>;
        })}
        {timing.parts.filter((p) => p.end > p.start).map(({ part, start, end }, i) => <span key={i}
          title={partLabel(part)}
          className={`leg-part ${part.kind === "flight" ? part.detailed ? "airborne" : "summary" : part.transfer ? "layover transfer" : "layover"}`}
          style={{ left: `${percent(start, scale)}%`, width: `${(end - start) / (scale.max - scale.min) * 100}%`,
            "--airline": part.kind === "flight" ? airlineColor(part.segment.carrier, colors) : undefined } as CSSProperties} />)}
      </span> : <span className="leg-unavailable">Schedule unavailable</span>}
      <span className="leg-connections">
        {waits.map(({ part }, i) => part.kind === "layover" && <span key={i} className={part.transfer ? "transfer" : undefined}
          title={partLabel(part)}>
          {part.transfer ? `${part.before.destination}→${part.after.origin}` : part.before.destination}{" "}
          <span data-rating={part.minutes === null ? undefined : layoverRatings?.get(part.minutes)?.level}>{elapsed(part.minutes)}</span>
          {isOvernight(part) && <span className="leg-night" title="Overnight connection"> ☾</span>}
        </span>)}
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

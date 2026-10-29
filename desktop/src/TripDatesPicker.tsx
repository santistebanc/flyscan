/**
 * When a hand-entered trip goes and comes back, on one calendar.
 *
 * The first day picked is the way out and the second the way back, drawn as
 * one span like the search bar's calendars. A one-way needs only the first, so
 * the trip's kind is chosen here too rather than by a separate control.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Month, daysBetween, initialCalendarView, readable } from "./RangePicker";
import { SearchSegment, useDismiss, useKeepInView } from "./Popover";

export interface TripDates { depart: string; ret: string; roundTrip: boolean }

export function TripDatesPicker({ dates, min, open, onToggle, onChange }: {
  dates: TripDates; min: string; open: boolean;
  onToggle: (open: boolean) => void; onChange: (next: TripDates) => void;
}) {
  const { depart, ret, roundTrip } = dates;
  /** True once the outbound is down and the return is being chosen. */
  const [drawing, setDrawing] = useState(false);
  const [hover, setHover] = useState("");
  const opening = initialCalendarView(depart, ret, min);
  const [month, setMonth] = useState(opening.month);
  const box = useRef<HTMLDivElement | null>(null);
  const popup = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => onToggle(false), [onToggle]);
  useDismiss(open, close, box);
  useKeepInView(open, popup);

  useEffect(() => {
    if (!open) return;
    setMonth(opening.month);
    // An unfinished round trip picks up where it left off: at the return.
    setDrawing(roundTrip && Boolean(depart) && !ret);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pick = (day: string) => {
    if (!roundTrip) {
      onChange({ ...dates, depart: day, ret: "" });
      close();
    } else if (!drawing || !depart || day < depart) {
      onChange({ ...dates, depart: day, ret: "" });
      setDrawing(true);
    } else {
      onChange({ ...dates, ret: day });
      setDrawing(false);
      close();
    }
  };
  const setKind = (round: boolean) => {
    onChange({ depart, ret: round ? ret : "", roundTrip: round });
    setDrawing(round && Boolean(depart) && !ret);
  };

  const nights = depart && ret ? daysBetween(depart, ret) : null;
  const value = !depart ? "Pick dates" : roundTrip ? `${readable(depart)} – ${ret ? readable(ret) : "?"}` : readable(depart);
  const hint = !roundTrip ? "One way" : nights === null ? "Round trip" : `Round trip · ${nights} night${nights === 1 ? "" : "s"}`;
  const note = !roundTrip ? "Pick the day you fly out"
    : drawing ? "Now pick the day you fly back" : depart && ret ? "Click a day to start again" : "Pick the day you fly out";
  const next = { year: month.month === 11 ? month.year + 1 : month.year, month: (month.month + 1) % 12 };
  const page = (by: number) => setMonth((was) => {
    const to = new Date(was.year, was.month + by, 1, 12);
    return { year: to.getFullYear(), month: to.getMonth() };
  });

  return <SearchSegment label="Trip dates" value={value} hint={hint} open={open} root={box} onToggle={() => onToggle(!open)}>
    <div className="popover cal-popup" ref={popup} tabIndex={-1} role="dialog" aria-label="Choose trip dates">
      <div className="manual-trip-kind" role="group" aria-label="Kind of trip">
        <button type="button" aria-pressed={roundTrip} onClick={() => setKind(true)}>Round trip</button>
        <button type="button" aria-pressed={!roundTrip} onClick={() => setKind(false)}>One way</button>
      </div>
      <div className="cal-months" onMouseLeave={() => setHover("")}>
        {[month, next].map((shown, index) => <Month key={index} year={shown.year} month={shown.month}
          from={depart} to={roundTrip ? ret : depart} min={min} drawing={drawing} cursor={drawing ? depart : ret || depart}
          hover={hover} onPick={pick} onHover={setHover}
          nav={index === 0 ? { label: "Earlier", icon: "chevron-left", onClick: () => page(-1) }
            : { label: "Later", icon: "chevron-right", onClick: () => page(1) }} />)}
      </div>
      <div className="cal-foot">
        <span className="cal-note">{note}</span>
        <button type="button" className="cal-plain" onClick={close}>Done</button>
      </div>
    </div>
  </SearchSegment>;
}

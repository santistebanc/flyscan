import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useId } from "react";
import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import { airlineColor, clock, dayOffset, elapsed, partLabel, type TimelinePart } from "./flightTimeline";

type Open = { part: TimelinePart; anchor: HTMLButtonElement; id: string; note?: string };
const TipContext = createContext<{ open: (tip: Open) => void; update: (tip: Open) => void; leave: () => void; active: string | undefined; close: () => void } | null>(null);
export function TimelineHotspot({ part, children, className, style, note }: { part: TimelinePart; children: ReactNode; className: string; style?: CSSProperties; note?: string }) {
  const tip = useContext(TipContext)!;
  const id = useId();
  const anchor = useRef<HTMLButtonElement>(null);
  // A background refresh replaces the part object without replacing this button.
  // Refresh the open content in place; don't wait for another pointer-enter event.
  useLayoutEffect(() => {
    if (tip.active === id && anchor.current) tip.update({ part, anchor: anchor.current, id, note });
  }, [part, note, id, tip.active, tip.update]);
  return <button ref={anchor} type="button" className={`timeline-hotspot ${className}`} style={style}
    aria-label={partLabel(part)} aria-describedby={tip.active === id ? "flight-timeline-tooltip" : undefined}
    onPointerEnter={(e) => { if (e.pointerType !== "touch") tip.open({ part, anchor: e.currentTarget, id, note }); }}
    onPointerLeave={tip.leave} onFocus={(e) => tip.open({ part, anchor: e.currentTarget, id, note })}
    onBlur={tip.leave} onClick={(e) => { e.stopPropagation(); tip.open({ part, anchor: e.currentTarget, id, note }); }}
    onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); tip.close(); } }}>
    {children}
  </button>;
}
export function TimelineTooltipProvider({ children, resetKey: resultsVersion }: { children: ReactNode; resetKey: unknown }) {
  const [tip, setTip] = useState<Open | null>(null);
  const [position, setPosition] = useState({ left: 12, top: 12 });
  const bubble = useRef<HTMLDivElement>(null);
  const current = useRef<Open | null>(null);
  const timer = useRef(0);
  const keep = useCallback(() => window.clearTimeout(timer.current), []);
  const close = useCallback(() => { keep(); current.current = null; setTip(null); }, [keep]);
  const open = useCallback((next: Open) => {
    keep(); current.current = next;
    setTip((was) => was?.id === next.id && was.anchor === next.anchor && was.part === next.part && was.note === next.note ? was : next);
  }, [keep]);
  const update = useCallback((next: Open) => {
    if (current.current?.id !== next.id) return;
    current.current = next;
    // Updating data must not reopen a dismissed popup or cancel a genuine leave.
    setTip((was) => was?.id === next.id && was.anchor === next.anchor && was.part === next.part && was.note === next.note ? was : next);
  }, []);
  const leave = useCallback(() => {
    keep();
    // This grace period only bridges the gap between the segment and popup.
    // Hover, keyboard focus, and click/tap focus never have an expiry timer.
    timer.current = window.setTimeout(() => {
      const active = current.current;
      if (!active) return;
      if (active.anchor.isConnected && (active.anchor.matches(":hover") || bubble.current?.matches(":hover")
        || document.activeElement === active.anchor || bubble.current?.contains(document.activeElement))) return;
      close();
    }, 160);
  }, [keep, close]);
  useEffect(() => {
    const dismiss = (e: KeyboardEvent) => { if (e.key === "Escape" && current.current) { e.stopPropagation(); close(); } };
    const away = (e: PointerEvent) => { if (!(e.target instanceof Node) || (!bubble.current?.contains(e.target) && !current.current?.anchor.contains(e.target))) close(); };
    const scroll = () => close();
    document.addEventListener("keydown", dismiss);
    document.addEventListener("pointerdown", away);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", scroll);
    return () => {
      keep(); document.removeEventListener("keydown", dismiss); document.removeEventListener("pointerdown", away);
      window.removeEventListener("scroll", scroll, true); window.removeEventListener("resize", scroll);
    };
  }, [close, keep]);
  useLayoutEffect(() => {
    if (!tip) return;
    if (!tip.anchor.isConnected) { close(); return; }
    if (!bubble.current) return;
    const a = tip.anchor.getBoundingClientRect(), b = bubble.current.getBoundingClientRect();
    const left = Math.max(12, Math.min(innerWidth - b.width - 12, a.left + a.width / 2 - b.width / 2));
    const top = a.bottom + b.height + 12 < innerHeight ? a.bottom + 6 : Math.max(8, a.top - b.height - 6);
    setPosition((was) => was.left === left && was.top === top ? was : { left, top });
  }, [tip, resultsVersion, close]);
  const controls = useMemo(() => ({ open, update, leave, active: tip?.id, close }), [open, update, leave, tip?.id, close]);
  const part = tip?.part;
  const segment = part?.kind === "flight" ? part.segment : null;
  const from = segment?.departure ?? (part?.kind === "layover" ? part.before.arrival : "");
  const to = segment?.arrival ?? (part?.kind === "layover" ? part.after.departure : "");
  const shift = dayOffset(from, to);
  return <TipContext.Provider value={controls}>
    {children}
    {tip && part && createPortal(<div ref={bubble} id="flight-timeline-tooltip" role="tooltip" className="timeline-tooltip"
      style={position} onPointerEnter={keep} onPointerLeave={leave} onMouseDown={(e) => e.stopPropagation()}>
      <div className="tip-heading">{segment ? <><i style={{ background: airlineColor(segment.carrier) }}/>{part.kind === "flight" && !part.detailed ? `Journey summary${segment.carrier_name ? ` · ${segment.carrier_name}` : ""}` : segment.carrier_name || segment.carrier || "Airline unavailable"}</> : part.kind === "layover" && (part.transfer ? "Airport transfer" : `Layover in ${part.before.destination}`)}</div>
      <div className="tip-route">{segment ? `${segment.origin} → ${segment.destination}` : part.kind === "layover" && (part.transfer ? `${part.before.destination} → ${part.after.origin}` : part.before.destination)}<b>{segment?.duration || elapsed(part.minutes)}</b></div>
      <div className="tip-times">{clock(from)} → {clock(to)}{shift > 0 ? ` (+${shift} day${shift > 1 ? "s" : ""})` : ""}<span>{segment?.flight_number}</span></div>
      <div className="tip-foot">{from.slice(0, 10)}{from.slice(0, 10) !== to.slice(0, 10) ? ` → ${to.slice(0, 10)}` : ""} · Local airport times{part.kind === "flight" && !part.detailed ? " · Segment times unavailable" : ""}</div>
      {part.kind === "layover" && part.fromJourneyDuration && <div className="tip-timing-note">Connection time from the total journey duration, including the airport change.</div>}
      {tip.note && <div className="tip-timing-note">{tip.note}</div>}
    </div>, document.body)}
  </TipContext.Provider>;
}

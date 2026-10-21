import { useLayoutEffect, useRef } from "react";
import { percent, type Midnight, type TimelineScale } from "./flightTimeline";
import { layoutTimelineDates } from "./timelineDateLayout";

export function TimelineDates({ dates, scale }: { dates: Midnight[]; scale: TimelineScale }) {
  const band = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const node = band.current, plot = node?.parentElement;
    if (!node || !plot) return;
    let active = true;
    const measure = () => {
      if (!active) return;
      const labels = Array.from(node.children) as HTMLElement[];
      const width = plot.getBoundingClientRect().width;
      const layout = layoutTimelineDates(width, labels.map((label, i) => ({
        at: percent(dates[i]!.at, scale) / 100 * width, width: label.getBoundingClientRect().width,
      })));
      labels.forEach((label, i) => {
        label.style.left = `${layout.positions[i]!.left}px`;
        label.style.top = `${layout.positions[i]!.top}px`;
      });
      plot.style.setProperty("--timeline-date-height", `${layout.height}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(plot);
    void document.fonts.ready.then(measure);
    return () => { active = false; observer.disconnect(); };
  }, [dates, scale]);
  return <span className="timeline-dates" ref={band} aria-hidden="true">
    {dates.map(({ at, label }) => <span key={at} className="timeline-midnight"
      style={{ left: `${percent(at, scale)}%` }}>{label}</span>)}
  </span>;
}

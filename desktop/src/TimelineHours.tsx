import { useLayoutEffect, useRef, useState } from "react";
import { percent, type TimelineScale } from "./flightTimeline";
import { timelineHourTicks } from "./timelineHourTicks";

export function TimelineHours({ scale }: { scale: TimelineScale }) {
  const ruler = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = ruler.current;
    if (!node) return;
    const measure = () => setWidth(node.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return <span className="timeline-hours" ref={ruler} aria-hidden="true">
    {timelineHourTicks(scale, width).map(({ at, label }) => <span key={at}>
      <span className="timeline-hour-guide" style={{ left: `${percent(at, scale)}%` }} />
      <span className="timeline-hour-label" style={{ left: `clamp(0px, calc(${percent(at, scale)}% - 2.5ch), calc(100% - 5ch))` }}>{label}</span>
    </span>)}
  </span>;
}

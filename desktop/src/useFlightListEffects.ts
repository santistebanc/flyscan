import { useLayoutEffect, useRef, type RefObject } from "react";
import type { FlightRow } from "./api";

type Anchor = { key: string; top: number; height: number; scrollY: number; viewportTop: number };

/** Keep the selected row at its viewport position across commits. Account for
 * scrolling since the previous commit so this never pins the user's scroll.
 * Results keeps the selected row mounted even if an insertion moves its index
 * outside the virtual range, allowing a correction before the browser paints.
 */
export function useSelectedFlightAnchor(list: RefObject<HTMLDivElement | null>, selected: string | null) {
  const anchor = useRef<Anchor | null>(null);
  const isAnchored = () => {
    const old = anchor.current;
    if (!old || old.key !== selected) return false;
    const top = old.top - (window.scrollY - old.scrollY);
    return top + old.height > old.viewportTop && top < window.innerHeight;
  };

  useLayoutEffect(() => {
    const node = list.current?.querySelector<HTMLElement>('.flight[aria-selected="true"]');
    if (!selected || !node) { anchor.current = null; return; }
    let rect = node.getBoundingClientRect();
    let top = rect.top;
    const old = anchor.current;
    if (old && isAnchored()) {
      const targetTop = old.top - (window.scrollY - old.scrollY);
      const delta = rect.top - targetTop;
      if (Math.abs(delta) > 0.5) {
        window.scrollBy({ top: delta, behavior: "instant" });
        rect = node.getBoundingClientRect();
      }
      // Browsers quantize scrolling to device pixels. Retain the intended
      // position within that tolerance so rounding cannot accumulate drift.
      top = Math.abs(rect.top - targetTop) <= 0.5 ? targetTop : rect.top;
    }
    anchor.current = { key: selected, top, height: rect.height, scrollY: window.scrollY,
      viewportTop: Math.max(0, document.querySelector(".results-bar")?.getBoundingClientRect().bottom ?? 0) };
  });

  return isAnchored;
}

/** Only genuinely new flights fade in. Re-sorting, filtering and virtual row
 * remounts do not replay an entrance. Offscreen arrivals expire quickly, so
 * scrolling through a large batch never creates a wave of delayed animations.
 */
export function useFlightArrivals(list: RefObject<HTMLDivElement | null>, dataset: FlightRow[]) {
  const previous = useRef<FlightRow[] | null>(null);
  const seen = useRef(new Set<string>());
  const arrivals = useRef(new Map<string, number>());

  useLayoutEffect(() => {
    const now = performance.now();
    if (previous.current !== dataset) {
      const hadResults = seen.current.size > 0;
      if (!dataset.length) { seen.current.clear(); arrivals.current.clear(); }
      for (const row of dataset) {
        if (hadResults && !seen.current.has(row.trip_key)) arrivals.current.set(row.trip_key, now + 200);
        seen.current.add(row.trip_key);
      }
      previous.current = dataset;
    }
    for (const [key, expires] of arrivals.current) {
      if (expires <= now) arrivals.current.delete(key);
    }
    if (!arrivals.current.size) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { arrivals.current.clear(); return; }
    for (const node of list.current?.querySelectorAll<HTMLElement>(".flight[data-flight-key]") ?? []) {
      const key = node.dataset.flightKey!;
      if (!arrivals.current.has(key)) continue;
      const rect = node.getBoundingClientRect();
      if (rect.bottom <= 0 || rect.top >= window.innerHeight) continue;
      arrivals.current.delete(key);
      node.animate([{ opacity: 0.35 }, { opacity: 1 }], {
        duration: 160, easing: "cubic-bezier(0.23, 1, 0.32, 1)",
      });
    }
  });
}

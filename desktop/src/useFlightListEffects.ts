import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { FlightRow } from "./api";

type Anchor = { key: string; top: number; height: number; scrollY: number; viewportTop: number };

/** Keep the selected row at its viewport position across commits. Account for
 * scrolling since the previous commit so this never pins the user's scroll.
 * Results keeps the selected row mounted even if an insertion moves its index
 * outside the virtual range, allowing a correction before the browser paints.
 */
export function useSelectedFlightAnchor(list: RefObject<HTMLDivElement | null>, selected: string | null, view: string) {
  const anchor = useRef<Anchor | null>(null);
  const lastView = useRef(view);
  const isAnchored = () => {
    const old = anchor.current;
    if (!old || old.key !== selected) return false;
    const top = old.top - (window.scrollY - old.scrollY);
    return top + old.height > old.viewportTop && top < window.innerHeight;
  };

  useLayoutEffect(() => {
    // A new sort or filter is a request to see the new order, not to keep your
    // place in the old one: let go, and the list goes back to its top.
    if (lastView.current !== view) { lastView.current = view; anchor.current = null; }
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

/** Where the list stands relative to what you can see: how many flights have
 * arrived above the first row on screen since you last saw that part of the
 * list, and whether the selected flight is out of view. A view change (sort or
 * filter) starts the count again, since the list returns to its top. */
export function useListAwareness(list: RefObject<HTMLDivElement | null>, rows: FlightRow[], dataset: FlightRow[],
  view: string, selected: string | null) {
  const known = useRef<Set<string> | null>(null);
  const unseen = useRef(new Set<string>());
  const lastDataset = useRef<FlightRow[] | null>(null);
  const lastView = useRef(view);
  const [state, setState] = useState({ newAbove: 0, selectedOutOfView: false });
  const positions = useMemo(() => new Map(rows.map((row, i) => [row.trip_key, i])), [rows]);

  useLayoutEffect(() => {
    if (lastView.current !== view) { lastView.current = view; unseen.current.clear(); }
    if (lastDataset.current !== dataset) {
      lastDataset.current = dataset;
      if (!dataset.length) { known.current = null; unseen.current.clear(); }
      else {
        const first = known.current === null;
        known.current ??= new Set();
        for (const row of dataset) {
          if (!first && !known.current.has(row.trip_key)) unseen.current.add(row.trip_key);
          known.current.add(row.trip_key);
        }
      }
    }
    const top = Math.max(0, document.querySelector(".results-bar")?.getBoundingClientRect().bottom ?? 0);
    let firstVisible = Infinity, selectedOutOfView = Boolean(selected);
    for (const node of list.current?.querySelectorAll<HTMLElement>(".flight[data-index]") ?? []) {
      const rect = node.getBoundingClientRect();
      if (rect.bottom <= top || rect.top >= window.innerHeight) continue;
      firstVisible = Math.min(firstVisible, Number(node.dataset.index));
      if (node.dataset.flightKey === selected) selectedOutOfView = false;
    }
    // Arrivals at or below the first row on screen are in view, or ahead of
    // you as you scroll down; only those above it can be missed.
    for (const key of unseen.current) {
      const at = positions.get(key);
      if (at === undefined || at >= firstVisible) unseen.current.delete(key);
    }
    const newAbove = unseen.current.size;
    if (newAbove !== state.newAbove || selectedOutOfView !== state.selectedOutOfView) setState({ newAbove, selectedOutOfView });
  });

  return state;
}

import { useLayoutEffect, type RefObject } from "react";

export interface FareColumnContent {
  price: string;
  origin: string;
  destination: string;
  dates: string;
  outbound: string;
  inbound: string;
  warnings: number;
}

/** Measure the entire filtered dataset, including virtualized rows. A single
 * inherited width keeps columns aligned without changing widths on scroll.
 */
export function useFareColumnWidth(list: RefObject<HTMLDivElement | null>, content: FareColumnContent[]) {
  useLayoutEffect(() => {
    const root = list.current;
    if (!root || !content.length) return;
    const probe = document.createElement("span");
    probe.className = "fare-width-probe";
    probe.setAttribute("aria-hidden", "true");
    // Static markup supplies the real typography even when a visible row has
    // no price, return leg, or duration. No flight data is inserted as HTML.
    probe.innerHTML = '<span class="fare-cell"><span class="fare-header"><span class="price"></span></span>'
      + '<span class="flight-dates"><span class="fare-route"><strong></strong><span class="icon"></span></span>'
      + '<span class="fare-date-range"></span><span class="fare-durations"><span><span class="timeline-duration"></span></span></span></span></span>';
    root.append(probe);
    const canvas = document.createElement("canvas").getContext("2d");
    if (!canvas) { probe.remove(); return; }
    const measure = () => {
      const style = (selector: string) => getComputedStyle(probe.querySelector(selector)!);
      const price = style(".price"), header = style(".fare-header"), code = style("strong"),
        route = style(".fare-route"), date = style(".fare-date-range"),
        duration = style(".timeline-duration"), durations = style(".fare-durations"), icon = style(".icon");
      const px = (value: string) => parseFloat(value) || 0;
      const cache = new Map<string, number>();
      const text = (value: string, css: CSSStyleDeclaration) => {
        // Computed `font` is empty when tabular numerals are enabled.
        const font = `${css.fontStyle} ${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
        const key = `${font}|${css.letterSpacing}|${value}`;
        if (!cache.has(key)) {
          canvas.font = font;
          cache.set(key, canvas.measureText(value).width + Math.max(0, value.length - 1) * px(css.letterSpacing));
        }
        return cache.get(key)!;
      };
      const iconWidth = px(icon.width);
      let width = 0;
      for (const row of content) {
        const returnWidth = row.inbound
          ? text("/", date) + px(durations.columnGap) + text(row.inbound, duration) + px(durations.columnGap) : 0;
        width = Math.max(width,
          text(row.price, price) + px(header.paddingLeft) + px(header.paddingRight),
          text(row.origin, code) + iconWidth + text(row.destination, code) + 2 * px(route.columnGap),
          text(row.dates, date),
          text(row.outbound, duration) + returnWidth + row.warnings * (iconWidth + px(duration.columnGap)));
      }
      root.style.setProperty("--flight-fare-width", `${Math.ceil(width)}px`);
    };
    measure();
    // Loaded fonts and responsive typography can change intrinsic widths.
    document.fonts.addEventListener("loadingdone", measure);
    window.addEventListener("resize", measure);
    return () => {
      probe.remove();
      document.fonts.removeEventListener("loadingdone", measure);
      window.removeEventListener("resize", measure);
    };
  }, [list, content]);
}

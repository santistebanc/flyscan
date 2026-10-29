import { useLayoutEffect, type RefObject } from "react";

export interface FareColumnContent {
  price: string;
  /** Icons after the price, each `.price-mark` wide. */
  marks?: number;
  dates: string;
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
    // no price or return date. No flight data is inserted as HTML.
    probe.innerHTML = '<span class="fare-cell"><span class="fare-price"><span class="price"></span><span class="price-mark"></span></span>'
      + '<span class="fare-dates"></span></span>';
    root.append(probe);
    const canvas = document.createElement("canvas").getContext("2d");
    if (!canvas) { probe.remove(); return; }
    const measure = () => {
      const price = getComputedStyle(probe.querySelector(".price")!);
      const dates = getComputedStyle(probe.querySelector(".fare-dates")!);
      const px = (value: string) => parseFloat(value) || 0;
      const mark = probe.querySelector(".price-mark")!.getBoundingClientRect().width
        + px(getComputedStyle(probe.querySelector(".fare-price")!).columnGap);
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
      let width = 0;
      for (const row of content) width = Math.max(width, text(row.price, price) + (row.marks ?? 0) * mark, text(row.dates, dates));
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

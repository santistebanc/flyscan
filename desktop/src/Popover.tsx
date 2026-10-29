import { useEffect, useLayoutEffect, useRef, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from "react";

/** Closes on a press outside every root, or on Escape before the list's own Escape sees it. */
export function useDismiss(open: boolean, close: () => void, ...roots: RefObject<HTMLElement | null>[]) {
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!roots.some((root) => root.current?.contains(event.target as Node))) close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    document.addEventListener("pointerdown", away);
    window.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", key, true);
    };
    // Refs are stable objects; their identity never needs to re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, close]);
}

/** Slides an open popover sideways until it fits the window. */
export function useKeepInView(open: boolean, panel: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const node = panel.current;
    if (!open || !node) return;
    const place = () => {
      node.style.translate = "";
      const box = node.getBoundingClientRect();
      const width = document.documentElement.clientWidth;
      let shift = box.right > width - 8 ? width - 8 - box.right : 0;
      if (box.left + shift < 8) shift = 8 - box.left;
      node.style.translate = shift ? `${shift}px 0` : "";
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  });
}

/** A labelled part of the search bar that opens its own popover. */
export function SearchSegment({ label, value, hint, open, onToggle, root, children }: {
  label: string; value: string; hint?: string; open: boolean; onToggle: () => void;
  root: RefObject<HTMLDivElement | null>; children?: ReactNode;
}) {
  return <div className="search-segment" ref={root}>
    <button type="button" className="search-segment-trigger" aria-expanded={open} aria-haspopup="dialog"
      aria-label={`${label}: ${value}${hint ? `, ${hint}` : ""}`} onClick={onToggle}>
      <span className="search-segment-label">{label}</span>
      <span className="search-segment-value"><b>{value}</b>{hint && <span>{hint}</span>}</span>
    </button>
    {open && children}
  </div>;
}

/**
 * Closes a modal dialog on a click on its backdrop. The press has to start
 * there too, so a text selection dragged out of the dialog does not close it.
 */
export function useBackdropDismiss(close: () => void) {
  const pressedOutside = useRef(false);
  const outside = (event: ReactMouseEvent<HTMLDialogElement>) => {
    if (event.target !== event.currentTarget) return false;
    const box = event.currentTarget.getBoundingClientRect();
    return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
  };
  return {
    onPointerDown: (event: ReactMouseEvent<HTMLDialogElement>) => { pressedOutside.current = outside(event); },
    onClick: (event: ReactMouseEvent<HTMLDialogElement>) => {
      if (pressedOutside.current && outside(event)) close();
      pressedOutside.current = false;
    },
  };
}

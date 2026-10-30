import { useEffect, useLayoutEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent,
  type ReactNode, type RefObject } from "react";

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

/** Keeps the option the arrow keys reached in view: a list taller than its box scrolls to it. */
export function useRevealOption(id: string | undefined) {
  useEffect(() => {
    if (id) document.getElementById(id)?.scrollIntoView({ block: "nearest" });
  }, [id]);
}

const menuItems = (menu: HTMLElement | null) =>
  Array.from(menu?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? []);

/**
 * Arrow keys, Home and End for a menu of buttons.
 *
 * Opening moves focus onto the checked item, or the first, so the keys work
 * at once; closing hands it back to whatever opened the menu, unless a click
 * elsewhere has already put it somewhere. The keys stop at the menu, so they
 * never also walk the flight list.
 */
export function useMenuKeys(open: boolean, menu: RefObject<HTMLElement | null>) {
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (open) {
      opener.current = document.activeElement as HTMLElement | null;
      const items = menuItems(menu.current);
      (items.find((item) => item.getAttribute("aria-checked") === "true") ?? items[0])?.focus();
    } else if (opener.current) {
      if (!document.activeElement || document.activeElement === document.body) opener.current.focus();
      opener.current = null;
    }
  }, [open, menu]);
  return (event: ReactKeyboardEvent<HTMLElement>) => {
    const items = menuItems(event.currentTarget);
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const to = event.key === "ArrowDown" ? (at + 1) % items.length
      : event.key === "ArrowUp" ? (at <= 0 ? items.length - 1 : at - 1)
      : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : -1;
    if (to < 0) return;
    event.preventDefault();
    event.stopPropagation();
    items[to]!.focus();
  };
}

/** ↓ or ↑ on a closed menu's button opens it, as Enter and Space already do. */
export function opensOnArrow(open: () => void) {
  return (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    event.stopPropagation();
    open();
  };
}

/**
 * A labelled part of the search bar that opens its own popover. A hint that is
 * markup rather than text says what it reads as in `hintText`.
 */
export function SearchSegment({ label, value, hint, hintText, open, onToggle, root, children }: {
  label: string; value: string; hint?: ReactNode; hintText?: string; open: boolean; onToggle: () => void;
  root: RefObject<HTMLDivElement | null>; children?: ReactNode;
}) {
  const spoken = hintText ?? (typeof hint === "string" ? hint : "");
  return <div className="search-segment" data-segment={label.toLowerCase()} ref={root}>
    <button type="button" className="search-segment-trigger" aria-expanded={open} aria-haspopup="dialog"
      aria-label={`${label}: ${value}${spoken ? `, ${spoken}` : ""}`} onClick={onToggle}>
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

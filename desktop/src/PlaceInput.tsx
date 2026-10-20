/**
 * From/To field with a suggestions dropdown.
 *
 * Looks up places through the sidecar's `/places` endpoint (Travelpayouts
 * autocomplete — the same source `resolve()` uses when scraping). Recent picks
 * sit above remote matches, matching the flyscan pattern.
 */

import {
  useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import type { FlightScraperApi, PlaceSuggestion } from "./api";
import {
  filterRecentPlaces, placeLabel, readRecentPlaces, rememberPlace,
  type RecentPlace,
} from "./recentPlaces";

interface SuggestRow {
  code: string;
  label: string;
  kind?: string;
  recent?: boolean;
}

function mergeSuggestions(recent: SuggestRow[], remote: SuggestRow[]): SuggestRow[] {
  const seen = new Set<string>();
  const out: SuggestRow[] = [];
  for (const row of [...recent, ...remote]) {
    if (seen.has(row.code)) continue;
    seen.add(row.code);
    out.push(row);
  }
  return out;
}

function toRemoteRows(matches: PlaceSuggestion[]): SuggestRow[] {
  return matches.map((p) => ({
    code: p.code,
    label: placeLabel(p.name, p.country),
    kind: p.kind,
  }));
}

function toRecentRows(matches: RecentPlace[]): SuggestRow[] {
  return matches.map((r) => ({
    code: r.code,
    label: r.label || r.code,
    recent: true,
  }));
}

export function PlaceInput({
  label, value, onChange, api, required,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  api: FlightScraperApi | null;
  required?: boolean;
}) {
  const listId = useId();
  const wrap = useRef<HTMLLabelElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const picking = useRef(false);

  const [open, setOpen] = useState(false);
  const [remote, setRemote] = useState<SuggestRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(-1);
  const [recents, setRecents] = useState<RecentPlace[]>(() => readRecentPlaces());
  const [position, setPosition] = useState({ left: 0, top: 0, width: 280 });

  const recentRows = useMemo(
    () => toRecentRows(filterRecentPlaces(recents, value)),
    [recents, value],
  );
  const suggestions = useMemo(
    () => mergeSuggestions(recentRows, remote),
    [recentRows, remote],
  );
  const show = open && (loading || suggestions.length > 0);

  useEffect(() => {
    const term = value.trim();
    if (!open || !api || term.length < 2) {
      setRemote([]);
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const matches = await api.places(term);
        if (!ctrl.signal.aborted) setRemote(toRemoteRows(matches));
      } catch {
        if (!ctrl.signal.aborted) setRemote([]);
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, 180);
    return () => {
      ctrl.abort();
      window.clearTimeout(timer);
    };
  }, [api, open, value]);

  useLayoutEffect(() => {
    if (!show || !wrap.current) return;
    const place = () => {
      const box = wrap.current?.getBoundingClientRect();
      if (!box) return;
      const width = Math.max(280, box.width);
      const left = Math.max(8, Math.min(box.left, window.innerWidth - width - 8));
      setPosition({ left, top: box.bottom + 6, width });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [show, suggestions.length, loading]);

  useEffect(() => {
    if (!show) return;
    const away = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (wrap.current?.contains(target) || list.current?.contains(target)) return;
      setOpen(false);
      setActive(-1);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [show]);

  const pick = (row: SuggestRow) => {
    picking.current = true;
    onChange(row.code);
    rememberPlace(row.code, row.label);
    setRecents(readRecentPlaces());
    setRemote([]);
    setOpen(false);
    setActive(-1);
    input.current?.blur();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      if (show) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        setActive(-1);
      }
      return;
    }
    if (!show || suggestions.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => (i + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (event.key === "Enter" && active >= 0) {
      const row = suggestions[active];
      if (!row) return;
      event.preventDefault();
      pick(row);
    }
  };

  const dropdown = show ? createPortal(
    <ul
      ref={list}
      id={listId}
      className="place-suggest"
      role="listbox"
      style={{ left: position.left, top: position.top, width: position.width }}
    >
      {suggestions.map((row, index) => (
        <li key={`${row.code}-${row.label}`} role="presentation">
          <button
            type="button"
            role="option"
            aria-selected={index === active}
            className={[
              "place-suggest-item",
              row.recent ? "place-suggest-item--recent" : "",
              index === active ? "place-suggest-item--active" : "",
            ].filter(Boolean).join(" ")}
            onMouseDown={(event) => {
              event.preventDefault();
              pick(row);
            }}
            onMouseEnter={() => setActive(index)}
          >
            <span className="place-suggest-code">{row.code}</span>
            <span className="place-suggest-label">
              <span className="place-suggest-name">{row.label}</span>
              {row.kind === "city" && <span className="place-suggest-kind">city</span>}
              {row.kind === "airport" && <span className="place-suggest-kind">airport</span>}
              {row.recent && !row.kind && <span className="place-suggest-kind">recent</span>}
            </span>
          </button>
        </li>
      ))}
      {loading && value.trim().length >= 2 && (
        <li className="place-suggest-item place-suggest-item--hint" role="presentation">
          Searching…
        </li>
      )}
    </ul>,
    document.body,
  ) : null;

  return (
    <label className={`place-field${open ? " place-field--open" : ""}`} ref={wrap}>
      {label}
      <input
        ref={input}
        value={value}
        required={required}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        role="combobox"
        aria-expanded={show}
        aria-controls={listId}
        aria-autocomplete="list"
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={(event) => {
          setRecents(readRecentPlaces());
          setOpen(true);
          event.target.select();
        }}
        onBlur={() => {
          if (picking.current) {
            picking.current = false;
            return;
          }
          setOpen(false);
          setActive(-1);
          const raw = value.trim();
          if (/^[A-Za-z]{3}$/.test(raw)) {
            const code = raw.toUpperCase();
            onChange(code);
            rememberPlace(code);
            setRecents(readRecentPlaces());
          }
        }}
        onKeyDown={onKeyDown}
      />
      {dropdown}
    </label>
  );
}

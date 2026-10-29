/**
 * From/To segment with a search popover.
 *
 * Looks up places through the sidecar's `/places` endpoint (Travelpayouts
 * autocomplete — the same source `resolve()` uses when scraping). Recent picks
 * sit above remote matches, matching the flyscan pattern. Typing a three-letter
 * code and pressing Enter takes it as written.
 */

import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { FlightScraperApi, PlaceSuggestion } from "./api";
import { useAirportCity } from "./AirportLabel";
import { SearchSegment, useDismiss, useKeepInView } from "./Popover";
import {
  filterRecentPlaces, placeLabel, readRecentPlaces, rememberPlace,
  type RecentPlace,
} from "./recentPlaces";

interface SuggestRow {
  code: string;
  name: string;
  place?: string;
  kind?: string;
  /** Offered by the caller rather than found by searching. */
  suggested?: boolean;
}

/** A place the caller already has a reason to offer, with why. */
export interface PlaceHint { code: string; note: string }

function mergeSuggestions(suggested: SuggestRow[], recent: SuggestRow[], remote: SuggestRow[]): SuggestRow[] {
  const seen = new Set<string>();
  const out: SuggestRow[] = [];
  for (const row of [...suggested, ...recent, ...remote]) {
    if (seen.has(row.code)) continue;
    seen.add(row.code);
    out.push(row);
  }
  return out;
}

const toRemoteRows = (matches: PlaceSuggestion[]): SuggestRow[] => matches.map((p) => ({
  code: p.code, name: p.name, kind: p.kind,
  place: p.city && p.city !== p.name ? placeLabel(p.city, p.country) : p.country,
}));

const toRecentRows = (matches: RecentPlace[]): SuggestRow[] =>
  matches.map((r) => ({ code: r.code, name: r.label || r.code }));

export function PlaceInput({ label, value, onChange, api, open, onToggle, suggested = [], suggestedCaption = "Suggested" }: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  api: FlightScraperApi | null;
  open: boolean;
  onToggle: (open: boolean) => void;
  /** Listed first, and kept while typing when the code or note matches. */
  suggested?: PlaceHint[];
  suggestedCaption?: string;
}) {
  const listId = useId();
  const city = useAirportCity(value);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [remote, setRemote] = useState<SuggestRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(-1);
  const [recents, setRecents] = useState<RecentPlace[]>(() => readRecentPlaces());
  const close = useCallback(() => onToggle(false), [onToggle]);
  useDismiss(open, close, root);
  useKeepInView(open, panel);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(-1);
    setRecents(readRecentPlaces());
  }, [open]);

  const term = query.trim();
  const offered = useMemo(() => {
    const needle = term.toUpperCase();
    return suggested.filter((hint) => !needle || hint.code.startsWith(needle) || hint.note.toUpperCase().includes(needle))
      .map((hint): SuggestRow => ({ code: hint.code, name: hint.note, suggested: true }));
  }, [suggested, term]);
  const suggestions = useMemo(() => mergeSuggestions(offered, toRecentRows(filterRecentPlaces(recents, term)), remote),
    [offered, recents, term, remote]);

  useEffect(() => {
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
  }, [api, open, term]);

  /** The name worth remembering: a suggestion's note says why it was offered, not what it is. */
  const nameOf = (row: SuggestRow) => row.suggested ? "" : row.place ? `${row.name}, ${row.place}` : row.name;
  const pick = (code: string, name = "") => {
    onChange(code);
    rememberPlace(code, name);
    close();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!suggestions.length) return;
      setActive((i) => event.key === "ArrowDown" ? (i + 1) % suggestions.length
        : i <= 0 ? suggestions.length - 1 : i - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = suggestions[active];
      if (row) pick(row.code, nameOf(row));
      else if (/^[A-Za-z]{3}$/.test(term)) pick(term.toUpperCase());
      else if (suggestions[0]) pick(suggestions[0].code, nameOf(suggestions[0]));
    }
  };

  const code = value.trim().toUpperCase();
  return <SearchSegment label={label} value={code || "—"} hint={city} open={open} root={root}
    onToggle={() => onToggle(!open)}>
    <div className="popover place-popover" ref={panel} role="dialog" aria-label={`Choose ${label}`}>
      <div className="place-search">
        <input autoFocus value={query} placeholder="City or airport code" role="combobox"
          aria-label={`${label} airport`} aria-expanded={suggestions.length > 0} aria-controls={listId}
          aria-autocomplete="list" autoComplete="off" spellCheck={false}
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          onChange={(event) => { setQuery(event.target.value); setActive(-1); }} onKeyDown={onKeyDown} />
      </div>
      {!term && suggestions.length > 0 && <div className="popover-caption">{suggestions[0]!.suggested ? suggestedCaption : "Recent"}</div>}
      <ul className="place-list" id={listId} role="listbox" aria-label={`${label} suggestions`}>
        {suggestions.map((row, index) => <Fragment key={row.code}>
          {!term && !row.suggested && suggestions[index - 1]?.suggested
            && <li className="popover-caption" role="presentation">Recent</li>}
          <li id={`${listId}-${index}`} role="option"
          aria-selected={index === active} className={!term ? "recent" : undefined}
          onMouseEnter={() => setActive(index)} onMouseDown={(event) => event.preventDefault()}
          onClick={() => pick(row.code, nameOf(row))}>
          <b>{row.code}</b>
          <span className="place-name">{row.name}{row.place && <span> {row.place}</span>}</span>
          {row.kind && <span className="place-kind">{row.kind}</span>}
        </li></Fragment>)}
        {loading && <li className="place-hint" role="presentation">Searching…</li>}
        {!loading && term.length >= 2 && !suggestions.length && <li className="place-hint" role="presentation">No matching airports</li>}
      </ul>
    </div>
  </SearchSegment>;
}

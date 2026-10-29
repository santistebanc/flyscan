import { useCallback, useRef } from "react";
import { SearchSegment, useDismiss, useKeepInView } from "./Popover";
import { sourceLabel } from "./queueModel";
import { toggleSource } from "./sourceSelection";

/**
 * Which sources Fetch asks and whose prices the list shows. Turning a source
 * off hides its offers without deleting them; turning it back on shows them.
 */
export function SourcesPicker({ known, disabled, open, onToggle, onChange }: {
  /** Every source the sidecar offers, in its order. Empty until it answers. */
  known: readonly { name: string; label: string; fetchable?: boolean }[];
  disabled: readonly string[];
  open: boolean; onToggle: (open: boolean) => void;
  onChange: (disabled: string[]) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = useCallback(() => onToggle(false), [onToggle]);
  useDismiss(open, close, root);
  useKeepInView(open, panel);
  const names = known.map((source) => source.name);
  const on = names.filter((name) => !disabled.includes(name));
  const value = !names.length ? "…" : on.length === names.length ? "All" : String(on.length);
  const hint = !names.length ? "sources" : on.length === names.length ? "sources"
    : on.length === 1 ? sourceLabel(on[0]!) : `of ${names.length} sources`;
  return <SearchSegment label="Sources" value={value} hint={hint} open={open} root={root}
    onToggle={() => onToggle(!open)}>
    <div className="popover align-right sources-popover" ref={panel} role="dialog" aria-label="Sources">
      {names.length ? <>
        <div className="sources-list" role="group" aria-label="Sources">
          {known.map((source) => {
            const checked = !disabled.includes(source.name);
            const last = checked && on.length === 1;
            return <label key={source.name} className="source-option" title={last ? "At least one source has to stay on" : undefined}>
              <input type="checkbox" checked={checked} disabled={last}
                onChange={() => onChange(toggleSource(names, disabled, source.name))} />
              {source.label || sourceLabel(source.name)}
              {source.fetchable === false && <span className="source-option-note">never fetched</span>}
            </label>;
          })}
        </div>
        {on.length < names.length && <button type="button" className="sources-all" onClick={() => onChange([])}>Use every source</button>}
      </> : <p className="popover-note">Waiting for the sources to load…</p>}
      <p className="popover-note">Fetch asks only the checked sources, and the list shows only their prices. Nothing stored is deleted.</p>
    </div>
  </SearchSegment>;
}

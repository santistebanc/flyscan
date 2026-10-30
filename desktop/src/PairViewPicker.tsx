import { useCallback, useRef, useState } from "react";
import { Icon } from "./Icon";
import { useDismiss } from "./Popover";
import { PAIR_VIEWS, PAIR_VIEW_LABELS, type PairView } from "./pairPicking";

const HINTS: Record<PairView, string> = {
  pairs: "Every round trip, both directions on each row",
  "outbound-first": "Pick the outbound, then one of the returns sold with it",
  "return-first": "Pick the return, then one of the outbounds sold with it",
};

/** On the button; the menu spells each view out. */
const SHORT: Record<PairView, string> = { pairs: "ALL", "outbound-first": "OUT", "return-first": "RET" };

/** "View ALL ▾": how a round-trip search is listed, as a menu like the sort variants. */
export function PairViewPicker({ view, onChange }: { view: PairView; onChange: (view: PairView) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, root);
  return <div className="view-control pair-view-picker" ref={root}>
    <button type="button" aria-haspopup="menu" aria-expanded={open} aria-label={`View: ${PAIR_VIEW_LABELS[view]}`} title={`View: ${PAIR_VIEW_LABELS[view]}`}
      onClick={() => setOpen((was) => !was)}>
      <Icon name="view" className="control-icon" />
      <span className="control-text">View <b>{SHORT[view]}</b></span> <b>▾</b>
    </button>
    {open && <div className="popover align-right sort-menu" role="menu" aria-label="View">
      {PAIR_VIEWS.map((option) => <button type="button" role="menuitemradio" key={option} aria-checked={option === view}
        title={HINTS[option]} onClick={() => { onChange(option); close(); }}>
        {PAIR_VIEW_LABELS[option]}{option === view && <Icon name="done" />}
      </button>)}
    </div>}
  </div>;
}

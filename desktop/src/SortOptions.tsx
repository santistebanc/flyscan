import { useCallback, useRef, useState } from "react";
import { Icon } from "./Icon";
import { useDismiss } from "./Popover";
import { SORT_BUTTON_LABELS, SORT_GROUPS, SORT_OPTION_LABELS, effectiveSort, sortKeysFor, type SortKey } from "./flightSort";

/** What a sort shows instead of its name when the results bar is narrow. */
const ICONS = { Best: "best", Cheapest: "price", Departure: "takeoff", Shortest: "duration" } as const;

const TITLES: Partial<Record<SortKey, string>> = {
  best: "Balances price and total travel time, including the return and layovers",
  duration: "Total travel time, including the return and layovers",
};

/**
 * One button per sort, with a menu on those that have variants. The button
 * sorts by the variant shown on it, the one last chosen from its menu.
 */
export function SortOptions({ sort, onChange, roundTrip }: {
  sort: SortKey; onChange: (key: SortKey) => void; roundTrip: boolean;
}) {
  const current = effectiveSort(sort, roundTrip);
  const [chosen, setChosen] = useState<Record<string, SortKey>>({});
  const [menu, setMenu] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setMenu(null), []);
  useDismiss(menu !== null, close, root);
  return <div className="sort-options" role="group" aria-label="Sort by" ref={root}>
    {SORT_GROUPS.map((group) => {
      const keys = sortKeysFor(roundTrip, group.keys);
      const active = keys.includes(current);
      const remembered = chosen[group.label];
      const shown = active ? current : remembered && keys.includes(remembered) ? remembered : keys[0]!;
      const pick = (key: SortKey) => { setChosen((old) => ({ ...old, [group.label]: key })); onChange(key); setMenu(null); };
      return <span key={group.label} className="sort-option" data-active={active || undefined}>
        <button type="button" aria-pressed={active} title={TITLES[shown] ?? SORT_BUTTON_LABELS[shown]} onClick={() => pick(shown)}>
          <Icon name={ICONS[group.label as keyof typeof ICONS]} className="control-icon" />
          <span className="control-text">{SORT_BUTTON_LABELS[shown]}</span>
        </button>
        {keys.length > 1 && <button type="button" className="sort-menu-toggle" aria-label={`${group.label} sort options`}
          aria-haspopup="menu" aria-expanded={menu === group.label}
          onClick={() => setMenu((open) => open === group.label ? null : group.label)}><Icon name="chevron-down" /></button>}
        {menu === group.label && <div className="popover align-right sort-menu" role="menu" aria-label={`${group.label} sort options`}>
          {keys.map((key) => <button type="button" role="menuitemradio" key={key} aria-checked={key === current} onClick={() => pick(key)}>
            {SORT_OPTION_LABELS[key]}{key === current && <Icon name="done" />}
          </button>)}
        </div>}
      </span>;
    })}
  </div>;
}

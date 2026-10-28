import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useCurrency } from "./currency";
import { currencySuggestions, resolveCurrency } from "./currencyOptions";
import { Icon } from "./Icon";
import { openExternal } from "./platform";
import { useDismiss } from "./Popover";

/** "Prices EUR ▾": a view setting, searchable because the list is long. */
export function CurrencyInput() {
  const { currency, setCurrency, currencies, loadingRates, rateProvider, ratesUpdatedAt } = useCurrency();
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [position, setPosition] = useState({ left: 12, top: 0, maxHeight: 360 });
  const { items, noMatches } = useMemo(() => currencySuggestions(currencies, query), [currencies, query]);
  const selected = items[active];
  const close = useCallback(() => { setOpen(false); setQuery(""); setActive(-1); }, []);
  // The panel is portalled, so "outside" has to exclude it as well as the trigger.
  useDismiss(open, close, root, panel);

  useEffect(() => {
    if (open && selected) document.getElementById(`${id}-${selected.code}`)?.scrollIntoView({ block: "nearest" });
  }, [id, open, selected]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const box = trigger.current?.getBoundingClientRect();
      if (!box) return;
      const width = Math.min(304, innerWidth - 24);
      const top = box.bottom + 8;
      setPosition({ left: Math.max(12, Math.min(box.right - width, innerWidth - width - 12)),
        top, maxHeight: Math.max(160, Math.min(360, innerHeight - top - 12)) });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);

  const pick = (code: string) => {
    setCurrency(code);
    close();
    trigger.current?.focus();
  };
  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!items.length) return;
      setActive((old) => event.key === "ArrowDown" ? (old + 1) % items.length
        : old <= 0 ? items.length - 1 : old - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const code = selected?.code || resolveCurrency(currencies, query)
        || (!noMatches && query.trim() ? items[0]?.code : undefined);
      if (code) pick(code);
    }
  };
  const updated = ratesUpdatedAt && !Number.isNaN(Date.parse(ratesUpdatedAt))
    ? new Date(ratesUpdatedAt).toLocaleDateString("en", { month: "short", day: "numeric" }) : "";
  const provider = rateProvider === "open.er-api.com"
    ? { name: "ExchangeRate-API", url: "https://www.exchangerate-api.com" }
    : rateProvider === "frankfurter" ? { name: "Frankfurter", url: "https://frankfurter.dev" } : null;

  return <div className="view-control currency-field" ref={root}>
    <button type="button" ref={trigger} aria-haspopup="dialog" aria-expanded={open}
      aria-label={`Show prices in ${currency}`} onClick={() => open ? close() : setOpen(true)}>
      Prices <b>{currency} ▾</b>
    </button>
    {open && createPortal(<div ref={panel} className="popover currency-suggest" role="dialog"
      aria-label="Show prices in" style={position}>
      <div className="currency-search">
        <input autoFocus role="combobox" value={query} placeholder="Search currencies" aria-expanded
          aria-controls={`${id}-list`} aria-autocomplete="list" aria-label="Search currencies"
          aria-activedescendant={selected ? `${id}-${selected.code}` : undefined}
          autoComplete="off" spellCheck={false}
          onChange={(event) => { setQuery(event.target.value); setActive(-1); }} onKeyDown={keys} />
      </div>
      {noMatches && <p className="currency-hint" role="status">No matches. Common currencies:</p>}
      {loadingRates && <p className="currency-hint" role="status">Loading currencies…</p>}
      <ul id={`${id}-list`} role="listbox" aria-label="Currencies">
        {items.map((option, index) => <li key={option.code} id={`${id}-${option.code}`} role="option"
          aria-selected={currency === option.code} className={index === active ? "currency-option active" : "currency-option"}
          onMouseEnter={() => setActive(index)} onMouseDown={(event) => event.preventDefault()}
          onClick={() => pick(option.code)}>
          <span className="currency-code">{option.code}</span><span className="currency-name">{option.name}</span>
          {currency === option.code && <Icon name="done" />}
        </li>)}
      </ul>
      <div className="currency-rate-source">
        {provider ? <span>Stored prices stay in EUR. Rates: <a href={provider.url} target="_blank" rel="noreferrer"
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => { event.preventDefault(); void openExternal(provider.url); }}>{provider.name}</a>
          {updated && <span title={`Rates fetched ${new Date(ratesUpdatedAt).toLocaleString()}`}>, {updated}</span>}</span>
          : !loadingRates && <span>Rates unavailable · prices shown in EUR</span>}
      </div>
    </div>, document.body)}
  </div>;
}

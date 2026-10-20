import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useCurrency } from "./currency";
import { currencySuggestions, resolveCurrency } from "./currencyOptions";
import { Icon } from "./Icon";
import { openExternal } from "./platform";

export function CurrencyInput() {
  const { currency, setCurrency, currencies, loadingRates, rateProvider, ratesUpdatedAt } = useCurrency();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLLabelElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(currency);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [position, setPosition] = useState({ left: 12, top: 0, maxHeight: 320 });
  const { items, noMatches } = useMemo(() => currencySuggestions(currencies, query), [currencies, query]);
  const selected = items[active];

  useEffect(() => { if (!open) setDraft(currency); }, [currency, open]);
  useEffect(() => {
    if (open && selected) document.getElementById(`${id}-${selected.code}`)?.scrollIntoView({ block: "nearest" });
  }, [id, open, selected]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const box = root.current?.getBoundingClientRect();
      if (!box) return;
      const width = Math.min(304, innerWidth - 24);
      const right = Math.min(innerWidth, root.current?.closest(".results-bar")?.getBoundingClientRect().right ?? innerWidth);
      const below = innerHeight - box.bottom - 20;
      const height = Math.min(320, panel.current?.scrollHeight || 320);
      const top = below >= Math.min(height, 160) || below >= box.top - 20
        ? box.bottom + 8 : Math.max(12, box.top - height - 8);
      setPosition({ left: Math.max(12, Math.min(box.right - width, right - width - 12)),
        top, maxHeight: Math.max(80, Math.min(320, innerHeight - top - 12)) });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, items.length, noMatches]);

  const close = () => { setOpen(false); setDraft(currency); setQuery(""); setActive(-1); };
  const pick = (code: string) => {
    setCurrency(code);
    setDraft(code);
    setOpen(false);
    setQuery("");
    setActive(-1);
  };
  const commit = () => {
    const code = resolveCurrency(currencies, draft);
    if (code) pick(code);
    else close();
  };
  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      if (open) { event.preventDefault(); event.stopPropagation(); close(); }
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActive((old) => event.key === "ArrowDown" ? (old + 1) % items.length
        : old <= 0 ? items.length - 1 : old - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const code = selected?.code || resolveCurrency(currencies, draft)
        || (!noMatches && query.trim() ? items[0]?.code : undefined);
      if (code) pick(code);
    }
  };
  const updated = ratesUpdatedAt && !Number.isNaN(Date.parse(ratesUpdatedAt))
    ? new Date(ratesUpdatedAt).toLocaleDateString("en", { month: "short", day: "numeric" }) : "";
  const provider = rateProvider === "open.er-api.com"
    ? { name: "ExchangeRate-API", url: "https://www.exchangerate-api.com" }
    : rateProvider === "frankfurter" ? { name: "Frankfurter", url: "https://frankfurter.dev" } : null;

  return <label className="currency-field" ref={root}>
    <span className="sr-only">Show prices in</span>
    <input ref={input} role="combobox" value={draft} aria-expanded={open}
      aria-controls={`${id}-list`} aria-autocomplete="list"
      aria-activedescendant={open && selected ? `${id}-${selected.code}` : undefined}
      autoComplete="off" autoCapitalize="characters" spellCheck={false}
      title="Search currencies by code or name"
      onFocus={(event) => { setQuery(""); setActive(-1); setOpen(true); event.target.select(); }}
      onClick={() => { if (!open) { setOpen(true); setQuery(""); } }}
      onChange={(event) => { setDraft(event.target.value); setQuery(event.target.value); setActive(-1); setOpen(true); }}
      onBlur={commit} onKeyDown={keys} />
    <Icon name="chevron-down" />
    {open && createPortal(<div ref={panel} className="currency-suggest" style={position}>
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
        {provider ? <><a href={provider.url} target="_blank" rel="noreferrer" onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => { event.preventDefault(); void openExternal(provider.url); }}>{provider.name}</a>
          {updated && <span title={`Rates fetched ${new Date(ratesUpdatedAt).toLocaleString()}`}>{updated}</span>}</>
          : !loadingRates && <span>Rates unavailable · prices shown in EUR</span>}
      </div>
    </div>, document.body)}
  </label>;
}

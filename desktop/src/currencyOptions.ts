export interface CurrencyOption { code: string; name: string }
export const COMMON_CURRENCIES = ["EUR", "USD", "GBP", "MXN", "CAD", "AUD", "JPY", "CHF", "CNY", "INR"];
const names = new Intl.DisplayNames(["en"], { type: "currency" });

export function validRates(raw: Record<string, number>): Record<string, number> {
  const rates: Record<string, number> = { EUR: 1 };
  for (const [code, rate] of Object.entries(raw)) {
    if (/^[A-Z]{3}$/.test(code) && Number.isFinite(rate) && rate > 0) rates[code] = rate;
  }
  rates.EUR = 1;
  return rates;
}

export function currencyOptions(rates: Record<string, number>): CurrencyOption[] {
  return Object.keys(validRates(rates)).sort((a, b) => {
    const aCommon = COMMON_CURRENCIES.indexOf(a), bCommon = COMMON_CURRENCIES.indexOf(b);
    return (aCommon < 0 ? Infinity : aCommon) - (bCommon < 0 ? Infinity : bCommon) || a.localeCompare(b);
  }).map((code) => ({ code, name: names.of(code) || code }));
}

export function currencySuggestions(options: CurrencyOption[], text: string) {
  const query = text.trim().toLocaleLowerCase();
  if (!query) return { items: options, noMatches: false };
  const rank = (option: CurrencyOption) => option.code.toLowerCase() === query ? 0
    : option.code.toLowerCase().startsWith(query) ? 1 : option.name.toLowerCase().startsWith(query) ? 2 : 3;
  const matches = options.filter(({ code, name }) => `${code} ${name}`.toLowerCase().includes(query))
    .sort((a, b) => rank(a) - rank(b));
  return { items: matches.length ? matches : options.filter(({ code }) => COMMON_CURRENCIES.includes(code)),
    noMatches: matches.length === 0 };
}

export function resolveCurrency(options: CurrencyOption[], text: string): string | undefined {
  const query = text.trim().toLowerCase();
  return options.find(({ code, name }) => code.toLowerCase() === query || name.toLowerCase() === query)?.code;
}

/** Never label an unchanged EUR amount as a currency whose rate is unavailable. */
export function displayCurrency(rates: Record<string, number>, requested: string) {
  const code = requested.trim().toUpperCase();
  const rate = rates[code];
  return /^[A-Z]{3}$/.test(code) && typeof rate === "number" && Number.isFinite(rate) && rate > 0
    ? { currency: code, rate } : { currency: "EUR", rate: 1 };
}

export function formatCurrencyAmount(amount: number, code: string): string {
  return new Intl.NumberFormat("en", { style: "currency", currency: code,
    minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(amount);
}

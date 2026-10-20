const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const path = require("node:path");
const { buildSync } = require("esbuild");
const code = buildSync({ entryPoints: [path.join(__dirname, "../src/currencyOptions.ts")],
  bundle: true, write: false, format: "cjs", platform: "node" }).outputFiles[0].text;
const mod = { exports: {} };
vm.runInNewContext(code, { module: mod, exports: mod.exports });
const { currencyOptions, currencySuggestions, resolveCurrency, validRates, displayCurrency, formatCurrencyAmount } = mod.exports;
const rates = { EUR: 1, USD: 1.12, GBP: 0.85, MXN: 20.7, JPY: 160, AED: 4.1, CAD: 1.5, ZAR: 20 };
const codes = (items) => Array.from(items, (item) => item.code);

test("all available currencies are offered, with common currencies first", () => {
  const options = currencyOptions(rates);
  assert.equal(options.length, Object.keys(rates).length);
  assert.deepEqual(codes(options), ["EUR", "USD", "GBP", "MXN", "CAD", "JPY", "AED", "ZAR"]);
  assert.deepEqual(codes(currencySuggestions(options, "").items), codes(options));
  assert.equal(options.find((option) => option.code === "MXN").name, "Mexican Peso");
});

test("search matches currency names and codes case-insensitively", () => {
  const options = currencyOptions(rates);
  assert.deepEqual(codes(currencySuggestions(options, " mxn ").items), ["MXN"]);
  assert.deepEqual(codes(currencySuggestions(options, "mexican").items), ["MXN"]);
  assert.deepEqual(codes(currencySuggestions(options, "dollar").items), ["USD", "CAD"]);
  assert.equal(resolveCurrency(options, "mxn"), "MXN");
  assert.equal(resolveCurrency(options, "Mexican Peso"), "MXN");
});

test("no matches offers common currencies without accepting the unmatched input", () => {
  const options = currencyOptions(rates);
  const result = currencySuggestions(options, "not a currency");
  assert.equal(result.noMatches, true);
  assert.deepEqual(codes(result.items), ["EUR", "USD", "GBP", "MXN", "CAD", "JPY"]);
  assert.equal(resolveCurrency(options, "not a currency"), undefined);
  assert.equal(resolveCurrency(options, "ABC"), undefined);
});

test("invalid or missing provider rates cannot be selected or masquerade as EUR conversion", () => {
  const sanitized = validRates({ EUR: 999, USD: 0, GBP: -1, MXN: NaN, CHF: Infinity, invalid: 1, JPY: 160 });
  assert.deepEqual(codes(currencyOptions(sanitized)), ["EUR", "JPY"]);
  assert.equal(sanitized.EUR, 1);
  for (const requested of ["USD", "GBP", "MXN", "CHF", "__proto__", ""]) {
    const selected = displayCurrency(sanitized, requested);
    assert.equal(selected.currency, "EUR");
    assert.equal(selected.rate, 1);
  }
  assert.equal(displayCurrency({ EUR: 1 }, "USD").currency, "EUR");
});

test("conversions use provider rates and currency-specific formatting", () => {
  const selected = displayCurrency(rates, "mxn");
  assert.equal(selected.currency, "MXN");
  assert.equal(selected.rate, 20.7);
  assert.equal(Math.round(100 * selected.rate), 2070);
  assert.equal((2070 / selected.rate).toFixed(2), "100.00");
  assert.equal(formatCurrencyAmount(100, "EUR"), "€100");
  assert.equal(formatCurrencyAmount(112, "USD"), "$112");
  assert.match(formatCurrencyAmount(2070, "MXN"), /2,070/);
  assert.match(formatCurrencyAmount(150, "CAD"), /CA\$/);
});

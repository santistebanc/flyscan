const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const path = require("node:path");
const { buildSync } = require("esbuild");
const code = buildSync({ entryPoints: [path.join(__dirname, "../src/flightSort.ts")],
  bundle: true, write: false, format: "cjs", platform: "node" }).outputFiles[0].text;
const mod = { exports: {} };
vm.runInNewContext(code, { module: mod, exports: mod.exports });
const { sortFlightRows, DEFAULT_SORT, SORT_LABELS } = mod.exports;
const row = (id, price, duration, extra = {}) => ({ trip_key: id,
  best: { price_base: price }, duration, return_duration: "", return_date: "",
  departure: "2026-12-11T10:00", depart_date: "2026-12-11", stops: 0, ...extra });
const keys = (rows, sort = "best") => Array.from(sortFlightRows(rows, sort), (r) => r.trip_key);

test("Best is the default and favors a reasonable price/time balance", () => {
  assert.equal(DEFAULT_SORT, "best");
  assert.equal(SORT_LABELS.best, "Best");
  const rows = [row("cheap-slow", 80, "12h"), row("fast-expensive", 400, "2h"), row("balanced", 120, "3h")];
  assert.deepEqual(keys(rows), ["balanced", "fast-expensive", "cheap-slow"]);
  assert.deepEqual(rows.map((r) => r.trip_key), ["cheap-slow", "fast-expensive", "balanced"], "sorting leaves input order intact");
});

test("Best counts the return and long connections in the total source duration", () => {
  const back = { return_date: "2026-12-19" };
  const rows = [row("long-return", 120, "2h", { ...back, return_duration: "12h" }),
    row("short-both-ways", 150, "3h", { ...back, return_duration: "3h" })];
  assert.deepEqual(keys(rows), ["short-both-ways", "long-return"]);
  const shifted = rows.map((r) => ({ ...r, departure: "2026-12-11T23:00-10:00", arrival: "2026-12-10T01:00+14:00" }));
  assert.deepEqual(keys(shifted), keys(rows), "local clock differences cannot change elapsed-duration ranking");
});

test("missing price or duration cannot make incomplete itineraries look best", () => {
  const rows = [row("missing-return", 10, "1h", { return_date: "2026-12-19" }),
    row("missing-duration", 5, ""), row("missing-price", null, "1h"),
    row("invalid-price", NaN, "1h"), row("zero-price", 0, "1h"), row("complete", 100, "2h")];
  assert.equal(keys(rows)[0], "complete");
  assert.deepEqual(keys([]), []);
});

test("new results participate immediately without outliers or currency changing existing ranks", () => {
  const rows = [row("a", 100, "4h"), row("b", 150, "2h"), row("c", 90, "5h")];
  const expected = keys(rows);
  assert.deepEqual(keys(rows.map((r) => ({ ...r, best: { price_base: r.best.price_base * 1.37 } }))), expected);
  const updated = keys([...rows, row("outlier", 10000, "100h"), row("new-best", 80, "2h")]);
  assert.equal(updated[0], "new-best");
  assert.deepEqual(updated.filter((id) => expected.includes(id)), expected);
});

test("ties prefer lower prices and stay stable across incoming row order", () => {
  const rows = [row("fast", 200, "2h"), row("cheap-b", 100, "4h"), row("cheap-a", 100, "4h")];
  assert.deepEqual(keys(rows), ["cheap-a", "cheap-b", "fast"]);
  assert.deepEqual(keys([...rows].reverse()), keys(rows));
});

test("the existing explicit sorting options keep their behavior", () => {
  const rows = [row("cheap", 80, "4h", { departure: "2026-12-11T12:00", stops: 1 }),
    row("early", 150, "3h", { departure: "2026-12-11T06:00", stops: 0 }),
    row("short", 200, "2h", { departure: "2026-12-11T09:00", stops: 0 })];
  assert.deepEqual(keys(rows, "price"), ["cheap", "early", "short"]);
  assert.deepEqual(keys(rows, "depart"), ["early", "short", "cheap"]);
  assert.deepEqual(keys(rows, "duration"), ["short", "early", "cheap"]);
  assert.deepEqual(keys(rows, "stops"), ["early", "short", "cheap"]);
});

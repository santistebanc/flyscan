const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildSync } = require("esbuild");
const vm = require("node:vm");
const path = require("node:path");
const code = buildSync({ stdin: { contents: `
  export { connectionFilterOptions, filterRanges, roundLimitPresets } from './src/filterSuggestions';
  export { OPEN_FILTERS } from './src/flightFilters';
  export { flightTimelines } from './src/flightTimeline';
`, resolveDir: path.join(__dirname, "..") },
  bundle: true, write: false, format: "cjs", platform: "node" }).outputFiles[0].text;
const mod = { exports: {} };
vm.runInNewContext(code, { module: mod, exports: mod.exports });
const { connectionFilterOptions, OPEN_FILTERS, filterRanges, roundLimitPresets, flightTimelines } = mod.exports;
const plain = (value) => JSON.parse(JSON.stringify(value));
const leg = (duration, departure = "2026-11-03T06:15", arrival = "2026-11-03T07:20") => ({
  origin_airport: "BER", destination_airport: "LHR", duration, departure, arrival, stops: 0, segments: [],
});
const row = (price, duration, extra = {}) => ({ best: { price_base: price }, duration, return_duration: "",
  outbound: leg(duration), inbound: null, ...extra });

const connecting = (wait, price, stops = 1) => {
  const clock = (minutes) => new Date(Date.UTC(2026, 10, 3, 9) + minutes * 60000).toISOString().slice(0, 16);
  return row(price, `${120 + wait}m`, { outbound: { ...leg(`${120 + wait}m`), stops, segments: [
    { origin: "BER", destination: "LHR", departure: clock(-60), arrival: clock(0), duration: "1h" },
    { origin: "LHR", destination: "MAD", departure: clock(wait), arrival: clock(wait + 60), duration: "1h" },
  ] } });
};
/** Limits for both directions at once, as a filter edited together sets them. */
const both = (patch) => ({ outbound: { ...OPEN_FILTERS.outbound, ...patch }, inbound: { ...OPEN_FILTERS.inbound, ...patch } });
const options = (rows, changes = {}, directional = {}) =>
  connectionFilterOptions(rows, { ...OPEN_FILTERS, maxPrice: null, ...changes, ...both(directional) }, (r) => r.best.price_base);
/** The choices for a limit set on both directions. */
const shared = (result) => { const { stops, layoverMinutes } = plain(result); return { stops, layoverMinutes }; };

test("connection options hide empty caps, use maximum semantics and include return connections", () => {
  const eight = connecting(480, 100);
  assert.deepEqual(shared(options([eight])), { stops: [1], layoverMinutes: [480, 720, 960] });
  const round = row(100, "2h", { inbound: connecting(900, 100, 2).outbound });
  assert.deepEqual(shared(options([round])), { stops: [2], layoverMinutes: [960] });
  assert.deepEqual(plain(options([connecting(180, 100)]).layoverMinutes), [360, 480, 720, 960]);
});

test("connection options respect other filters while removing their own cap", () => {
  const rows = [connecting(480, 100), connecting(240, 200, 2)];
  assert.deepEqual(shared(options(rows, { maxPrice: 150 }, { maxLayoverMinutes: 360 })), { stops: [], layoverMinutes: [480, 720, 960] });
  assert.deepEqual(shared(options(rows, {}, { maxStops: 1 })), { stops: [1, 2], layoverMinutes: [480, 720, 960] });
  assert.deepEqual(shared(options(rows, {}, { maxDurationMinutes: 100 })), { stops: [], layoverMinutes: [] });
});

test("empty and nonstop-only results do not invent layover choices", () => {
  assert.deepEqual(shared(options([])), { stops: [], layoverMinutes: [] });
  assert.deepEqual(shared(options([row(100, "2h")])), { stops: [0], layoverMinutes: [] });
});

test("price quick limits keep useful groups instead of the single cheapest flight or every flight", () => {
  const prices = [41, 50, 55, 60, 70, 80, 90, 100, 110, 10000];
  const ranges = filterRanges(prices.map((price) => row(price, "2h")));
  const presets = ranges.limits.priceEur;
  assert.ok(presets.length > 0);
  for (const cap of presets) {
    const count = prices.filter((price) => price <= cap).length;
    assert.ok(count >= 2 && count < prices.length, `€${cap} retains ${count} flights`);
  }
  assert.deepEqual(plain(presets), [55, 70, 100], "an expensive outlier must not dictate all cutoffs");
});

test("short-haul suggestions use actual price and duration extremes with only observed stop counts", () => {
  const ranges = filterRanges([row(54, "2h 05m"), row(100, "1h 50m"), row(207, "1h 45m")]);
  assert.deepEqual(plain(ranges.priceEur), { min: 54, max: 207 });
  assert.deepEqual(plain(ranges.durationMinutes), { min: 105, max: 125 });
  assert.deepEqual(plain(ranges.limits), { priceEur: [100], durationMinutes: [110], layoverMinutes: [] });
  assert.deepEqual(plain(ranges.stops), [0]);
  assert.equal(ranges.layoverMinutes, null);
});

test("round-trip caps use the longest direction and the actual airport-transfer connection", () => {
  const inbound = require("./fixtures/jetradar-airport-transfer.json");
  const ranges = filterRanges([
    row(1230, "32h 11m", { inbound, return_duration: inbound.duration }),
    row(1500, "2h", { inbound: leg("8h"), return_duration: "8h" }),
  ]);
  assert.deepEqual(plain(ranges.durationMinutes), { min: 480, max: 2992 });
  assert.deepEqual(plain(ranges.layoverMinutes), { min: 1384, max: 1384 });
  assert.deepEqual(plain(ranges.stops), [0, 4]);
});

test("new offscreen extrema update suggestions while sorting cannot change them", () => {
  const rows = Array.from({ length: 350 }, () => row(100, "2h"));
  assert.deepEqual(plain(filterRanges(rows).priceEur), { min: 100, max: 100 });
  rows.push(row(900, "30h"));
  const ranges = filterRanges(rows);
  assert.deepEqual(plain(ranges.priceEur), { min: 100, max: 900 });
  assert.deepEqual(plain(ranges.limits.priceEur), [100], "a tied minimum can be useful when it keeps 350 flights");
  assert.deepEqual(plain(filterRanges([...rows].reverse())), plain(ranges));
});

test("empty, missing, and invalid data produce no invented suggestions", () => {
  const empty = filterRanges([]);
  const missing = filterRanges([{ best: { price_base: NaN }, duration: "unknown", inbound: null,
    outbound: { duration: "", departure: "bad", arrival: "", stops: null, segments: [] } }]);
  assert.deepEqual(plain(missing), plain(empty));
  assert.equal(empty.priceEur, null);
});

test("small or identical datasets do not invent useful limits", () => {
  for (const rows of [[], [row(41, "2h")], [row(41, "2h"), row(100, "4h")],
    Array.from({ length: 20 }, () => row(41, "2h"))]) {
    assert.deepEqual(plain(filterRanges(rows).limits), { priceEur: [], durationMinutes: [], layoverMinutes: [] });
  }
});

test("ties are counted together and quick limits remain unique", () => {
  const prices = [41, 41, 41, 60, 60, 80, 80, 80, 100, 100];
  const limits = filterRanges(prices.map((price) => row(price, "2h"))).limits.priceEur;
  assert.deepEqual(plain(limits), [41, 60, 80]);
  for (const limit of limits) {
    const count = prices.filter((price) => price <= limit).length;
    assert.ok(count >= 2 && count < prices.length);
  }
});

test("journey and connection quick limits also follow result groups rather than extrema", () => {
  const clock = (minutes) => new Date(Date.UTC(2026, 10, 3, 9) + minutes * 60000).toISOString().slice(0, 16);
  const rows = [15, 30, 45, 60, 90, 120, 180, 240, 360, 1440].map((wait, i) => {
    const duration = `${120 + wait}m`;
    return row(100 + i, duration, { outbound: { ...leg(duration), stops: 1, segments: [
      { origin: "BER", destination: "LHR", departure: "2026-11-03T08:00", arrival: clock(0), duration: "1h" },
      { origin: "LHR", destination: "MAD", departure: clock(wait), arrival: clock(wait + 60), duration: "1h" },
    ] } });
  });
  const ranges = filterRanges(rows);
  assert.deepEqual(plain(ranges.limits.durationMinutes), [165, 210, 360]);
  assert.deepEqual(plain(ranges.limits.layoverMinutes), [45, 90, 240]);
});

test("readable rounding and currency conversion cannot produce duplicate or all-results quick limits", () => {
  assert.deepEqual(plain(roundLimitPresets([41, 43, 61], 70, 5)), [45, 65]);
  assert.deepEqual(plain(roundLimitPresets([41, 43, 61], 65, 5)), [45]);
  assert.deepEqual(plain(roundLimitPresets([41, 43], 43, 10)), []);
  assert.deepEqual(plain(roundLimitPresets([41, 43, 61].map((price) => Math.round(price * 20.7)), 1449, 100)), [900, 1300]);
  assert.deepEqual(plain(roundLimitPresets([], null)), []);
});

test("reusing timeline connections gives the same suggestions as directly reading the flights", () => {
  const inbound = require("./fixtures/jetradar-airport-transfer.json");
  const rows = [row(1230, "32h 11m", { inbound, return_duration: inbound.duration }), row(100, "2h")];
  assert.deepEqual(plain(filterRanges(rows, flightTimelines(rows).journeys)), plain(filterRanges(rows)));
});

test("each direction offers the stops and connections of its own legs", () => {
  const round = row(100, "2h", { inbound: connecting(900, 100, 2).outbound, outbound: connecting(480, 100).outbound });
  const result = plain(options([round]));
  assert.deepEqual(result.outbound, { stops: [1], layoverMinutes: [480, 720, 960] });
  assert.deepEqual(result.inbound, { stops: [2], layoverMinutes: [960] });
  assert.deepEqual(shared(result), { stops: [2], layoverMinutes: [960] }, "both at once must admit the busier leg");
  // A return capped on its own leaves the outbound choices as they were.
  const capped = plain(connectionFilterOptions([round], { ...OPEN_FILTERS, maxPrice: null,
    inbound: { ...OPEN_FILTERS.inbound, maxStops: 1 } }, (r) => r.best.price_base));
  assert.deepEqual(capped.inbound.stops, [2]);
  assert.deepEqual(capped.outbound.stops, [], "the outbound list keeps the return cap, which this trip breaks");
});

test("duration suggestions are kept for each direction alone", () => {
  const ranges = filterRanges([
    row(100, "2h", { inbound: leg("10h"), return_duration: "10h" }),
    row(120, "3h", { inbound: leg("12h"), return_duration: "12h" }),
    row(140, "4h", { inbound: leg("14h"), return_duration: "14h" }),
  ]);
  assert.deepEqual(plain(ranges.outbound.durationMinutes), { min: 120, max: 240 });
  assert.deepEqual(plain(ranges.inbound.durationMinutes), { min: 600, max: 840 });
  assert.deepEqual(plain(ranges.durationMinutes), { min: 600, max: 840 }, "both at once count the longer direction");
});

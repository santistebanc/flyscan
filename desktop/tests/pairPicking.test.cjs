const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const path = require("node:path");
const { buildSync } = require("esbuild");
const code = buildSync({ entryPoints: [path.join(__dirname, "../src/pairPicking.ts")],
  bundle: true, write: false, format: "cjs", platform: "node" }).outputFiles[0].text;
const mod = { exports: {} };
vm.runInNewContext(code, { module: mod, exports: mod.exports });
const plain = (value) => JSON.parse(JSON.stringify(value));
const { pickGroups, pairsOf, legKey, stepSort, nextPairView, normalizePairView, firstDirection } = mod.exports;

const leg = (flight, departure, arrival, duration = "3h") => ({ origin_airport: "BER", destination_airport: "LIM",
  departure, arrival, duration, stops: 0, airlines: "", flight_numbers: flight, segments: [] });
const pair = (id, price, out, back, extra = {}) => ({ trip_key: id, best: { price_base: price },
  depart_date: out.departure.slice(0, 10), departure: out.departure, arrival: out.arrival, duration: out.duration,
  outbound: out, inbound: back, return_date: back ? back.departure.slice(0, 10) : "2026-11-23",
  return_duration: back ? back.duration : "", stops: 0, ...extra });

const early = leg("LH1", "2026-11-14T08:10", "2026-11-14T11:45");
const late = leg("LH2", "2026-11-14T22:40", "2026-11-15T09:15");
const evening = leg("LH9", "2026-11-23T16:30", "2026-11-24T07:55");
const morning = leg("LH8", "2026-11-23T09:05", "2026-11-24T04:20");
const rows = [
  pair("early-evening", 412, early, evening),
  pair("early-morning", 455, early, morning),
  pair("late-evening", 471, late, evening),
  pair("early-undetailed", 398, early, null),
];

test("the outbound list has one entry per outbound flight with the price range of its pairs", () => {
  const groups = pickGroups(rows, "outbound", "price");
  assert.deepEqual(plain(groups.map((g) => [g.leg.flight_numbers, g.low, g.high, g.pairs.length])),
    [["LH1", 398, 455, 3], ["LH2", 471, 471, 1]]);
});

test("the same flight on another date is another choice", () => {
  const nextDay = leg("LH1", "2026-11-15T08:10", "2026-11-15T11:45");
  const groups = pickGroups([...rows, pair("next-day", 500, nextDay, evening)], "outbound", "price");
  assert.equal(groups.length, 3);
});

test("picking the return first groups undetailed returns by their return date", () => {
  const groups = pickGroups(rows, "inbound", "price");
  assert.deepEqual(plain(groups.map((g) => [g.leg?.flight_numbers ?? `undetailed ${g.date}`, g.pairs.length])),
    [["undetailed 2026-11-23", 1], ["LH9", 2], ["LH8", 1]]);
});

test("the second step lists only pairs quoted with the picked flight, sorted for the other direction", () => {
  const picked = legKey(rows[0], "outbound");
  assert.deepEqual(plain(pairsOf(rows, picked, "outbound", "depart").map((r) => r.trip_key)),
    ["early-morning", "early-evening", "early-undetailed"], "Departure sorts by the return's departure");
  assert.deepEqual(rows.map((r) => r.trip_key), ["early-evening", "early-morning", "late-evening", "early-undetailed"],
    "grouping leaves input order intact");
});

test("each step's sort reads the one-way choice as being about its own direction", () => {
  assert.equal(stepSort("depart", "inbound"), "return-depart");
  assert.equal(stepSort("return-arrive", "outbound"), "arrive");
  assert.equal(stepSort("duration", "inbound"), "duration-return");
  assert.equal(stepSort("duration-return", "outbound"), "duration-outbound");
  assert.equal(stepSort("best", "inbound"), "best");
});

test("the view cycles All pairs, Outbound first, Return first and falls back to All pairs", () => {
  assert.equal(nextPairView("pairs"), "outbound-first");
  assert.equal(nextPairView("outbound-first"), "return-first");
  assert.equal(nextPairView("return-first"), "pairs");
  assert.equal(normalizePairView("nonsense"), "pairs");
  assert.equal(firstDirection("return-first"), "inbound");
  assert.equal(firstDirection("pairs"), null);
});

test("a pinned flight the filters leave without pairs stays pinned with no price", () => {
  const picked = legKey(rows[2], "outbound");
  const group = mod.exports.pickedGroup([rows[0]], rows, picked, "outbound");
  assert.equal(group.key, picked);
  assert.equal(group.pairs.length, 0);
  assert.equal(group.low, null);
  assert.equal(group.leg.flight_numbers, "LH2");
  assert.equal(mod.exports.pickedGroup(rows, rows, "outbound|gone", "outbound"), null, "a flight no pair flies is unpinned");
});

test("one flight written differently by two sources is one choice", () => {
  const sameFlight = leg("lh 1", "2026-11-14T08:10:00", "2026-11-14T11:45:00");
  const groups = pickGroups([...rows, pair("other-source", 430, sameFlight, morning)], "outbound", "price");
  assert.equal(groups.length, 2);
  assert.equal(groups[0].pairs.length, 4);
});

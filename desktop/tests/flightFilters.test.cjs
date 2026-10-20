const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const path = require("node:path");
const { buildSync } = require("esbuild");
const code = buildSync({ entryPoints: [path.join(__dirname, "../src/flightFilters.ts")],
  bundle: true, write: false, format: "cjs", platform: "node" }).outputFiles[0].text;
const mod = { exports: {} };
vm.runInNewContext(code, { module: mod, exports: mod.exports });
const { matchesFlight, sanitizeFilters, filtersActive, OPEN_FILTERS, DEFAULT_FILTERS, FILTERS_VERSION, revisitsAirport } = mod.exports;

const segment = (origin, destination, departure, arrival, duration) => ({
  origin, destination, departure, arrival, duration, carrier: "AA", carrier_name: "American", flight_number: "AA1",
});
const leg = (departure, arrival, duration, segments) => ({
  origin_airport: "BER", destination_airport: "SLP", departure, arrival, duration,
  stops: segments.length > 1 ? segments.length - 1 : 0, airlines: "AA", flight_numbers: "AA1", segments,
});
const row = (extra = {}) => ({
  trip_key: "a",
  duration: "10h",
  return_duration: "",
  departure: "2026-12-10T08:00",
  arrival: "2026-12-10T18:00",
  return_date: "",
  return_departure: "",
  return_arrival: "",
  best: { price_base: 100 },
  outbound: leg("2026-12-10T08:00", "2026-12-10T18:00", "10h", [
    segment("BER", "LHR", "2026-12-10T08:00", "2026-12-10T09:00", "1h"),
    segment("LHR", "SLP", "2026-12-10T12:00", "2026-12-10T18:00", "6h"),
  ]),
  inbound: null,
  ...extra,
});
const day = { from: 0, to: 1440 };
const limits = (extra = {}) => ({
  maxPrice: null,
  maxDurationMinutes: null,
  maxLayoverMinutes: null,
  maxStops: null,
  excludeRepeatedAirports: false,
  outbound: { depart: day, arrive: day },
  inbound: { depart: day, arrive: day },
  ...extra,
});

test("max price uses the displayed amount and hides a flight with no price", () => {
  assert.equal(matchesFlight(row(), limits({ maxPrice: 100 }), 100), true);
  assert.equal(matchesFlight(row(), limits({ maxPrice: 99 }), 100), false);
  assert.equal(matchesFlight(row(), limits({ maxPrice: 50 }), null), false);
  assert.equal(matchesFlight(row(), limits(), null), true);
});

test("max duration applies to each direction and ignores a missing duration", () => {
  assert.equal(matchesFlight(row(), limits({ maxDurationMinutes: 600 }), 100), true);
  assert.equal(matchesFlight(row(), limits({ maxDurationMinutes: 599 }), 100), false);
  const round = row({
    return_date: "2026-12-12", return_duration: "30h",
    inbound: leg("2026-12-12T10:00", "2026-12-13T16:00", "30h", [
      segment("SLP", "BER", "2026-12-12T10:00", "2026-12-13T16:00", "30h"),
    ]),
  });
  assert.equal(matchesFlight(round, limits({ maxDurationMinutes: 12 * 60 }), 100), false);
  assert.equal(matchesFlight(row({ duration: "" }), limits({ maxDurationMinutes: 60 }), 100), true);
});

test("max layover is the longest single connection, and an unmeasured one does not fail", () => {
  assert.equal(matchesFlight(row(), limits({ maxLayoverMinutes: 180 }), 100), true);
  assert.equal(matchesFlight(row(), limits({ maxLayoverMinutes: 179 }), 100), false);
  const nonstop = row({
    outbound: leg("2026-12-10T08:00", "2026-12-10T18:00", "10h", [
      segment("BER", "SLP", "2026-12-10T08:00", "2026-12-10T18:00", "10h"),
    ]),
  });
  assert.equal(matchesFlight(nonstop, limits({ maxLayoverMinutes: 1 }), 100), true);
});

test("departure and arrival windows use local clocks and skip return limits on one-way trips", () => {
  const narrow = limits({
    outbound: { depart: { from: 9 * 60, to: 12 * 60 }, arrive: day },
    inbound: { depart: { from: 0, to: 60 }, arrive: day },
  });
  assert.equal(matchesFlight(row(), narrow, 100), false);
  assert.equal(matchesFlight(row(), limits({
    outbound: { depart: { from: 8 * 60, to: 8 * 60 }, arrive: { from: 18 * 60, to: 18 * 60 } },
    inbound: { depart: { from: 0, to: 60 }, arrive: day },
  }), 100), true);
  const round = row({
    return_date: "2026-12-12",
    return_departure: "2026-12-12T22:00",
    return_arrival: "2026-12-13T06:00",
    inbound: leg("2026-12-12T22:00", "2026-12-13T06:00", "8h", [
      segment("SLP", "BER", "2026-12-12T22:00", "2026-12-13T06:00", "8h"),
    ]),
  });
  assert.equal(matchesFlight(round, limits({
    inbound: { depart: { from: 20 * 60, to: 23 * 60 }, arrive: { from: 5 * 60, to: 7 * 60 } },
  }), 100), true);
  assert.equal(matchesFlight(round, limits({
    inbound: { depart: day, arrive: { from: 0, to: 5 * 60 } },
  }), 100), false);
  assert.equal(matchesFlight(row({ departure: "", outbound: leg("", "2026-12-10T18:00", "10h", []) }), limits({
    outbound: { depart: { from: 60, to: 120 }, arrive: day },
  }), 100), false);
});

test("departure is a minimum and arrival is a maximum, including their boundary times", () => {
  const bounds = limits({ outbound: {
    depart: { from: 8 * 60, to: 12 * 60 },
    arrive: { from: 6 * 60, to: 18 * 60 },
  } });
  assert.equal(matchesFlight(row(), bounds, 100), true);
  const flightAt = (departure, arrival) => row({ outbound: { ...row().outbound, departure, arrival } });
  assert.equal(matchesFlight(flightAt("2026-12-10T20:00", "2026-12-11T05:00"), bounds, 100), true,
    "later departures and earlier arrivals must not retain the old opposite bounds");
  assert.equal(matchesFlight(flightAt("2026-12-10T07:59", "2026-12-10T18:00"), bounds, 100), false);
  assert.equal(matchesFlight(flightAt("2026-12-10T08:00", "2026-12-10T18:01"), bounds, 100), false);
});

test("max stops applies to each direction and keeps a nonstop cap", () => {
  const oneStop = row();
  assert.equal(oneStop.outbound.stops, 1);
  assert.equal(matchesFlight(oneStop, limits({ maxStops: 1 }), 100), true);
  assert.equal(matchesFlight(oneStop, limits({ maxStops: 0 }), 100), false);
  const nonstop = row({
    outbound: leg("2026-12-10T08:00", "2026-12-10T18:00", "10h", [
      segment("BER", "SLP", "2026-12-10T08:00", "2026-12-10T18:00", "10h"),
    ]),
  });
  assert.equal(matchesFlight(nonstop, limits({ maxStops: 0 }), 100), true);
  const busyReturn = row({
    return_date: "2026-12-12",
    outbound: leg("2026-12-10T08:00", "2026-12-10T18:00", "10h", [
      segment("BER", "SLP", "2026-12-10T08:00", "2026-12-10T18:00", "10h"),
    ]),
    inbound: leg("2026-12-12T10:00", "2026-12-13T16:00", "30h", [
      segment("SLP", "LHR", "2026-12-12T10:00", "2026-12-12T18:00", "8h"),
      segment("LHR", "BER", "2026-12-12T20:00", "2026-12-12T22:00", "2h"),
    ]),
  });
  assert.equal(matchesFlight(busyReturn, limits({ maxStops: 0 }), 100), false);
  assert.equal(matchesFlight(row({ outbound: { ...row().outbound, stops: null }, stops: null }), limits({ maxStops: 0 }), 100), true);
});

test("stored filters drop invalid numbers and keep time windows inside the day", () => {
  const stored = sanitizeFilters({
    maxPriceEur: -5, maxDurationMinutes: 90, maxLayoverMinutes: "2", maxStops: 0,
    outbound: { depart: { from: 70, to: 20 }, arrive: { from: 9999, to: 9999 } },
  });
  assert.equal(stored.maxPriceEur, null);
  assert.equal(stored.maxDurationMinutes, 90);
  assert.equal(stored.maxLayoverMinutes, 720);
  assert.equal(stored.maxStops, 0);
  assert.equal(sanitizeFilters({ maxStops: -1 }).maxStops, null);
  assert.equal(stored.outbound.depart.from, 60);
  assert.equal(stored.outbound.depart.to, 1440);
  assert.equal(stored.outbound.arrive.from, 0);
  assert.equal(stored.inbound.depart.to, 1440);
  assert.equal(filtersActive(OPEN_FILTERS), false);
  assert.equal(filtersActive(stored), true);
});

test("new and legacy preferences get defaults, while saved custom and unlimited choices survive reload", () => {
  assert.equal(sanitizeFilters(null).maxLayoverMinutes, 720);
  assert.equal(sanitizeFilters({ maxLayoverMinutes: null }).maxLayoverMinutes, 720);
  assert.equal(sanitizeFilters({ maxLayoverMinutes: 960 }).maxLayoverMinutes, 960);
  assert.equal(sanitizeFilters({ maxLayoverMinutes: null, version: FILTERS_VERSION }).maxLayoverMinutes, null);
  assert.equal(sanitizeFilters(null).excludeRepeatedAirports, true);
  assert.equal(sanitizeFilters({ excludeRepeatedAirports: false }).excludeRepeatedAirports, false);
  assert.equal(filtersActive(DEFAULT_FILTERS), true);
});

const connection = (nextDeparture) => leg("2026-12-10T22:00", "2026-12-11T15:00", "17h", [
  segment("BER", "LHR", "2026-12-10T22:00", "2026-12-10T23:00", "1h"),
  segment("LHR", "SLP", nextDeparture, "2026-12-11T15:00", "4h"),
]);

test("the default accepts overnight and exactly twelve-hour connections but rejects longer ones in either direction", () => {
  const defaults = limits(DEFAULT_FILTERS);
  for (const departure of ["2026-12-11T07:00", "2026-12-11T11:00"]) {
    assert.equal(matchesFlight(row({ outbound: connection(departure) }), defaults, 100), true);
  }
  const long = connection("2026-12-11T11:01");
  assert.equal(matchesFlight(row({ outbound: long }), defaults, 100), false);
  assert.equal(matchesFlight(row({ inbound: long, return_date: "2026-12-11" }), defaults, 100), false);
  assert.equal(matchesFlight(row({ outbound: long }), limits({ excludeRepeatedAirports: true }), 100), true);
});

test("airport loops are hidden per direction, without counting a normal connection or return trip twice", () => {
  const loop = { ...row().outbound, segments: [
    segment("SLP", "MEX", "", "", "1h"), segment("MEX", "PVR", "", "", "1h"),
    segment("PVR", "MEX", "", "", "1h"), segment("MEX", "MTY", "", "", "1h"),
  ] };
  const exclude = limits({ excludeRepeatedAirports: true });
  assert.equal(revisitsAirport(row().outbound), false);
  assert.equal(matchesFlight(row({ outbound: loop }), exclude, 100), false);
  assert.equal(matchesFlight(row({ inbound: loop }), exclude, 100), false);
  assert.equal(matchesFlight(row({ outbound: loop }), limits(), 100), true);
  const back = { ...row().outbound, segments: [segment("SLP", "LHR", "", "", "6h"), segment("LHR", "BER", "", "", "1h")] };
  assert.equal(matchesFlight(row({ inbound: back }), exclude, 100), true);
});

test("loop detection includes airport transfers and normalizes codes without guessing from missing segments", () => {
  const path = (pairs) => ({ segments: pairs.map(([origin, destination]) => ({ origin, destination })) });
  assert.equal(revisitsAirport(path([["AAA", "BBB"], ["CCC", "DDD"]])), false);
  assert.equal(revisitsAirport(path([["AAA", "BBB"], ["CCC", " bbb "]])), true);
  assert.equal(revisitsAirport({ segments: [] }), false);
  assert.equal(revisitsAirport(null), false);
});

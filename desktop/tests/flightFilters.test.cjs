const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const path = require("node:path");
const { buildSync } = require("esbuild");
const code = buildSync({ entryPoints: [path.join(__dirname, "../src/flightFilters.ts")],
  bundle: true, write: false, format: "cjs", platform: "node" }).outputFiles[0].text;
const mod = { exports: {} };
vm.runInNewContext(code, { module: mod, exports: mod.exports });
const { matchesFlight, sanitizeFilters, filtersActive, filtersChanged, setDirectionLimits, setSeparate, OPEN_FILTERS, DEFAULT_FILTERS,
  FILTERS_VERSION, ANY_ARRIVAL, revisitsAirport } = mod.exports;

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
const anyArrival = { from: 0, to: ANY_ARRIVAL };
const openDirection = { depart: day, arrive: anyArrival, maxStops: null, maxDurationMinutes: null, maxLayoverMinutes: null };
/** Stops, duration and layover limits given at the top apply to both directions, as one edited together does. */
const limits = ({ maxStops = null, maxDurationMinutes = null, maxLayoverMinutes = null, outbound = {}, inbound = {}, ...extra } = {}) => {
  const both = { maxStops, maxDurationMinutes, maxLayoverMinutes };
  return { maxPrice: null, excludeRepeatedAirports: false, ...extra,
    outbound: { ...openDirection, ...both, ...outbound }, inbound: { ...openDirection, ...both, ...inbound } };
};

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
    outbound: { depart: { from: 9 * 60, to: 12 * 60 }, arrive: anyArrival },
    inbound: { depart: { from: 0, to: 60 }, arrive: anyArrival },
  });
  assert.equal(matchesFlight(row(), narrow, 100), false);
  assert.equal(matchesFlight(row(), limits({
    outbound: { depart: { from: 8 * 60, to: 8 * 60 }, arrive: { from: 18 * 60, to: 18 * 60 } },
    inbound: { depart: { from: 0, to: 60 }, arrive: anyArrival },
  }), 100), true);
  const round = row({
    return_date: "2026-12-12",
    return_departure: "2026-12-12T22:00",
    return_arrival: "2026-12-13T06:00",
    inbound: leg("2026-12-12T22:00", "2026-12-13T06:00", "8h", [
      segment("SLP", "BER", "2026-12-12T22:00", "2026-12-13T06:00", "8h"),
    ]),
  });
  // The return lands 06:00 the day after it leaves: a limit counts from its departure day.
  assert.equal(matchesFlight(round, limits({
    inbound: { depart: { from: 20 * 60, to: 23 * 60 }, arrive: { from: 5 * 60, to: 1440 + 7 * 60 } },
  }), 100), true);
  assert.equal(matchesFlight(round, limits({
    inbound: { depart: day, arrive: { from: 0, to: 1440 + 5 * 60 } },
  }), 100), false);
  assert.equal(matchesFlight(round, limits({
    inbound: { depart: day, arrive: { from: 0, to: 7 * 60 } },
  }), 100), false, "07:00 is on the departure day, before an overnight arrival");
  assert.equal(matchesFlight(row({ departure: "", outbound: leg("", "2026-12-10T18:00", "10h", []) }), limits({
    outbound: { depart: { from: 60, to: 120 }, arrive: anyArrival },
  }), 100), false);
});

test("departure is a minimum and arrival is a maximum, including their boundary times", () => {
  const bounds = limits({ outbound: {
    depart: { from: 8 * 60, to: 12 * 60 },
    arrive: { from: 6 * 60, to: 18 * 60 },
  } });
  assert.equal(matchesFlight(row(), bounds, 100), true);
  const flightAt = (departure, arrival) => row({ outbound: { ...row().outbound, departure, arrival } });
  assert.equal(matchesFlight(flightAt("2026-12-10T13:00", "2026-12-10T17:00"), bounds, 100), true,
    "later departures must not retain the old opposite bound");
  assert.equal(matchesFlight(flightAt("2026-12-10T08:00", "2026-12-10T05:00"), bounds, 100), true,
    "earlier arrivals, as on a westbound flight, must not retain the old opposite bound");
  assert.equal(matchesFlight(flightAt("2026-12-10T07:59", "2026-12-10T18:00"), bounds, 100), false);
  assert.equal(matchesFlight(flightAt("2026-12-10T08:00", "2026-12-10T18:01"), bounds, 100), false);
  assert.equal(matchesFlight(flightAt("2026-12-10T20:00", "2026-12-11T05:00"), bounds, 100), false,
    "18:00 is on the departure day, so an overnight arrival is too late");
});

test("a latest arrival can fall on the next day or the one after", () => {
  const flightAt = (departure, arrival) => row({ outbound: { ...row().outbound, departure, arrival } });
  const by = (to) => limits({ outbound: { depart: day, arrive: { from: 0, to } } });
  const overnight = flightAt("2026-12-10T20:00", "2026-12-11T05:00");
  assert.equal(matchesFlight(overnight, by(1440 + 5 * 60), 100), true);
  assert.equal(matchesFlight(overnight, by(1440 + 4 * 60 + 30), 100), false);
  const long = flightAt("2026-12-10T20:00", "2026-12-12T09:00");
  assert.equal(matchesFlight(long, by(2 * 1440 + 9 * 60), 100), true);
  assert.equal(matchesFlight(long, by(2 * 1440 + 8 * 60), 100), false);
  assert.equal(matchesFlight(long, by(ANY_ARRIVAL), 100), true);
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
  for (const direction of ["outbound", "inbound"]) {
    assert.equal(stored[direction].maxDurationMinutes, 90, "a version 3 limit applies to both directions");
    assert.equal(stored[direction].maxLayoverMinutes, 720);
    assert.equal(stored[direction].maxStops, 0);
  }
  assert.equal(sanitizeFilters({ maxStops: -1 }).outbound.maxStops, null);
  assert.equal(stored.outbound.depart.from, 60);
  assert.equal(stored.outbound.depart.to, 1440);
  assert.equal(stored.outbound.arrive.from, 0);
  assert.equal(stored.inbound.depart.to, 1440);
  assert.equal(filtersActive(OPEN_FILTERS), false);
  assert.equal(filtersActive(stored), true);
});

test("new and legacy preferences get defaults, while saved custom and unlimited choices survive reload", () => {
  const layover = (saved) => sanitizeFilters(saved).outbound.maxLayoverMinutes;
  assert.equal(layover(null), 720);
  assert.equal(layover({ maxLayoverMinutes: null }), 720);
  assert.equal(layover({ maxLayoverMinutes: 960 }), 960);
  assert.equal(layover({ maxLayoverMinutes: null, version: 2 }), null);
  assert.equal(layover({ version: FILTERS_VERSION, outbound: { maxLayoverMinutes: null } }), null);
  assert.equal(layover({ version: FILTERS_VERSION, outbound: {} }), 720, "a missing current limit takes the default");
  assert.equal(sanitizeFilters(null).excludeRepeatedAirports, true);
  assert.equal(sanitizeFilters({ excludeRepeatedAirports: false }).excludeRepeatedAirports, false);
  assert.equal(filtersActive(DEFAULT_FILTERS), true);
});

test("arrival limits saved before version 3 keep no limit as no limit, and a same-day limit as it was", () => {
  const arriveBy = (to, version) => sanitizeFilters({ version, outbound: { arrive: { from: 0, to } } }).outbound.arrive.to;
  assert.equal(arriveBy(1440, 2), ANY_ARRIVAL);
  assert.equal(arriveBy(1320, 2), 1320);
  assert.equal(arriveBy(1440, FILTERS_VERSION), 1440, "since version 3, 1440 is 00:00 the next day");
  assert.equal(arriveBy(1440 + 360, FILTERS_VERSION), 1440 + 360);
  assert.equal(arriveBy(99999, FILTERS_VERSION), ANY_ARRIVAL);
  assert.equal(sanitizeFilters(null).outbound.arrive.to, ANY_ARRIVAL);
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

const roundTrip = () => row({
  return_date: "2026-12-12", return_duration: "14h", return_departure: "2026-12-12T10:00", return_arrival: "2026-12-13T08:00",
  inbound: leg("2026-12-12T10:00", "2026-12-13T08:00", "14h", [
    segment("SLP", "MEX", "2026-12-12T10:00", "2026-12-12T11:00", "1h"),
    segment("MEX", "MAD", "2026-12-12T13:00", "2026-12-13T05:00", "10h"),
    segment("MAD", "BER", "2026-12-13T06:00", "2026-12-13T08:00", "2h"),
  ]),
});

test("each direction is held to its own stops, duration and connection limits", () => {
  // Outbound: 1 stop, 10h, a 3h connection. Return: 2 stops, 14h, connections of 2h and 1h.
  const trip = roundTrip();
  assert.equal(matchesFlight(trip, limits({ outbound: { maxStops: 1 }, inbound: { maxStops: 2 } }), 100), true);
  assert.equal(matchesFlight(trip, limits({ outbound: { maxStops: 2 }, inbound: { maxStops: 1 } }), 100), false);
  assert.equal(matchesFlight(trip, limits({ outbound: { maxDurationMinutes: 600 }, inbound: { maxDurationMinutes: 840 } }), 100), true);
  assert.equal(matchesFlight(trip, limits({ inbound: { maxDurationMinutes: 600 } }), 100), false);
  assert.equal(matchesFlight(trip, limits({ inbound: { maxLayoverMinutes: 120 } }), 100), true, "only the outbound waits 3h");
  assert.equal(matchesFlight(trip, limits({ outbound: { maxLayoverMinutes: 120 } }), 100), false);
  assert.equal(matchesFlight(row(), limits({ inbound: { maxStops: 0, maxDurationMinutes: 1 } }), 100), true,
    "a one-way has no return to hold to return limits");
});

test("a filter edited together sets both directions, and a separate one only the direction named", () => {
  const together = setDirectionLimits(OPEN_FILTERS, "stops", "inbound", { maxStops: 1 });
  assert.equal(together.outbound.maxStops, 1);
  assert.equal(together.inbound.maxStops, 1);
  const apart = setDirectionLimits(setSeparate(together, "stops", true), "stops", "inbound", { maxStops: 2 });
  assert.equal(apart.outbound.maxStops, 1);
  assert.equal(apart.inbound.maxStops, 2);
  assert.equal(apart.inbound.maxDurationMinutes, null, "other limits are untouched");
  const joined = setSeparate(apart, "stops", false);
  assert.equal(joined.inbound.maxStops, 1, "joining gives the return the outbound limit, so nothing stays set unseen");
  assert.equal(joined.separate.stops, false);
  const times = setSeparate(setDirectionLimits(setSeparate(OPEN_FILTERS, "times", true), "times", "inbound",
    { depart: { from: 600, to: 1440 } }), "times", false);
  assert.equal(times.inbound.depart.from, 0);
  assert.equal(filtersChanged(setDirectionLimits(DEFAULT_FILTERS, "duration", "outbound", { maxDurationMinutes: 600 })), true);
});

test("filters saved before version 4 keep one limit for both directions, and times that differed stay separate", () => {
  const legacy = sanitizeFilters({ version: 3, maxStops: 1, maxDurationMinutes: 600, maxLayoverMinutes: 360,
    outbound: { depart: { from: 360, to: 1440 }, arrive: { from: 0, to: ANY_ARRIVAL } },
    inbound: { depart: { from: 0, to: 1440 }, arrive: { from: 0, to: 1320 } } });
  assert.deepEqual({ ...legacy.separate }, { stops: false, duration: false, layovers: false, times: true });
  assert.equal(legacy.inbound.maxStops, 1);
  assert.equal(legacy.inbound.arrive.to, 1320);
  const current = sanitizeFilters({ version: FILTERS_VERSION, separate: { stops: true },
    outbound: { maxStops: 1 }, inbound: { maxStops: 1 } });
  assert.equal(current.separate.stops, true, "a separate filter stays separate even while its limits agree");
  assert.equal(current.separate.duration, false);
});

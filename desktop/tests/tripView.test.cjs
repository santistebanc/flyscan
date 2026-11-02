const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildSync } = require("esbuild");
const vm = require("node:vm");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const inbound = require("./fixtures/jetradar-airport-transfer.json");
const code = buildSync({ stdin: { contents: `
  export { JourneyTimeline, placeEndLabels } from './src/JourneyTimeline';
  export { TripView } from './src/TripView';
  export { tripStats, distribution, placeIn, tripDistributions } from './src/tripStats';
  export { normalizeLayout } from './src/LayoutToggle';
  export { CurrencyProvider } from './src/currency';
  export { journeyTiming, journeyScale, journeyHourMarks, flightTimelines, timeFilterAxis } from './src/flightTimeline';
  export { handleAt, keptApart, limitAt, limitClock } from './src/TimeHandles';
  export { pickGroups, legKey } from './src/pairPicking';
  export { OPEN_FILTERS, ANY_ARRIVAL, nearestTrip } from './src/flightFilters';
`, resolveDir: path.join(__dirname, "..") }, bundle: true, external: ["react", "react-dom"],
  write: false, format: "cjs", platform: "node", jsx: "automatic", define: { "import.meta.env": "{}" } }).outputFiles[0].text;
const mod = { exports: {} };
vm.runInNewContext(code, { module: mod, exports: mod.exports, require, window: {},
  localStorage: { getItem: () => null } });
const { JourneyTimeline, placeEndLabels, TripView, tripStats, distribution, placeIn, tripDistributions, normalizeLayout, CurrencyProvider,
  journeyTiming, journeyScale, journeyHourMarks, flightTimelines, timeFilterAxis, handleAt, keptApart, limitAt, limitClock, pickGroups, legKey,
  OPEN_FILTERS, ANY_ARRIVAL, nearestTrip } = mod.exports;

const segment = (origin, destination, departure, arrival, duration, flight) => ({
  origin, destination, departure, arrival, duration, carrier: flight.slice(0, 2), carrier_name: "", flight_number: flight });
const oneStop = { origin_airport: "BER", destination_airport: "MAD", departure: "2026-12-10T06:10",
  arrival: "2026-12-10T12:40", duration: "6h 30m", stops: 1, flight_numbers: "LH171, LH1120", segments: [
    segment("BER", "FRA", "2026-12-10T06:10", "2026-12-10T07:20", "1h 10m", "LH171"),
    segment("FRA", "MAD", "2026-12-10T09:00", "2026-12-10T12:40", "3h 40m", "LH1120")] };

test("the details range spans the journey alone, padded to whole hours", () => {
  const scale = journeyScale(journeyTiming(oneStop));
  // 06:10 → 12:40 on the departure clock: 05:00 to 14:00.
  assert.equal(scale.min, 5 * 60);
  assert.equal(scale.max, 14 * 60);
});

test("details hour ticks step by the closest hours that leave room between them", () => {
  const timing = journeyTiming(oneStop), scale = journeyScale(timing);
  const hours = (px) => [...journeyHourMarks(timing, scale, px / (scale.max - scale.min))].map((mark) => mark.hour);
  assert.deepEqual(hours(540), [6, 7, 8, 9, 10, 11, 12, 13], "a minute a pixel: every hour");
  assert.deepEqual(hours(270), [6, 8, 10, 12], "half that: every two hours");
  assert.deepEqual(hours(20), [], "too narrow for any");
});

test("an overnight journey leaves midnight to its date line", () => {
  const leg = { ...oneStop, departure: "2026-12-10T22:00", arrival: "2026-12-11T03:00", duration: "5h", segments: [] };
  const timing = journeyTiming(leg), scale = journeyScale(timing);
  const hours = [...journeyHourMarks(timing, scale, 1)].map((mark) => mark.hour);
  assert.ok(!hours.includes(0));
  assert.deepEqual(hours, [22, 23, 1, 2, 3]);
});

test("end labels turn inward at the plot's edge and give way to the label before them", () => {
  const labels = placeEndLabels([
    { x: 10, pct: 0, text: "06:10 BER", anchor: "start" },
    { x: 30, pct: 0, text: "07:00 FRA", anchor: "start" },
    { x: 290, pct: 0, text: "09:00 FRA", anchor: "start" },
  ], 300);
  assert.deepEqual([...labels].map((label) => label.text), ["06:10 BER", "09:00 FRA"]);
  // 9 characters at 7px plus 8px of room: 71px, so it starts 71px before the end.
  assert.equal(labels[1].left, 229);
  const arrivals = placeEndLabels([{ x: 20, pct: 0, text: "FRA 07:20", anchor: "end" }], 300);
  assert.equal(arrivals[0].left, 0, "an arrival near the start stays inside the plot");
});

test("the large timeline draws each flight and wait with departures and arrivals at their ends", () => {
  const html = renderToStaticMarkup(React.createElement(JourneyTimeline, { leg: oneStop, title: "Outbound" }));
  assert.equal((html.match(/jt-part airborne/g) || []).length, 2);
  assert.equal((html.match(/jt-part layover/g) || []).length, 1);
  assert.deepEqual([...html.matchAll(/class="jt-end departs"[^>]*>([^<]+)</g)].map((m) => m[1]), ["06:10 BER", "09:00 FRA"]);
  assert.deepEqual([...html.matchAll(/class="jt-end arrives"[^>]*>([^<]+)</g)].map((m) => m[1]), ["FRA 07:20", "MAD 12:40"]);
  assert.match(html, /aria-label="Outbound timeline: BER 06:10 to MAD 12:40, 6h 30m"/);
});

test("the large timeline labels an airport transfer and its elapsed time", () => {
  const html = renderToStaticMarkup(React.createElement(JourneyTimeline, { leg: inbound, title: "Return" }));
  assert.equal((html.match(/jt-part airborne/g) || []).length, 5);
  assert.equal((html.match(/jt-part layover transfer/g) || []).length, 1);
  assert.match(html, /MDW→ORD · 23h 4m/);
});

test("a leg without segment times is drawn as one journey that says so", () => {
  const leg = { ...oneStop, segments: [] };
  const html = renderToStaticMarkup(React.createElement(JourneyTimeline, { leg, title: "Outbound" }));
  assert.equal((html.match(/jt-part summary/g) || []).length, 1);
  assert.match(html, /Schedule not detailed/);
});

const back = { origin_airport: "MAD", destination_airport: "BER", departure: "2026-12-17T18:00",
  arrival: "2026-12-17T21:10", duration: "3h 10m", stops: 0, flight_numbers: "IB3670", segments: [
    segment("MAD", "BER", "2026-12-17T18:00", "2026-12-17T21:10", "3h 10m", "IB3670")] };
const trip = (key, price, outbound, inbound) => ({ trip_key: key, route: "BER-MAD", depart_date: "2026-12-10",
  return_date: inbound ? "2026-12-17" : "", outbound, inbound, best: { price_base: price },
  offers: [{ source: "kayak", agent: "Iberia", price_base: price, deeplink: "https://example.test/book" }] });

test("a trip's figures add both directions, and an undescribed connection leaves the layover unknown", () => {
  assert.deepEqual({ ...tripStats(trip("a", 240, oneStop, back)) }, { price: 240, duration: 580, layover: 100, stops: 1 });
  const vague = { ...oneStop, segments: [] };
  assert.equal(tripStats(trip("b", 200, vague, back)).layover, null);
  assert.equal(tripStats(trip("c", 200, vague, back)).duration, 580, "the reported duration still counts");
});

test("a distribution counts values in equal bins up to the 95th percentile, the tail in the last", () => {
  // 100 fares from 100 to 199, and one of 9000 far out in the tail.
  const fares = [...Array.from({ length: 100 }, (_, i) => 100 + i), 9000];
  const dist = distribution([...fares, null]);
  assert.equal(dist.bins.length, 24);
  assert.equal(dist.min, 100);
  assert.equal(dist.max, 195, "the 95th percentile, not the outlier");
  assert.ok(dist.overflow);
  assert.equal(dist.bins.reduce((sum, bin) => sum + bin.count, 0), 101, "every known value is counted once");
  assert.ok(dist.bins[23].count >= 6, "the last bin holds the tail");
});

test("a trip's placement names its bin, its place on the axis and the share of trips worse than it", () => {
  const dist = distribution([100, 200, 200, 300, 400]);
  const cheapest = placeIn(dist, 100);
  assert.equal(cheapest.best, true);
  assert.equal(cheapest.bin, 0);
  assert.equal(cheapest.position, 0);
  assert.equal(cheapest.worse, 0.8);
  const middle = placeIn(dist, 200);
  assert.equal(middle.best, false);
  assert.equal(middle.worse, 0.4, "ties are not counted as worse");
  assert.equal(placeIn(dist, 400).worse, 0);
});

test("stops are counted per whole number, each trip marked in the middle of its bar", () => {
  const dist = distribution([1, 1, 2, 4], true);
  assert.deepEqual([...dist.bins].map((bin) => bin.count), [2, 1, 0, 1]);
  const place = placeIn(dist, 2);
  assert.equal(place.bin, 1);
  assert.equal(place.position, 1.5 / 4);
  assert.equal(distribution([null, null]), null, "nothing known draws nothing");
});

test("only a stored trip layout opens the Trip view", () => {
  assert.equal(normalizeLayout("trip"), "trip");
  for (const value of ["list", null, "grid", 1]) assert.equal(normalizeLayout(value), "list");
});

const renderTrip = (rows, at, { stage = { kind: "pairs" }, figures = rows.map((row) => tripStats(row)), times = OPEN_FILTERS,
  empty, timelines = flightTimelines(rows) } = {}) => {
  return renderToStaticMarkup(React.createElement(CurrencyProvider, { api: null }, React.createElement(TripView, {
    rows, at, onStep: () => {}, stage, figures, ratings: new Map(), distributions: tripDistributions(figures), timelines,
    layoverRatings: { outbound: new Map(), inbound: new Map() }, times: { outbound: times.outbound, inbound: times.inbound },
    onTimes: () => {}, favorite: false, onToggleFavorite: () => {}, details: null, empty,
  })));
};

test("with nothing matching, the nearest trip stays faded under the notice, its time handles still there", () => {
  const empty = { title: "Nothing matches these limits.", body: "Relax a filter.", action: { label: "Reset filters", onClick: () => {} } };
  const html = renderTrip([trip("a", 240, oneStop, back)], 0, { empty });
  assert.match(html, /data-empty="true"/);
  assert.match(html, /<b>Nothing matches these limits\.<\/b>/);
  assert.match(html, />Reset filters</);
  assert.match(html, /No trips/);
  assert.doesNotMatch(html, /Book<span|Booking options and leg details/, "nothing to book or open");
  assert.match(html, /class="trip-stat-value trip-anim-in"[^>]*>–</, "the figures read as dashes");
  assert.equal((html.match(/role="slider"/g) || []).length, 4, "the handles stay to relax a time limit");
  assert.match(html, /Outbound timeline: BER 06:10/, "its flight drawn, faded by the stylesheet");
  assert.match(html, /Faded below, the trip nearest your time limits/);
});

test("with nothing matching, the trip shown is the one nearest the time limits", () => {
  const early = trip("early", 100, oneStop, back), late = trip("late", 300, nonstop, back);
  const limits = { maxPrice: null, excludeRepeatedAirports: false, inbound: OPEN_FILTERS.inbound,
    outbound: { ...OPEN_FILTERS.outbound, depart: { from: 10 * 60, to: 1440 } } };
  // Departing 06:10 misses 10:00 by 230 minutes, 09:00 by 60.
  assert.equal(nearestTrip([early, late], limits, (row) => row.best?.price_base ?? null).trip_key, "late");
  const open = { ...limits, outbound: OPEN_FILTERS.outbound, maxPrice: 50 };
  assert.equal(nearestTrip([late, early], open, (row) => row.best?.price_base ?? null).trip_key, "early", "then the cheapest");
});

test("a trip kept on from rows since reloaded still has its handles", () => {
  const kept = trip("a", 240, oneStop, back);
  const reloaded = trip("a", 240, { ...oneStop }, { ...back });
  const html = renderTrip([kept], 0, { empty: { title: "Nothing matches these limits." }, timelines: flightTimelines([reloaded]) });
  assert.equal((html.match(/role="slider"/g) || []).length, 4);
});

test("the Trip view counts the trips and stops Prev and Next at either end", () => {
  const rows = [trip("a", 240, oneStop, back), trip("b", 120, back, back)];
  const disabled = (html, label) => new RegExp(`aria-label="${label}"[^>]*disabled=""|disabled=""[^>]*aria-label="${label}"`).test(html);
  const first = renderTrip(rows, 0);
  assert.match(first, /Trip <b[^>]*>1<\/b> of 2/);
  assert.ok(disabled(first, "First trip") && disabled(first, "Previous trip"));
  assert.ok(!disabled(first, "Next trip"));
  const last = renderTrip(rows, 1);
  assert.ok(disabled(last, "Next trip") && !disabled(last, "Previous trip"));
});

test("the Trip view draws both directions and books with the cheapest seller", () => {
  const html = renderTrip([trip("a", 240, oneStop, back)], 0);
  assert.match(html, /aria-label="Outbound timeline: BER 06:10 to MAD 12:40, 6h 30m"/);
  assert.match(html, /aria-label="Return timeline: MAD 18:00 to BER 21:10, 3h 10m"/);
  assert.match(html, /class="trip-book-seller">Iberia</);
  assert.equal((html.match(/class="trip-stat( hero)?"/g) || []).length, 4);
});

test("each figure's chart lights the trip's bar and says what it beats", () => {
  const rows = [trip("a", 240, oneStop, back), trip("b", 120, back, back), trip("c", 300, oneStop, back)];
  const html = renderTrip(rows, 0);
  assert.equal((html.match(/class="trip-dist"/g) || []).length, 4);
  assert.match(html, /Cheaper than 33% of trips/);
  assert.match(html, /aria-label="Price across 3 trips, from/);
  assert.equal((html.match(/class="trip-dist-mark"/g) || []).length, 4);
  assert.match(renderTrip(rows, 1), /The cheapest/);
});

test("a one-way trip has no return section", () => {
  const html = renderTrip([trip("a", 240, oneStop, null)], 0);
  assert.doesNotMatch(html, /Return timeline/);
  assert.doesNotMatch(html, /Return flight details unavailable/);
});

// Two returns sold with the same outbound, and a second outbound.
const late = { ...back, departure: "2026-12-17T21:00", arrival: "2026-12-18T00:10", flight_numbers: "IB3672",
  segments: [segment("MAD", "BER", "2026-12-17T21:00", "2026-12-18T00:10", "3h 10m", "IB3672")] };
const nonstop = { ...back, origin_airport: "BER", destination_airport: "MAD", departure: "2026-12-10T09:00", flight_numbers: "IB3671",
  arrival: "2026-12-10T12:10", segments: [segment("BER", "MAD", "2026-12-10T09:00", "2026-12-10T12:10", "3h 10m", "IB3671")] };
const pairs = [trip("a", 240, oneStop, back), trip("b", 300, oneStop, late), trip("c", 180, nonstop, back)];

test("picking an outbound steps through outbounds alone, each priced from its cheapest pair", () => {
  const groups = pickGroups(pairs, "outbound", "price");
  const rows = groups.map((group) => ({ ...group.example, trip_key: group.key }));
  const figures = groups.map((group) => tripStats(group.example, "outbound", group.low));
  const stage = { kind: "pick", direction: "outbound", groups: new Map(groups.map((group) => [group.key, group])), onPick: () => {} };
  const at = groups.findIndex((group) => group.leg === oneStop);
  const html = renderTrip(rows, at, { stage, figures });
  assert.match(html, /Outbound <b[^>]*>2<\/b> of 2/);
  assert.match(html, /Price from/);
  assert.match(html, /Choose<span class="trip-book-seller">2 returns</);
  assert.match(html, /Outbound timeline/);
  assert.doesNotMatch(html, /Return timeline|Book<span/, "one direction, and nothing to book until a pair is chosen");
  assert.match(html, /More expensive|None cost more/);
  assert.equal({ ...figures[at] }.price, 240, "from the cheaper of its two pairs");
  assert.equal({ ...figures[at] }.duration, 390, "the outbound's time alone");
});

test("with no outbounds left to pick, both directions' handles stay out", () => {
  const stage = { kind: "pick", direction: "outbound", groups: new Map(), onPick: () => {} };
  const html = renderTrip([pairs[0]], 0, { stage, empty: { title: "Nothing matches these limits." } });
  assert.match(html, /Outbound timeline/);
  assert.match(html, /Return timeline/, "a return limit may be what ruled them out");
  assert.equal((html.match(/role="slider"/g) || []).length, 4);
});

test("the pairs of a picked outbound keep it pinned above them, with a way to pick again", () => {
  const [group] = pickGroups(pairs.filter((row) => legKey(row, "outbound") === legKey(pairs[0], "outbound")), "outbound", "price");
  const rows = pairs.slice(0, 2);
  const html = renderTrip(rows, 0, { stage: { kind: "pair", pinned: group, onChange: () => {} } });
  assert.match(html, /class="trip-pinned-what">Outbound picked/);
  assert.match(html, /BER 06:10 → MAD 12:40 · /);
  assert.match(html, />Change</);
  assert.match(html, /Return <b[^>]*>1<\/b> of 2/);
  assert.match(html, /Book<span/);
});

test("a time limit lands on the timeline from the local midnight of the departure day", () => {
  const timing = journeyTiming(oneStop);
  const axis = timeFilterAxis(timing);
  // Departs 06:10: the departure clock's midnight is 370 minutes before.
  assert.equal(timing.start - axis.depart, 6 * 60 + 10);
  assert.equal(axis.arrive, axis.depart, "no time zones crossed in the fixture's clocks");
});

test("a dragged handle snaps to a quarter hour, and dragged out to its end lifts the limit", () => {
  const scale = { min: 300, max: 1740 };
  assert.equal(limitAt("depart", 300 + 7 * 60 + 8, 300, scale), 7 * 60 + 15);
  assert.equal(limitAt("depart", 300, 0, scale), 0);
  assert.equal(limitAt("arrive", 1740, 0, scale), ANY_ARRIVAL);
  assert.equal(limitAt("arrive", 1500, 0, scale), 1500);
  assert.equal(limitClock(1500), "01:00 +1");
  assert.equal(limitClock(7 * 60 + 30), "07:30");
});

test("a handle whose limit is scrolled out of sight waits at the edge in sight", () => {
  const view = { from: 25, to: 50 };
  assert.deepEqual({ ...handleAt(0, view) }, { edge: "start", beyond: true });
  assert.deepEqual({ ...handleAt(80, view) }, { edge: "end", beyond: true });
  assert.deepEqual({ ...handleAt(30, view) }, { beyond: false });
  assert.deepEqual({ ...handleAt(100, { from: 0, to: 100 }) }, { edge: "end", beyond: false }, "at the end, not beyond it");
});

test("scrolled past as far as its limits reach, a handle goes by with the timeline", () => {
  const reach = { from: 0, to: 40 };
  assert.deepEqual({ ...handleAt(40, { from: 60, to: 80 }, reach) }, { beyond: false });
  assert.deepEqual({ ...handleAt(10, { from: 20, to: 50 }, reach) }, { edge: "start", beyond: true }, "still within reach");
  assert.deepEqual({ ...handleAt(90, { from: 10, to: 30 }, { from: 50, to: 100 }) }, { beyond: false });
});

test("the two handles are never dragged or stepped past each other", () => {
  const axis = { depart: 0, arrive: 0 };
  assert.equal(keptApart("depart", 20 * 60, 18 * 60, axis), 18 * 60, "no departure after the latest arrival");
  assert.equal(keptApart("depart", 20 * 60, ANY_ARRIVAL, axis), 20 * 60, "no arrival limit holds nothing back");
  assert.equal(keptApart("arrive", 6 * 60, 9 * 60, axis), 9 * 60, "no arrival before the earliest departure");
  assert.equal(keptApart("arrive", 6 * 60, 0, axis), 6 * 60);
  assert.equal(keptApart("arrive", ANY_ARRIVAL, 9 * 60, axis), ANY_ARRIVAL, "dragged out, it still lifts the limit");
  assert.equal(keptApart("depart", 20 * 60, 18 * 60, { depart: 0, arrive: -60 }), 17 * 60, "the arrival's clock an hour behind");
});

test("set time limits show on the handles and shade the hours they rule out", () => {
  const times = { ...OPEN_FILTERS, outbound: { ...OPEN_FILTERS.outbound, depart: { from: 7 * 60, to: 1440 } } };
  const html = renderTrip([trip("a", 240, oneStop, back)], 0, { times });
  assert.match(html, /aria-valuetext="Depart after 07:00"/);
  assert.match(html, /class="time-handle-label">Depart after 07:00</);
  assert.match(html, /aria-valuetext="Any arrival time"/);
  assert.equal((html.match(/class="time-filtered"/g) || []).length, 1);
  assert.equal((html.match(/role="slider"/g) || []).length, 4, "two handles on each direction");
});

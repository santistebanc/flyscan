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
  export { tripStats } from './src/tripStats';
  export { normalizeLayout } from './src/LayoutToggle';
  export { CurrencyProvider } from './src/currency';
  export { journeyTiming, journeyScale, journeyHourMarks, flightTimelines } from './src/flightTimeline';
`, resolveDir: path.join(__dirname, "..") }, bundle: true, external: ["react", "react-dom"],
  write: false, format: "cjs", platform: "node", jsx: "automatic", define: { "import.meta.env": "{}" } }).outputFiles[0].text;
const mod = { exports: {} };
vm.runInNewContext(code, { module: mod, exports: mod.exports, require, window: {},
  localStorage: { getItem: () => null } });
const { JourneyTimeline, placeEndLabels, TripView, tripStats, normalizeLayout, CurrencyProvider,
  journeyTiming, journeyScale, journeyHourMarks, flightTimelines } = mod.exports;

const segment = (origin, destination, departure, arrival, duration, flight) => ({
  origin, destination, departure, arrival, duration, carrier: flight.slice(0, 2), carrier_name: "", flight_number: flight });
const oneStop = { origin_airport: "BER", destination_airport: "MAD", departure: "2026-12-10T06:10",
  arrival: "2026-12-10T12:40", duration: "6h 30m", stops: 1, segments: [
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
  arrival: "2026-12-17T21:10", duration: "3h 10m", stops: 0, segments: [
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

test("only a stored trip layout opens the Trip view", () => {
  assert.equal(normalizeLayout("trip"), "trip");
  for (const value of ["list", null, "grid", 1]) assert.equal(normalizeLayout(value), "list");
});

const renderTrip = (rows, at) => {
  const timelines = flightTimelines(rows);
  return renderToStaticMarkup(React.createElement(CurrencyProvider, { api: null }, React.createElement(TripView, {
    rows, at, onStep: () => {}, ratings: new Map(), timelines,
    layoverRatings: { outbound: new Map(), inbound: new Map() }, favorite: false, onToggleFavorite: () => {}, details: null,
  })));
};

test("the Trip view counts the trips and stops Prev and Next at either end", () => {
  const rows = [trip("a", 240, oneStop, back), trip("b", 120, back, back)];
  const disabled = (html, label) => new RegExp(`aria-label="${label}"[^>]*disabled=""|disabled=""[^>]*aria-label="${label}"`).test(html);
  const first = renderTrip(rows, 0);
  assert.match(first, /Trip <b>1<\/b> of 2/);
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

test("a one-way trip has no return section", () => {
  const html = renderTrip([trip("a", 240, oneStop, null)], 0);
  assert.doesNotMatch(html, /Return timeline/);
  assert.doesNotMatch(html, /Return flight details unavailable/);
});

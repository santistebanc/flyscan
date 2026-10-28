const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildSync } = require("esbuild");
const vm = require("node:vm");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const inbound = require("./fixtures/jetradar-airport-transfer.json");
const code = buildSync({ stdin: { contents: `
  export { Details } from './src/Details';
  export { CurrencyProvider } from './src/currency';
  export { FlightTimeline } from './src/TimelineFlight';
  export { flightTimelines } from './src/flightTimeline';
`, resolveDir: path.join(__dirname, "..") }, bundle: true, external: ["react", "react-dom"],
  write: false, format: "cjs", platform: "node", jsx: "automatic", define: { "import.meta.env": "{}" } }).outputFiles[0].text;
const mod = { exports: {} };
vm.runInNewContext(code, { module: mod, exports: mod.exports, require, window: {},
  localStorage: { getItem: () => null } });
const { Details, CurrencyProvider, FlightTimeline, flightTimelines } = mod.exports;
const render = (leg, scale, timing, mode) => renderToStaticMarkup(React.createElement(FlightTimeline,
  { label: "Outbound", leg, scale, timing, mode }));

test("midnight lines mark only the local days a range crosses", () => {
  const leg = { origin_airport: "SLP", destination_airport: "BER", departure: "2027-01-07T05:47",
    arrival: "2027-01-08T10:45", duration: "21h 58m", stops: 0, segments: [] };
  const timelines = flightTimelines([{ outbound: leg }]);
  const html = render(leg, timelines.outbound, timelines.journeys.get(leg), "days");
  // 05:00 Jan 7 to 05:00 Jan 9: midnights begin Jan 8 and Jan 9.
  assert.deepEqual([...html.matchAll(/class="leg-midnight" title="([^"]+)"/g)].map((m) => m[1]), ["Jan 8", "Jan 9"]);
  assert.doesNotMatch(html, /Jan 6/);
});

test("a nonstop row has no stops label, with or without segment details", () => {
  const segment = { origin: "BER", destination: "LGW", departure: "2026-11-10T06:00", arrival: "2026-11-10T07:05",
    duration: "2h 5m", carrier: "U2" };
  for (const segments of [[], [segment]]) {
    const leg = { origin_airport: "BER", destination_airport: "LGW", departure: "2026-11-10T06:00",
      arrival: "2026-11-10T07:05", duration: "2h 5m", stops: 0, segments };
    const timelines = flightTimelines([{ outbound: leg }]);
    const html = render(leg, timelines.outbound, timelines.journeys.get(leg), "days");
    assert.doesNotMatch(html, /Nonstop/);
    assert.doesNotMatch(html, /leg-stops|leg-summary-hint/);
  }
});

test("a leg without segment times says so and shows its stop count", () => {
  const leg = { origin_airport: "BER", destination_airport: "SLP", departure: "2026-12-10T08:00",
    arrival: "2026-12-11T00:30", duration: "23h 30m", stops: 2, segments: [] };
  const timelines = flightTimelines([{ outbound: leg }]);
  const html = render(leg, timelines.outbound, timelines.journeys.get(leg), "days");
  assert.match(html, /Schedule not detailed/);
  assert.match(html, /class="leg-stops">2 stops</);
  assert.match(html, /00:30<sup>\+1<\/sup>/);
});

test("a short flight renders midnight divisions in the empty remainder of its shared timeline", () => {
  const short = { origin_airport: "BER", destination_airport: "MAD", departure: "2026-12-10T08:00",
    arrival: "2026-12-10T10:00", duration: "2h", stops: 0, segments: [] };
  const long = { ...short, arrival: "2026-12-12T09:00", duration: "49h" };
  const timelines = flightTimelines([{ outbound: short }, { outbound: long }]);
  const html = render(short, timelines.outbound, timelines.journeys.get(short));
  // 05:00 Dec 10 to 05:00 Dec 13 passes three midnights.
  assert.deepEqual([...html.matchAll(/class="leg-midnight" title="([^"]+)"/g)].map((m) => m[1]), ["Dec 11", "Dec 12", "Dec 13"]);
  assert.equal((html.match(/leg-part summary/g) || []).length, 1, "midnight lines do not add flight segments");
});

test("the exact Jetradar return renders five flights and a labeled airport transfer", () => {
  const timelines = flightTimelines([{ inbound }]);
  const html = render(inbound, timelines.inbound, timelines.journeys.get(inbound));
  assert.equal((html.match(/leg-part airborne/g) || []).length, 5);
  assert.equal((html.match(/leg-part layover/g) || []).length, 4);
  assert.equal((html.match(/leg-part layover transfer/g) || []).length, 1);
  assert.doesNotMatch(html, /leg-part summary/);
  assert.match(html, /title="Airport transfer MDW to ORD, 23h 4m"/);
  assert.match(html, /MDW→ORD/);
});

test("details identify MDW to ORD as an airport change with the same elapsed connection time", () => {
  const row = { inbound, outbound: null, offers: [], trip_key: "transfer", route: "BER-SLP",
    depart_date: "2026-12-10", arrival: "2026-12-11T12:16" };
  const html = renderToStaticMarkup(React.createElement(CurrencyProvider, { api: null },
    React.createElement(Details, { row, partyLabel: "1 adult", favorite: false, onToggleFavorite: () => {} })));
  assert.match(html, /title="Airport transfer MDW to ORD, 23h 4m"/);
  assert.match(html, /class="detail-connection-duration">23h 4m/);
  assert.match(html, /Change airports/);
  assert.doesNotMatch(html, /detail-transfer-route/);
  assert.doesNotMatch(html, /23h 4m in MDW/);
});

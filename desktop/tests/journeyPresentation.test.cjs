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
  export { TimelineTooltipProvider } from './src/TimelineTooltip';
  export { flightTimelines } from './src/flightTimeline';
`, resolveDir: path.join(__dirname, "..") }, bundle: true, external: ["react", "react-dom"],
  write: false, format: "cjs", platform: "node", jsx: "automatic", define: { "import.meta.env": "{}" } }).outputFiles[0].text;
const mod = { exports: {} };
vm.runInNewContext(code, { module: mod, exports: mod.exports, require, window: {},
  localStorage: { getItem: () => null } });
const { Details, CurrencyProvider, FlightTimeline, TimelineTooltipProvider, flightTimelines } = mod.exports;

test("a short flight renders midnight divisions in the empty remainder of its shared timeline", () => {
  const short = { origin_airport: "BER", destination_airport: "MAD", departure: "2026-12-10T08:00",
    arrival: "2026-12-10T10:00", duration: "2h", stops: 0, segments: [] };
  const long = { ...short, arrival: "2026-12-12T09:00", duration: "49h" };
  const timelines = flightTimelines([{ outbound: short }, { outbound: long }]);
  const html = renderToStaticMarkup(React.createElement(TimelineTooltipProvider, { resetKey: short },
    React.createElement(FlightTimeline, { leg: short, scale: timelines.outbound, timing: timelines.journeys.get(short) })));
  assert.equal((html.match(/class="timeline-guide"/g) || []).length, 2);
  assert.equal((html.match(/class="timeline-midnight"/g) || []).length, 2);
  assert.match(html, /Dec 11/);
  assert.match(html, /Dec 12/);
  assert.equal((html.match(/timeline-part summary/g) || []).length, 1, "guides do not add flight segments");
});

test("the exact Jetradar return renders five flights and a labeled airport transfer", () => {
  const timelines = flightTimelines([{ inbound }]);
  const html = renderToStaticMarkup(React.createElement(TimelineTooltipProvider, { resetKey: inbound },
    React.createElement(FlightTimeline, { leg: inbound, scale: timelines.inbound, timing: timelines.journeys.get(inbound) })));
  assert.equal((html.match(/timeline-part airborne/g) || []).length, 5);
  assert.equal((html.match(/timeline-part layover/g) || []).length, 4);
  assert.doesNotMatch(html, /timeline-part summary/);
  assert.match(html, /Airport transfer MDW to ORD, 23h 4m/);
  assert.match(html, /MDW.*ORD/);
});

test("details identify MDW to ORD as an airport change with the same elapsed connection time", () => {
  const row = { inbound, outbound: null, offers: [], trip_key: "transfer", route: "BER-SLP",
    depart_date: "2026-12-10", arrival: "2026-12-11T12:16" };
  const html = renderToStaticMarkup(React.createElement(CurrencyProvider, { api: null },
    React.createElement(Details, { row, partyLabel: "1 adult", favorite: false, onToggleFavorite: () => {} })));
  assert.match(html, /title="Airport transfer MDW to ORD, 23h 4m"/);
  assert.match(html, /class="detail-connection-duration">23h 4m/);
  assert.match(html, /class="detail-transfer-route">MDW.*ORD/);
  assert.doesNotMatch(html, /23h 4m in MDW/);
});

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildSync } = require("esbuild");
const vm = require("node:vm");
const path = require("node:path");
const code = buildSync({ entryPoints: [path.join(__dirname, "../src/flightTimeline.ts")],
  bundle: true, write: false, format: "cjs", platform: "node" }).outputFiles[0].text;
const mod = { exports: {} };
vm.runInNewContext(code, { module: mod, exports: mod.exports });
const { journeyTiming, flightTimelines, timelineScaleFor, timelineScaleLabel, normalizeTimelineMode, localMidnights } = mod.exports;
const leg = (clock, duration, extra = {}) => ({ departure: `2026-11-01T${clock}`, duration,
  arrival: "2026-11-02T01:30", origin_airport: "BER", destination_airport: "LHR", segments: [], ...extra });
const range = (flight) => timelineScaleFor(journeyTiming(flight), null, "days");

test("midnight ranges begin at 24 hours and extend only in three-hour steps", () => {
  for (const [duration, max] of [["30m", 1440], ["31m", 1620], ["3h 30m", 1620], ["3h 31m", 1800]]) {
    const scale = range(leg("23:30", duration));
    assert.equal(scale.min, 0);
    assert.equal(scale.max, max);
  }
  assert.equal(timelineScaleLabel(range(leg("23:30", "2h")), "days"), "27h · 03:00 +1");
});

test("early departures belong to their own midnight-based day", () => {
  const flight = leg("01:00", "1h", { arrival: "2026-11-01T02:00" });
  const scale = range(flight);
  assert.equal(scale.min, 0);
  assert.equal(scale.max, 1440);
  const marks = localMidnights(journeyTiming(flight), scale);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].at, 1440);
  assert.equal(marks[0].label, "Nov 2");
  assert.equal(range(leg("03:00", "1h")).min, 0);
  assert.equal(range(leg("02:59", "2m")).max, 1440);
});

test("24, 27, 30, 33 hour and longer intervals include their exact endpoints", () => {
  for (const hours of [24, 27, 30, 33, 48, 51, 96, 120, 192]) {
    const scale = range(leg("00:00", `${hours}h`));
    assert.equal(scale.max, hours * 60);
    assert.equal(scale.min, 0);
    assert.equal(timelineScaleLabel(scale, "days"), `${hours}h · ${String(hours % 24).padStart(2, "0")}:00 +${Math.floor(hours / 24)}`);
  }
});

test("day ranges use elapsed duration across timezone and DST changes", () => {
  const scale = range(leg("23:00-04:00", "3h", { arrival: "2026-11-02T09:00+01:00" }));
  assert.equal(scale.max - scale.min, 1620);
});

test("a shorter reported total cannot clip a known detailed arrival", () => {
  const flight = leg("23:00", "1h", { segments: [{ origin: "BER", destination: "LHR",
    departure: "2026-11-01T23:00", arrival: "2026-11-02T04:00", duration: "5h", carrier: "BA" }] });
  assert.equal(range(flight).max, 1800);
});

test("streaming outliers, sorting and filtering cannot stretch an existing day range", () => {
  const normal = leg("08:00", "2h"), long = leg("20:00", "61h 36m"), early = leg("01:00", "2h");
  const original = range(normal);
  for (const rows of [[{ outbound: normal }], [{ outbound: long }, { outbound: early }, { outbound: normal }],
    [{ outbound: normal }, { outbound: early }, { outbound: long }]]) {
    const all = flightTimelines(rows);
    const scale = timelineScaleFor(all.journeys.get(normal), all.outbound, "days");
    assert.equal(scale.min, original.min);
    assert.equal(scale.max, original.max);
  }
});

test("round trips choose independent outbound and return ranges", () => {
  const outbound = leg("08:00", "2h"), inbound = leg("20:00", "40h");
  const all = flightTimelines([{ outbound, inbound }]);
  assert.equal(timelineScaleFor(all.journeys.get(outbound), all.outbound, "days").max, 1440);
  assert.equal(timelineScaleFor(all.journeys.get(inbound), all.inbound, "days").max, 3600);
});

test("shared mode retains filtered bounds and invalid schedules have no scale", () => {
  const flight = leg("08:00", "2h");
  const all = flightTimelines([{ outbound: flight }]);
  assert.equal(timelineScaleFor(all.journeys.get(flight), all.outbound, "shared"), all.outbound);
  assert.equal(timelineScaleLabel(all.outbound, "shared"), "Shared scale");
  assert.equal(timelineScaleFor(null, all.outbound, "days"), null);
  assert.equal(timelineScaleFor(undefined, all.outbound, "shared"), null);
  assert.equal(range(leg("invalid", "2h")), null);
  assert.equal(normalizeTimelineMode(null), "days");
  assert.equal(normalizeTimelineMode("unknown"), "days");
  assert.equal(normalizeTimelineMode("shared"), "shared");
});

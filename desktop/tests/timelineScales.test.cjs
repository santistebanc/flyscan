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

test("late flights arriving before or exactly at the 03:00 cutoff fit one day", () => {
  for (const duration of ["2h", "3h 30m"]) {
    const scale = range(leg("23:30", duration));
    assert.equal(scale.min, 180);
    assert.equal(scale.max, 1620);
    assert.equal(timelineScaleLabel(scale, "days"), "1 day · 03:00");
  }
  assert.equal(range(leg("23:30", "3h 31m")).max, 3060);
});

test("departures before 03:00 belong to the previous day's range", () => {
  const flight = leg("01:00", "1h", { arrival: "2026-11-01T02:00" });
  const scale = range(flight);
  assert.equal(scale.min, -1260);
  assert.equal(scale.max, 180);
  const marks = localMidnights(journeyTiming(flight), scale);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].at, 0);
  assert.equal(marks[0].label, "Nov 1");
  assert.equal(range(leg("03:00", "1h")).min, 180);
  assert.equal(range(leg("02:59", "2m")).max, 1620);
});

test("ranges use whole days without clipping long journeys", () => {
  for (const days of [1, 2, 3, 4, 5, 8]) {
    const scale = range(leg("03:00", `${days * 24}h`));
    assert.equal(scale.max - scale.min, days * 1440);
    assert.equal(timelineScaleLabel(scale, "days"), `${days} day${days === 1 ? "" : "s"} · 03:00`);
  }
});

test("day ranges use elapsed duration across timezone and DST changes", () => {
  const scale = range(leg("23:00-04:00", "3h", { arrival: "2026-11-02T09:00+01:00" }));
  assert.equal(scale.max - scale.min, 1440);
});

test("a shorter reported total cannot clip a known detailed arrival", () => {
  const flight = leg("23:00", "1h", { segments: [{ origin: "BER", destination: "LHR",
    departure: "2026-11-01T23:00", arrival: "2026-11-02T04:00", duration: "5h", carrier: "BA" }] });
  assert.equal(range(flight).max, 3060);
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
  assert.equal(timelineScaleFor(all.journeys.get(outbound), all.outbound, "days").max, 1620);
  assert.equal(timelineScaleFor(all.journeys.get(inbound), all.inbound, "days").max, 4500);
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

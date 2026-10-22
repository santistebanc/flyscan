const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildSync } = require("esbuild");
const vm = require("node:vm");
const path = require("node:path");
const code = buildSync({ entryPoints: [path.join(__dirname, "../src/flightTimeline.ts")],
  bundle: true, write: false, format: "cjs", platform: "node" }).outputFiles[0].text;
const mod = { exports: {} };
vm.runInNewContext(code, { module: mod, exports: mod.exports });
const { journeyTiming, flightTimelines, timelineScaleFor, timelineScaleLabel, normalizeTimelineMode, localMidnights, timelineStartDate } = mod.exports;
const leg = (clock, duration, extra = {}) => ({ departure: `2026-11-01T${clock}`, duration,
  arrival: "2026-11-02T01:30", origin_airport: "BER", destination_airport: "LHR", segments: [], ...extra });
const range = (flight) => timelineScaleFor(journeyTiming(flight), null, "days");

test("the left edge shows the date of the six-hour range", () => {
  const flight = leg('22:45+03:00','14h 45m');
  const start = timelineStartDate(journeyTiming(flight), range(flight), flight.departure);
  assert.equal(start.at,1020);assert.equal(start.label,'Nov 1');
});

test("the starting label omits padding on another date, including across a year boundary", () => {
  const flight = leg('01:00+03:00','2h',{departure:'2027-01-01T01:00+03:00'});
  const start = timelineStartDate(journeyTiming(flight),{min:-60},flight.departure);
  assert.equal(start,null);
  assert.equal(timelineStartDate(journeyTiming(flight),{min:0},flight.departure).label,'Jan 1');
  assert.equal(timelineStartDate(journeyTiming(flight),{min:1440},flight.departure),null);
  assert.equal(timelineStartDate(journeyTiming(flight),{min:0},'unknown'),null);
});

test("ranges pad the surrounding six-hour checkpoints by one hour", () => {
  for (const [duration, max] of [["30m", 1500], ["31m", 1860], ["6h 30m", 1860], ["6h 31m", 2220]]) {
    const scale = range(leg("23:30", duration));
    assert.equal(scale.min, 1020);
    assert.equal(scale.max, max);
  }
  assert.equal(timelineScaleLabel(range(leg("08:00", "6h")), "days"), "05:00 – 19:00");
});

test("padding before midnight keeps its clock but omits the previous date label", () => {
  const flight = leg("01:00", "1h", { arrival: "2026-11-01T02:00" });
  const scale = range(flight);
  assert.equal(scale.min, -60);
  assert.equal(scale.max, 420);
  const marks = localMidnights(journeyTiming(flight), scale);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].at, 0);
  assert.equal(timelineStartDate(journeyTiming(flight),scale,flight.departure),null);
  assert.equal(timelineScaleLabel(scale,"days"),"23:00 -1 – 07:00");
});

test("exact six-hour endpoints retain padding without another interval, including multi-day flights", () => {
  for (const hours of [6, 12, 24, 30, 48, 96, 120, 192]) {
    const scale = range(leg("00:00", `${hours}h`));
    assert.equal(scale.max, hours * 60 + 60);
    assert.equal(scale.min, -60);
  }
});

test("ranges use elapsed duration across timezone and DST changes", () => {
  const scale = range(leg("23:00-04:00", "3h", { arrival: "2026-11-02T09:00+01:00" }));
  assert.equal(scale.min,1020);
  assert.equal(scale.max,1860);
});

test("ranges can start at every six-hour checkpoint and grow in six-hour intervals", () => {
  for (const start of [0, 6, 12, 18]) {
    for (const offset of [0, 1, 359]) {
      const minute = start * 60 + offset;
      const clock = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
      for (const duration of ["1m", "6h", "12h", "36h 1m"]) {
        const flight = leg(clock, duration), timing = journeyTiming(flight), scale = range(flight);
        assert.equal(scale.min, start * 60 - 60);
        assert.equal((scale.max - scale.min - 120) % 360, 0);
        assert.ok(scale.max - scale.min >= 480);
        assert.ok(scale.min + 60 <= timing.start && scale.max - 60 >= timing.end);
        assert.ok(scale.max - 60 - timing.end < 360);
      }
    }
  }
});

test("a shorter reported total cannot clip a known detailed arrival", () => {
  const flight = leg("23:00", "1h", { segments: [{ origin: "BER", destination: "LHR",
    departure: "2026-11-01T23:00", arrival: "2026-11-02T04:00", duration: "5h", carrier: "BA" }] });
  assert.equal(range(flight).max, 1860);
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
  assert.equal(timelineScaleFor(all.journeys.get(outbound), all.outbound, "days").max, 780);
  assert.equal(timelineScaleFor(all.journeys.get(inbound), all.inbound, "days").max, 3660);
});

test("shared mode rounds filtered bounds to six-hour checkpoints and invalid schedules have no scale", () => {
  const flight = leg("08:00", "2h");
  const all = flightTimelines([{ outbound: flight }]);
  const shared=timelineScaleFor(all.journeys.get(flight), all.outbound, "shared");
  assert.equal(shared.min,300);assert.equal(shared.max,780);
  assert.equal(timelineScaleFor(all.journeys.get(flight),null,"shared"),null);
  assert.equal(timelineScaleLabel(all.outbound, "shared"), "Shared scale");
  assert.equal(timelineScaleFor(null, all.outbound, "days"), null);
  assert.equal(timelineScaleFor(undefined, all.outbound, "shared"), null);
  assert.equal(range(leg("invalid", "2h")), null);
  assert.equal(normalizeTimelineMode(null), "days");
  assert.equal(normalizeTimelineMode("unknown"), "days");
  assert.equal(normalizeTimelineMode("shared"), "shared");
});

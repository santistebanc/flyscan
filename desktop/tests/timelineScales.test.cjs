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
  origin_airport: "BER", destination_airport: "LHR", segments: [], ...extra });
const range = (flight) => timelineScaleFor(journeyTiming(flight), null, "days");

test("the left edge shows the date of the range", () => {
  const flight = leg('22:45+03:00','14h 45m');
  const start = timelineStartDate(journeyTiming(flight), range(flight), flight.departure);
  assert.equal(start.at,300);assert.equal(start.label,'Nov 1');
});

test("the starting label omits padding on another date, including across a year boundary", () => {
  const flight = leg('01:00+03:00','2h',{departure:'2027-01-01T01:00+03:00'});
  const start = timelineStartDate(journeyTiming(flight),{min:-60},flight.departure);
  assert.equal(start,null);
  assert.equal(timelineStartDate(journeyTiming(flight),{min:0},flight.departure).label,'Jan 1');
  assert.equal(timelineStartDate(journeyTiming(flight),{min:1440},flight.departure),null);
  assert.equal(timelineStartDate(journeyTiming(flight),{min:0},'unknown'),null);
});

test("ranges run from 05:00 to 05:00 in whole days", () => {
  for (const [clock, duration, min, max] of [["23:30", "30m", 300, 1740], ["05:00", "1h", 300, 1740],
    ["23:30", "6h", 300, 3180], ["04:59", "1m", -1140, 300], ["05:00", "24h", 300, 1740], ["05:00", "48h", 300, 3180]]) {
    const scale = range(leg(clock, duration));
    assert.equal(scale.min, min, `${clock} ${duration}`);
    assert.equal(scale.max, max, `${clock} ${duration}`);
  }
  assert.equal(timelineScaleLabel(range(leg("08:00", "6h")), "days"), "05:00 – 05:00 +1");
});

test("a departure before 05:00 starts on the previous day and omits its date label", () => {
  const flight = leg("01:00", "1h", { arrival: "2026-11-01T02:00" });
  const scale = range(flight);
  assert.equal(scale.min, -1140);
  assert.equal(scale.max, 300);
  const marks = localMidnights(journeyTiming(flight), scale);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].at, 0);
  assert.equal(timelineStartDate(journeyTiming(flight),scale,flight.departure),null);
  assert.equal(timelineScaleLabel(scale,"days"),"05:00 -1 – 05:00");
});

test("ranges use elapsed duration across timezone and DST changes", () => {
  const scale = range(leg("23:00-04:00", "3h", { arrival: "2026-11-02T07:00+01:00" }));
  assert.equal(scale.min,300);
  assert.equal(scale.max,2880);
  assert.equal(timelineScaleLabel(scale,"days"),"05:00 – 05:00 +2");
});

test("the end of the range follows the destination clock", () => {
  // BER 06:00 to LGW 07:05 is 2h 05m: the axis ends at 05:00 London, not Berlin.
  const west = range(leg("06:00+01:00", "2h 5m", { arrival: "2026-11-01T07:05+00:00" }));
  assert.equal(west.min, 300);
  assert.equal(west.max, 1800);
  assert.equal(timelineScaleLabel(west, "days"), "05:00 – 05:00 +1");
  // Landing before 05:00 by the local clock still spans a whole day.
  const early = range(leg("05:10+01:00", "10m", { arrival: "2026-11-01T04:20+00:00" }));
  assert.equal(early.max + early.arrivalShift, 1740);
  const delhi = range(leg("22:00+01:00", "8h", { arrival: "2026-11-02T10:30+05:30" }));
  assert.equal(delhi.max, 2910);
  assert.equal(timelineScaleLabel(delhi, "days"), "05:00 – 05:00 +2");
  // The shared scale spans many destinations and keeps the departure clock.
  const all = flightTimelines([{ outbound: leg("06:00+01:00", "2h 5m", { arrival: "2026-11-01T07:05+00:00" }) }]);
  assert.equal(timelineScaleFor([...all.journeys.values()][0], all.outbound, "shared").arrivalShift, undefined);
});

test("every departure and duration gets the closest whole days around it", () => {
  const atFive = (minute) => ((minute - 300) % 1440 + 1440) % 1440 === 0;
  for (let minute = 0; minute < 1440; minute += 59) {
    const clock = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
    for (const duration of ["1m", "6h", "12h", "36h 1m"]) {
      const flight = leg(clock, duration), timing = journeyTiming(flight), scale = range(flight);
      assert.ok(atFive(scale.min) && atFive(scale.max));
      assert.ok(scale.min <= timing.start && timing.start < scale.min + 1440);
      assert.ok(scale.max >= timing.end && scale.max - timing.end <= 1440);
    }
  }
});

test("a shorter reported total cannot clip a known detailed arrival", () => {
  const flight = leg("23:00", "1h", { segments: [{ origin: "BER", destination: "LHR",
    departure: "2026-11-01T23:00", arrival: "2026-11-02T06:00", duration: "7h", carrier: "BA" }] });
  assert.equal(range(flight).max, 3180);
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
  assert.equal(timelineScaleFor(all.journeys.get(outbound), all.outbound, "days").max, 1740);
  assert.equal(timelineScaleFor(all.journeys.get(inbound), all.inbound, "days").max, 4620);
});

test("shared mode rounds filtered bounds to 05:00 and invalid schedules have no scale", () => {
  const flight = leg("08:00", "2h");
  const all = flightTimelines([{ outbound: flight }]);
  const shared=timelineScaleFor(all.journeys.get(flight), all.outbound, "shared");
  assert.equal(shared.min,300);assert.equal(shared.max,1740);
  assert.equal(timelineScaleFor(all.journeys.get(flight),null,"shared"),null);
  assert.equal(timelineScaleLabel(all.outbound, "shared"), "Shared scale");
  assert.equal(timelineScaleFor(null, all.outbound, "days"), null);
  assert.equal(timelineScaleFor(undefined, all.outbound, "shared"), null);
  assert.equal(range(leg("invalid", "2h")), null);
  assert.equal(normalizeTimelineMode(null), "days");
  assert.equal(normalizeTimelineMode("unknown"), "days");
  assert.equal(normalizeTimelineMode("shared"), "shared");
});

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildSync } = require("esbuild");
const vm = require("node:vm");
const path = require("node:path");
const code = buildSync({ entryPoints: [path.join(__dirname, "../src/timelineHourTicks.ts")],
  bundle: true, write: false, format: "cjs", platform: "node" }).outputFiles[0].text;
const mod = { exports: {} };
vm.runInNewContext(code, { module: mod, exports: mod.exports });
const { timelineHourTicks } = mod.exports;
const timingCode = buildSync({ entryPoints: [path.join(__dirname, "../src/flightTimeline.ts")],
  bundle: true, write: false, format: "cjs", platform: "node" }).outputFiles[0].text;
const timingMod = { exports: {} };
vm.runInNewContext(timingCode, { module: timingMod, exports: timingMod.exports });
const { journeyTiming, localMidnights } = timingMod.exports;

test("day ranges show rounded hours and reduce density on narrow plots", () => {
  const scale = { min: 180, max: 1620 };
  const wide = timelineHourTicks(scale, 1000), narrow = timelineHourTicks(scale, 200);
  assert.ok(wide.length > narrow.length);
  assert.equal(wide[1].at - wide[0].at, 60);
  assert.equal(narrow[1].at - narrow[0].at, 180);
  for (const ticks of [wide, narrow]) {
    assert.ok(ticks.filter(tick => tick.label).length < ticks.length);
    assert.ok(ticks.filter(tick => tick.label).length >= 2);
  }
  for (const tick of [...wide, ...narrow]) {
    assert.equal(tick.at % 60, 0);
    assert.ok(tick.at >= scale.min && tick.at <= scale.max);
    if (tick.label) assert.match(tick.label, /^\d{2}:00$/);
  }
});

test("hour labels wrap correctly before day zero and after midnight", () => {
  const ticks = timelineHourTicks({ min: -1260, max: 180 }, 1000);
  assert.equal(ticks.find((tick) => tick.at === -1080).label, "06:00");
  assert.equal(ticks.find((tick) => tick.at === 0).label, "00:00");
  assert.equal(timelineHourTicks({ min: 1440, max: 1560 }, 400)[0].label, "00:00");
});

test("shared bounds keep hour ticks aligned instead of inventing boundary times", () => {
  const ticks = timelineHourTicks({ min: 8 * 60 + 19, max: 11 * 60 + 47 }, 800);
  assert.equal(ticks[0].at, 8 * 60 + 30);
  const labels = ticks.filter(tick => tick.label);
  assert.equal(labels[0].at, 9 * 60);
  assert.equal(labels[0].label, "09:00");
  assert.equal(labels.at(-1).label, "11:00");
});

test("long ranges keep bounded tick counts and readable spacing as width changes", () => {
  for (const span of [1440, 2880, 5760, 30000, 1e7]) {
    for (const width of [100, 200, 600, 1200]) {
      const scale = { min: 180, max: 180 + span };
      const ticks = timelineHourTicks(scale, width);
      assert.ok(ticks.length <= Math.floor(width / 24) + 1);
      const labels = ticks.filter(tick => tick.label);
      assert.ok(labels.length < ticks.length);
      for (let i = 1; i < labels.length; i++) {
        const center = tick => Math.max(15, Math.min(width - 15, (tick.at - scale.min) / span * width));
        assert.ok(center(labels[i]) - center(labels[i - 1]) >= 88);
      }
      for (let i = 1; i < ticks.length; i++) {
        assert.ok((ticks[i].at - ticks[i - 1].at) / span * width >= 24 - .01);
      }
    }
  }
});

function flight(departure, arrival, duration) {
  return journeyTiming({ departure, arrival, duration, origin_airport: "AAA", destination_airport: "BBB",
    segments: [{ origin: "AAA", destination: "BBB", departure, arrival, duration }] });
}

test("one whole-timeline interval is retained through a timezone-compressed flight", () => {
  const timing = flight("2026-11-01T08:00Z", "2026-11-01T16:00+06:00", "2h");
  const scale = { min: 0, max: 1440 };
  for (const [width, step] of [[1000, 60], [300, 120]]) {
    const ticks = timelineHourTicks(scale, width, timing);
    assert.ok(ticks.some(tick => tick.at === step), "empty range space uses the selected interval");
    for (let wall = 480; wall <= 960; wall += step) {
      const position = 480 + (wall - 480) / 4;
      assert.ok(ticks.some(tick => Math.abs(tick.at - position) < .001),
        `${step}-minute local checkpoint ${wall} must remain inside the flight at ${position}`);
    }
    assert.ok(ticks.some(tick => tick.at === 600 + step), "the same interval continues after landing");
  }
});

test("the same chosen interval follows a clock that reverses during a westbound flight", () => {
  const timing = flight("2026-11-01T12:00+09:00", "2026-11-01T08:00-08:00", "13h");
  const ticks = timelineHourTicks({ min: 0, max: 1620 }, 1000, timing);
  assert.ok(ticks.some(tick => tick.at === 60));
  for (let hour = 8; hour <= 12; hour++) {
    const position = 720 + (12 - hour) / 4 * 780;
    assert.ok(ticks.some(tick => Math.abs(tick.at - position) < .001));
  }
  assert.ok(!ticks.some(tick => tick.at > 720 && tick.at < 915), "no extra half-hour ticks are introduced in flight");
});

test("eastbound checkpoints interpolate airport clocks without stretching the flight", () => {
  const timing = flight("2026-11-01T20:00-05:00", "2026-11-02T10:00+01:00", "8h");
  const scale = { min: 1200, max: 1680 };
  const ticks = timelineHourTicks(scale, 1400, timing);
  assert.equal(timing.end - timing.start, 480);
  const midnight = ticks.find(tick => tick.label === "00:00");
  assert.ok(Math.abs(midnight.at - (1200 + 4 / 14 * 480)) < .001);
  assert.equal(midnight.at, localMidnights(timing, scale)[0].at);
  assert.equal(ticks.at(-1).at, 1680);
  assert.ok(Math.abs(ticks.find(tick => tick.label === "06:00").at - (1200 + 10 / 14 * 480)) < .001);
});

test("westbound local clocks can run backwards as elapsed positions advance", () => {
  const timing = flight("2026-11-01T12:00+09:00", "2026-11-01T08:00-08:00", "13h");
  const ticks = timelineHourTicks({ min: timing.start, max: timing.end }, 1000, timing);
  const labels = ticks.filter(tick => tick.label);
  assert.equal(labels[0].label, "12:00");
  assert.equal(labels.at(-1).label, "08:00");
  assert.ok(labels.some(tick => tick.label === "10:00"));
  assert.equal(timing.end - timing.start, 780);
});

test("range space after landing continues the destination clock", () => {
  const timing = flight("2026-11-01T08:00+01:00", "2026-11-01T08:45Z", "1h 45m");
  const ticks = timelineHourTicks({ min: 0, max: 1440 }, 1200, timing);
  const noon = ticks.find(tick => tick.label === "12:00");
  assert.equal(noon.at, 780, "destination noon is origin-reference 13:00 after the one-hour change");
});

test("connection clocks and DST-offset changes share the same mapping", () => {
  const timing = journeyTiming({ departure: "2026-10-25T00:00+02:00", arrival: "2026-10-25T04:30+01:00", duration: "5h 30m",
    segments: [
      { origin: "AAA", destination: "BBB", departure: "2026-10-25T00:00+02:00", arrival: "2026-10-25T01:30+02:00", duration: "1h 30m" },
      { origin: "BBB", destination: "CCC", departure: "2026-10-25T02:30+01:00", arrival: "2026-10-25T04:30+01:00", duration: "2h" },
    ] });
  const ticks = timelineHourTicks({ min: 0, max: 330 }, 1600, timing);
  assert.equal(ticks.find(tick => tick.label === "02:00").at, 150);
  assert.equal(ticks.find(tick => tick.label === "04:00").at, 300);
});

test("stationary local clocks and unknown timestamps do not invent checkpoint labels", () => {
  const timing = flight("2026-11-01T12:00+02:00", "2026-11-01T12:00Z", "2h");
  assert.equal(timelineHourTicks({ min: timing.start, max: timing.end }, 600, timing).length, 0);
  const missing = flight("2026-11-01T12:00", "unknown", "2h");
  assert.equal(timelineHourTicks({ min: missing.start, max: missing.end }, 600, missing).length, 0);
});

test("unavailable sizes and invalid ranges cannot produce fake labels", () => {
  for (const width of [0, -1, 39, NaN, Infinity]) {
    assert.equal(timelineHourTicks({ min: 0, max: 1440 }, width).length, 0);
  }
  for (const scale of [{ min: 10, max: 10 }, { min: 20, max: 10 }, { min: 0, max: Infinity }]) {
    assert.equal(timelineHourTicks(scale, 800).length, 0);
  }
});

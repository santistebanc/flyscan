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

test("day ranges show rounded hours and reduce density on narrow plots", () => {
  const scale = { min: 180, max: 1620 };
  const wide = timelineHourTicks(scale, 1000), narrow = timelineHourTicks(scale, 200);
  assert.ok(wide.length > narrow.length);
  assert.equal(wide[1].at - wide[0].at, 120);
  assert.equal(narrow[1].at - narrow[0].at, 720);
  for (const tick of [...wide, ...narrow]) {
    assert.equal(tick.at % 60, 0);
    assert.ok(tick.at >= scale.min && tick.at <= scale.max);
    assert.match(tick.label, /^\d{2}:00$/);
  }
});

test("hour labels wrap correctly before day zero and after midnight", () => {
  const ticks = timelineHourTicks({ min: -1260, max: 180 }, 1000);
  assert.equal(ticks.find((tick) => tick.at === -1200).label, "04:00");
  assert.equal(ticks.find((tick) => tick.at === 0).label, "00:00");
  assert.equal(timelineHourTicks({ min: 1440, max: 1560 }, 400)[0].label, "00:00");
});

test("shared bounds keep hour ticks aligned instead of inventing boundary times", () => {
  const ticks = timelineHourTicks({ min: 8 * 60 + 19, max: 11 * 60 + 47 }, 800);
  assert.equal(ticks[0].at, 9 * 60);
  assert.equal(ticks[0].label, "09:00");
  assert.equal(ticks.at(-1).label, "11:00");
});

test("long ranges keep bounded tick counts and readable spacing as width changes", () => {
  for (const span of [1440, 2880, 5760, 30000, 1e7]) {
    for (const width of [100, 200, 600, 1200]) {
      const scale = { min: 180, max: 180 + span };
      const ticks = timelineHourTicks(scale, width);
      assert.ok(ticks.length <= Math.floor(width / 64) + 1);
      for (let i = 1; i < ticks.length; i++) {
        assert.ok((ticks[i].at - ticks[i - 1].at) / span * width >= 64);
      }
    }
  }
});

test("unavailable sizes and invalid ranges cannot produce fake labels", () => {
  for (const width of [0, -1, 39, NaN, Infinity]) {
    assert.equal(timelineHourTicks({ min: 0, max: 1440 }, width).length, 0);
  }
  for (const scale of [{ min: 10, max: 10 }, { min: 20, max: 10 }, { min: 0, max: Infinity }]) {
    assert.equal(timelineHourTicks(scale, 800).length, 0);
  }
});

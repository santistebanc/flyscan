const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildSync } = require("esbuild");
const vm = require("node:vm");
const path = require("node:path");
const code = buildSync({ entryPoints: [path.join(__dirname, "../src/dates.ts")],
  bundle: true, write: false, format: "cjs", platform: "node" }).outputFiles[0].text;
const mod = { exports: {} };
vm.runInNewContext(code, { module: mod, exports: mod.exports, Date, Math });
const { yearMatters, yearIfFar } = mod.exports;

test("a date carries its year only when it is more than 365 days from today", () => {
  const now = new Date(2026, 9, 30, 9).getTime();   // 30 Oct 2026, local
  assert.equal(yearMatters("2027-01-06", now), false, "next January is not far enough");
  assert.equal(yearMatters("2027-10-30", now), false, "365 days out");
  assert.equal(yearMatters("2027-10-31", now), true, "366 days out");
  assert.equal(yearMatters("2025-10-30", now), false, "365 days ago");
  assert.equal(yearMatters("2025-10-29", now), true, "366 days ago");
  assert.equal(yearMatters("2028-01-05T09:30:00", now), true, "timestamps use their calendar day");
  assert.equal(yearMatters("", now), false);
  assert.equal(yearMatters("not a date", now), false);
});

test("the year option is spread into date formatting only when it matters", () => {
  const now = new Date(2026, 9, 30, 9).getTime();
  assert.deepEqual({ ...yearIfFar("2027-01-06", now) }, {});
  assert.deepEqual({ ...yearIfFar("2028-01-06", now) }, { year: "numeric" });
});

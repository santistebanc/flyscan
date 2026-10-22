const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildSync } = require("esbuild");
const vm = require("node:vm");
const path = require("node:path");
const code = buildSync({ entryPoints: [path.join(__dirname, "../src/RangePicker.tsx")],
  bundle: true, external: ["react"], write: false, format: "cjs", platform: "node", jsx: "automatic" }).outputFiles[0].text;
const mod = { exports: {} };
vm.runInNewContext(code, { module: mod, exports: mod.exports, require });
const { initialCalendarView } = mod.exports;
test("return ranges open in the right month and departures retain the left month", () => {
  const back=initialCalendarView('2026-11-23','2026-11-30','2026-10-21','right');
  assert.equal(back.month.month,9);assert.equal(back.month.year,2026);assert.equal(back.cursor,'2026-11-30');
  const out=initialCalendarView('2026-11-23','2026-11-30','2026-10-21');
  assert.equal(out.month.month,10);assert.equal(out.cursor,'2026-11-23');
});
test("a return range crossing months opens both months and handles January", () => {
  const span=initialCalendarView('2026-11-30','2026-12-03','2026-10-21','right');
  assert.equal(span.month.month,10);assert.equal(span.cursor,'2026-12-03');
  const january=initialCalendarView('2027-01-02','2027-01-05','2026-12-01','right');
  assert.equal(january.month.year,2026);assert.equal(january.month.month,11);
});
test("empty return selections put the departure month on the left", () => {
  const view=initialCalendarView('','','2026-11-23','right');
  assert.equal(view.month.month,10);assert.equal(view.cursor,'2026-11-23');
  const january=initialCalendarView('','','2027-01-02','right');
  assert.equal(january.month.year,2027);assert.equal(january.month.month,0);
  assert.equal(january.cursor,'2027-01-02');
});

test("a return start without an ending date is still a selection on the right", () => {
  const view=initialCalendarView('2026-12-03','','2026-11-23','right');
  assert.equal(view.month.month,10);assert.equal(view.cursor,'2026-12-03');
});

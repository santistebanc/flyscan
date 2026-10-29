const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildSync } = require("esbuild");
const vm = require("node:vm");
const path = require("node:path");
const code = buildSync({ entryPoints: [path.join(__dirname, "../src/relativeTime.ts")],
  bundle: true, write: false, format: "cjs", platform: "node" }).outputFiles[0].text;
const mod = { exports: {} };
vm.runInNewContext(code, { module: mod, exports: mod.exports, Intl, Date });
const { timeAgo } = mod.exports;

test("prices say how long ago they were quoted, in the coarsest unit that fits", () => {
  const now = Date.parse("2026-12-10T12:00:00Z");
  const before = (seconds) => new Date(now - seconds * 1000).toISOString();
  assert.equal(timeAgo(before(20), now), "just now");
  assert.equal(timeAgo(before(5 * 60), now), "5 minutes ago");
  assert.equal(timeAgo(before(3 * 3600 + 1200), now), "3 hours ago");
  assert.equal(timeAgo(before(30 * 3600), now), "yesterday");
  assert.equal(timeAgo(before(9 * 86400), now), "last week");
  assert.equal(timeAgo(before(70 * 86400), now), "2 months ago");
  assert.equal(timeAgo(undefined, now), "");
  assert.equal(timeAgo("not a date", now), "");
});

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildSync } = require("esbuild");
const vm = require("node:vm");
const path = require("node:path");
const code = buildSync({ entryPoints: [path.join(__dirname, "../src/timelineDateLayout.ts")],
  bundle: true, write: false, format: "cjs", platform: "node" }).outputFiles[0].text;
const mod = { exports: {} };
vm.runInNewContext(code, { module: mod, exports: mod.exports });
const { layoutTimelineDates } = mod.exports;

test("separated dates share one reserved date row", () => {
  const layout = layoutTimelineDates(500, [{ at: 100, width: 40 }, { at: 300, width: 40 }]);
  assert.equal(layout.height, 18);
  assert.equal(layout.positions[0].top, 0);
  assert.equal(layout.positions[1].top, 0);
  assert.equal(layout.positions[0].left, 80);
});

test("dates at either edge stay inside the plot", () => {
  const layout = layoutTimelineDates(200, [{ at: 0, width: 40 }, { at: 200, width: 48 }]);
  assert.equal(layout.positions[0].left, 0);
  assert.equal(layout.positions[1].left, 152);
});

test("crowded indicators gain rows and shrink back after resizing", () => {
  const labels = [{ at: 20, width: 42 }, { at: 40, width: 42 }, { at: 60, width: 42 }];
  const narrow = layoutTimelineDates(80, labels);
  assert.ok(narrow.height > 18);
  const wide = layoutTimelineDates(800, labels.map((label) => ({ ...label, at: label.at * 10 })));
  assert.equal(wide.height, 18);
  assert.equal(layoutTimelineDates(800, []).height, 18);
});

test("dense and coincident midnight markers never overlap or escape their reserved rows", () => {
  for (const width of [48, 80, 150, 206, 500, 1500]) {
    for (const offsets of [[0, .01, .02, .9, 1], [.2, .4, .6, .8, 1], [.5, .5, .5]]) {
      const labels = offsets.map((fraction, i) => ({ at: fraction * width, width: 35 + i * 3 }));
      const layout = layoutTimelineDates(width, labels);
      layout.positions.forEach((pos, i) => {
        const right = pos.left + labels[i].width;
        assert.ok(pos.left >= 0 && right <= width, "date must stay within the plot");
        assert.ok(pos.top + 14 <= layout.height - 4, "date row must include spacing before the track");
        layout.positions.slice(0, i).forEach((before, j) => {
          if (before.top === pos.top) assert.ok(pos.left >= before.left + labels[j].width + 4,
            "dates sharing a row must have a readable gap");
        });
      });
    }
  }
});

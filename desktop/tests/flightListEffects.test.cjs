const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const path = require("node:path");
const { buildSync } = require("esbuild");
const bundle = buildSync({ entryPoints: [path.join(__dirname, "../src/useFlightListEffects.ts")],
  bundle: true, external: ["react"], write: false, format: "cjs", platform: "node" }).outputFiles[0].text;

/** Drive the actual hooks across layout commits, scrolls and virtual remounts. */
function host() {
  let cursor = 0, now = 0, reduced = false;
  const refs = [], effects = [], scrolls = [], animations = [];
  const nodes = new Map();
  let selection = "selected";
  const window = { scrollY: 500, innerHeight: 800,
    scrollBy(options) { scrolls.push(options); this.scrollY += options.top; },
    matchMedia: () => ({ matches: reduced }) };
  const node = (key, start = 800, height = 84) => {
    const item = { start, height, dataset: { flightKey: key },
      getBoundingClientRect() { return { top: this.start - window.scrollY, bottom: this.start + this.height - window.scrollY, height: this.height }; },
      animate(frames, options) { animations.push({ key, frames, options }); } };
    nodes.set(key, item); return item;
  };
  node("selected");
  const list = { current: {
    querySelector: () => nodes.get(selection),
    querySelectorAll: () => [...nodes.values()],
  } };
  const mod = { exports: {} };
  vm.runInNewContext(bundle, { module: mod, exports: mod.exports, window,
    performance: { now: () => now },
    document: { querySelector: () => ({ getBoundingClientRect: () => ({ bottom: 100 }) }) },
    require: (name) => { assert.equal(name, "react"); return {
      useRef(value) { return refs[cursor++] ??= { current: value }; },
      useLayoutEffect(fn) { effects.push(fn); },
    }; } });
  return { node, nodes, window, animations, scrolls,
    setReduced: (value) => { reduced = value; }, advance: (ms) => { now += ms; },
    render(dataset = [], selected = selection) {
      selection = selected; cursor = 0;
      const anchored = mod.exports.useSelectedFlightAnchor(list, selected);
      mod.exports.useFlightArrivals(list, dataset);
      while (effects.length) effects.shift()();
      return anchored();
    },
  };
}
const flight = (trip_key) => ({ trip_key });

test("inserts, removals and measured row-height changes preserve the selected flight's viewport position", () => {
  const ui = host();
  ui.render();
  const selected = ui.nodes.get("selected");
  for (const shift of [1600, -1100, 37, -12]) {
    selected.start += shift;
    ui.render();
    assert.equal(selected.getBoundingClientRect().top, 300);
    assert.equal(ui.scrolls.at(-1).behavior, "instant");
  }
  ui.render();
  assert.equal(ui.scrolls.length, 4, "unchanged commits must not scroll");
});

test("manual scrolling changes the anchor naturally and scrolling away releases it", () => {
  const ui = host();
  ui.render();
  ui.window.scrollY += 80; // A scroll can happen between React commits.
  ui.nodes.get("selected").start += 200;
  ui.render();
  assert.equal(ui.nodes.get("selected").getBoundingClientRect().top, 220);
  ui.window.scrollY += 600;
  ui.nodes.get("selected").start += 100;
  ui.render();
  assert.equal(ui.scrolls.length, 1, "an offscreen selection must not pull the user back");
});

test("device-pixel rounding cannot accumulate vertical drift over repeated result updates", () => {
  const ui = host();
  ui.window.scrollBy = ({ top }) => { ui.window.scrollY = Math.round((ui.window.scrollY + top) * 1.5) / 1.5; };
  ui.render();
  for (let i = 0; i < 60; i++) {
    ui.nodes.get("selected").start += 84.1;
    ui.render();
    assert.ok(Math.abs(ui.nodes.get("selected").getBoundingClientRect().top - 300) <= 0.5);
  }
});

test("changing, clearing or losing the selection never restores an old flight's anchor", () => {
  const ui = host();
  ui.render();
  ui.node("other", 1000);
  ui.render([], "other");
  ui.render([], null);
  ui.render([], "missing");
  assert.equal(ui.scrolls.length, 0);
});

test("only new visible flights fade in once, including after a virtual remount", () => {
  const ui = host(), initial = [flight("selected")];
  ui.render(initial);
  assert.equal(ui.animations.length, 0, "initial results appear immediately");
  ui.node("new", 900);
  const added = [...initial, flight("new")];
  ui.render(added);
  assert.equal(ui.animations.length, 1);
  assert.equal(ui.animations[0].options.duration, 160);
  ui.nodes.delete("new"); ui.render(added);
  ui.node("new", 900); ui.render([...added].reverse());
  assert.equal(ui.animations.length, 1, "scrolling, sorting and replacement snapshots cannot replay an entrance");
});

test("offscreen arrivals expire and reduced-motion users get immediate results", () => {
  const ui = host(), initial = [flight("selected")];
  ui.render(initial);
  ui.node("offscreen", 3000);
  const added = [...initial, flight("offscreen")];
  ui.render(added); ui.advance(250);
  ui.nodes.get("offscreen").start = 900;
  ui.render(added);
  assert.equal(ui.animations.length, 0);
  ui.setReduced(true); ui.node("reduced", 900);
  ui.render([...added, flight("reduced")]);
  assert.equal(ui.animations.length, 0);
});

const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const path = require("node:path");
const React = require("react");
const { buildSync } = require("esbuild");
const bundle = buildSync({ entryPoints: [path.join(__dirname, "../src/TimelineTooltip.tsx")],
  bundle: true, external: ["react", "react-dom"], write: false, format: "cjs", platform: "node", jsx: "automatic" }).outputFiles[0].text;

/** Drive the actual provider's effects across the same periodic row replacements as App. */
function host() {
  let cursor = 0, dirty = false, now = 0, nextTimer = 0;
  const slots = [], effects = [], timers = new Map(), listeners = new Map();
  const document = { activeElement: null, body: {},
    addEventListener: (name, fn) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener: (name, fn) => listeners.get(name)?.delete(fn) };
  const window = { addEventListener: document.addEventListener, removeEventListener: document.removeEventListener,
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(id) { timers.delete(id); } };
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const effect = (fn, deps) => {
    const i = cursor++;
    if (!same(slots[i]?.deps, deps)) effects.push(() => {
      slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: fn() };
    });
  };
  const hooks = { ...React,
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
      return [slots[i], (value) => { const next = typeof value === "function" ? value(slots[i]) : value;
        if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true; } }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useCallback(fn, deps) { const i = cursor++; if (!same(slots[i]?.deps, deps)) slots[i] = { deps, value: fn }; return slots[i].value; },
    useMemo(fn, deps) { const i = cursor++; if (!same(slots[i]?.deps, deps)) slots[i] = { deps, value: fn() }; return slots[i].value; },
    useEffect: effect, useLayoutEffect: effect,
  };
  const mod = { exports: {} };
  vm.runInNewContext(bundle, { module: mod, exports: mod.exports, document, window, innerWidth: 1280, innerHeight: 800,
    require: (name) => name === "react" ? hooks : name === "react-dom" ? { createPortal: (node) => node } : require(name) });
  const anchor = { isConnected: true, hovered: true, matches: () => anchor.hovered,
    contains: (target) => target === anchor, getBoundingClientRect: () => ({ left: 100, top: 100, width: 100, bottom: 124 }) };
  const bubble = { hovered: false, matches: () => bubble.hovered, contains: (target) => target === bubble,
    getBoundingClientRect: () => ({ width: 300, height: 120 }) };
  let lastRows = [], tree;
  const render = (rows = lastRows) => {
    lastRows = rows;
    for (let count = 0; count < 20; count++) {
      dirty = false; cursor = 0;
      tree = mod.exports.TimelineTooltipProvider({ children: React.createElement("div", null, rows.length), resetKey: rows });
      const portal = React.Children.toArray(tree.props.children).find((node) => node.props?.role === "tooltip");
      if (portal) portal.props.ref.current = bubble;
      while (effects.length) effects.shift()();
      if (!dirty) return tree.props.value;
    }
    throw new Error("Provider did not settle");
  };
  return { render, anchor, bubble, document,
    advance(ms) { now += ms; for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.fn(); } },
  };
}
const part = { kind: "flight", detailed: true, minutes: 125, segment: { origin: "BER", destination: "LGW",
  departure: "2026-11-01T07:00", arrival: "2026-11-01T08:05", duration: "2h 05m", carrier_name: "easyJet" } };

test("periodic result refreshes never dismiss a tooltip whose segment remains present", () => {
  const ui = host();
  ui.render().open({ part, anchor: ui.anchor, id: "segment-1" });
  assert.equal(ui.render().active, "segment-1");
  for (let i = 0; i < 5; i++) {
    ui.advance(3000);
    assert.equal(ui.render([{ trip_key: "same-flight" }]).active, "segment-1", "a fresh rows array must not act as a dismiss timer");
  }
});

test("a leave grace period does not dismiss a focused or still-hovered segment", () => {
  const ui = host();
  ui.render().open({ part, anchor: ui.anchor, id: "segment-1" });
  ui.render().leave(); ui.advance(1000);
  assert.equal(ui.render().active, "segment-1");
  ui.anchor.hovered = false; ui.document.activeElement = ui.anchor;
  ui.render().leave(); ui.advance(1000);
  assert.equal(ui.render().active, "segment-1");
  ui.document.activeElement = null; ui.bubble.hovered = true;
  ui.render().leave(); ui.advance(1000);
  assert.equal(ui.render().active, "segment-1");
});

test("leaving both the segment and popup dismisses; removing the segment also dismisses", () => {
  const ui = host();
  ui.render().open({ part, anchor: ui.anchor, id: "segment-1" });
  ui.anchor.hovered = false;
  ui.render().leave(); ui.advance(1000);
  assert.equal(ui.render().active, undefined);
  ui.render().open({ part, anchor: ui.anchor, id: "segment-1" });
  ui.render(); ui.anchor.isConnected = false;
  assert.equal(ui.render([{ trip_key: "different-flight" }]).active, undefined);
});

test("fresh content neither cancels a real pointer leave nor reopens a dismissed popup", () => {
  const ui = host();
  ui.render().open({ part, anchor: ui.anchor, id: "segment-1" });
  ui.anchor.hovered = false;
  ui.render().leave();
  const next = { part: { ...part, minutes: 130 }, anchor: ui.anchor, id: "segment-1" };
  ui.render().update(next);
  ui.advance(1000);
  assert.equal(ui.render().active, undefined);
  ui.render().update(next);
  assert.equal(ui.render().active, undefined);
});

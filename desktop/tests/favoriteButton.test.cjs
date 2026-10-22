/** The favorite star animates only on a user toggle and never under reduced motion. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { buildSync } = require("esbuild");
const React = require("react");
const bundle = buildSync({ entryPoints: [path.join(__dirname, "../src/FavoriteButton.tsx")],
  bundle: true, external: ["react", "react/jsx-runtime"], write: false, format: "cjs", platform: "node", jsx: "automatic" }).outputFiles[0].text;
const row = { trip_key: "trip-1", route: "BER-LIS", depart_date: "2026-05-01", return_date: "2026-05-08", departure: "08:15" };

function host({ reduced = false } = {}) {
  let cursor = 0;
  const slots = [];
  const hooks = { ...React,
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial;
      return [slots[i], (value) => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }]; },
  };
  const module = { exports: {} };
  vm.runInNewContext(bundle, { module, exports: module.exports,
    window: { matchMedia: (query) => ({ matches: reduced && query === "(prefers-reduced-motion: reduce)" }) },
    require: (name) => name === "react" ? hooks : require(name) });
  return (favorite, onToggle = () => {}) => { cursor = 0;
    return module.exports.FavoriteButton({ row, favorite, onToggle }); };
}

test("first render, even of an already favorited row, carries no animation marker", () => {
  const render = host();
  assert.equal(render(true).props["data-motion"], undefined);
  assert.equal(render(true).props["data-motion"], undefined);
});

test("toggling to favorite marks the favorite animation, toggling back marks the unfavorite one", () => {
  const render = host();
  render(false);
  assert.equal(render(true).props["data-motion"], "favorite");
  assert.equal(render(false).props["data-motion"], "unfavorite");
});

test("the marker is cleared when the animation ends and stays cleared on re-render", () => {
  const render = host();
  render(false);
  const marked = render(true);
  assert.equal(marked.props["data-motion"], "favorite");
  marked.props.onAnimationEnd();
  assert.equal(render(true).props["data-motion"], undefined);
});

test("under reduced motion no animation marker is applied", () => {
  const render = host({ reduced: true });
  render(false);
  assert.equal(render(true).props["data-motion"], undefined);
  assert.equal(render(false).props["data-motion"], undefined);
});

test("click handling and accessible attributes are unchanged", () => {
  const render = host();
  const calls = []; let stopped = 0;
  const off = render(false, (key) => calls.push(key));
  assert.equal(off.props["aria-pressed"], false);
  assert.equal(off.props["aria-label"], "Add to favorites: BER-LIS, 2026-05-01 to 2026-05-08, 08:15");
  assert.equal(off.props.title, "Add to favorites");
  off.props.onClick({ stopPropagation() { stopped++; } });
  assert.deepEqual(calls, ["trip-1"]);
  assert.equal(stopped, 1);
  const on = render(true);
  assert.equal(on.props["aria-pressed"], true);
  assert.equal(on.props["aria-label"], "Remove from favorites: BER-LIS, 2026-05-01 to 2026-05-08, 08:15");
  assert.equal(on.props.title, "Remove from favorites");
});

test("keyframes animate only transform/opacity and are disabled under reduced motion", () => {
  const css = fs.readFileSync(path.join(__dirname, "../src/styles.css"), "utf8");
  const frames = [...css.matchAll(/@keyframes\s+(favorite-\w+)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)];
  assert.deepEqual(frames.map((m) => m[1]).sort(), ["favorite-pop", "favorite-shrink"]);
  for (const [, name, body] of frames) {
    const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]).filter((p) => p !== "animation-timing-function");
    assert.ok(props.length && props.every((p) => p === "transform" || p === "opacity"), `${name} animates ${props}`);
  }
  const motionRules = [...css.matchAll(/[^{}]*data-motion[^{}]*\{([^{}]*)\}/g)].map((m) => m[1]).join("\n");
  assert.ok(motionRules.includes("animation"), "motion rules exist");
  assert.doesNotMatch(motionRules, /(?<![-\w])(width|height|padding|margin)\s*:/);
  const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{([^]*?)\}\s*(?=\n|$)/g)].map((m) => m[1]).join("\n");
  assert.match(reduced, /\.favorite-button[^{]*\.icon[^{]*\{[^}]*animation:\s*none/);
});

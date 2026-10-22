/** Independent source verifications must not block or silently fail each other. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const path = require("node:path");
const { buildSync } = require("esbuild");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const bundle = buildSync({ entryPoints: [path.join(__dirname, "../src/ChallengeBanner.tsx")],
  bundle: true, external: ["react", "react-dom", "./platform"], write: false, format: "cjs", platform: "node", jsx: "automatic" }).outputFiles[0].text;
const requests = [{ source: "ff-kayak", url: "https://example.test/one" },
  { source: "ff-sky", url: "https://example.test/two" }];
function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { resolve, promise }; }
function host(platform) {
  let cursor = 0;
  const slots = [];
  const hooks = { ...React,
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial;
      return [slots[i], (value) => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
  };
  const module = { exports: {} };
  vm.runInNewContext(bundle, { module, exports: module.exports, Error, URL,
    require: (name) => name === "react" ? hooks : name === "./platform" ? platform : require(name) });
  return (overrides = {}) => { cursor = 0; return module.exports.ChallengeBanner({ api: {},
    pending: requests, canSolveHere: true, onCleared() {}, ...overrides }); };
}
function buttons(node) {
  if (!React.isValidElement(node)) return [];
  return [...(node.type === "button" ? [node] : []), ...React.Children.toArray(node.props.children).flatMap(buttons)];
}

test("each source verification is independently available", () => {
  const render = host({ isDesktop: true });
  assert.deepEqual(buttons(render()).map((b) => Boolean(b.props.disabled)), [false, false]);
});

test("opening one challenge keeps other sources available and rejects duplicate clicks on that source", async () => {
  const opened = deferred(), calls = [];
  const render = host({ isDesktop: true, openChallenge: (url) => { calls.push(url); return opened.promise; } });
  const initial = buttons(render());
  const first = initial[0].props.onClick();
  const during = buttons(render()).map((b) => Boolean(b.props.disabled));
  const duplicate = initial[0].props.onClick(); // Before React paints the disabled state.
  const second = initial[1].props.onClick();
  opened.resolve({ solved: false }); await Promise.all([first, duplicate, second]);
  assert.deepEqual(during, [true, false]);
  assert.deepEqual(calls, [requests[0].url, requests[1].url]);
});

test("an existing server verification blocks only its own source", () => {
  const render = host({ isDesktop: false });
  const tree = render({ pending: [requests[0], { ...requests[1], solving: true }] });
  assert.deepEqual(buttons(tree).map((b) => Boolean(b.props.disabled)), [false, true]);
});

test("failed verification shows an error and leaves the first request retryable", async () => {
  const render = host({ isDesktop: true, openChallenge: async () => { throw new Error("Could not open the window"); } });
  await buttons(render())[0].props.onClick();
  const tree = render();
  assert.match(renderToStaticMarkup(tree), /Could not open the window/);
  assert.deepEqual(buttons(tree).map((b) => Boolean(b.props.disabled)), [false, false]);
});

test("the source stays busy until cookies are handed back and status is refreshed", async () => {
  const refreshed = deferred(), calls = [];
  const render = host({ isDesktop: true, openChallenge: async () => ({ solved: true, cookies: [], landed_on: "https://example.test/done" }) });
  const props = { api: { submitChallengeCookies: async (source) => { calls.push(source); } },
    onCleared: () => refreshed.promise };
  const first = buttons(render(props))[0].props.onClick();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  const whileRefreshing = buttons(render(props)).map((b) => Boolean(b.props.disabled));
  refreshed.resolve(); await first;
  assert.deepEqual(calls, [requests[0].source]);
  assert.deepEqual(whileRefreshing, [true, false]);
  const remaining = buttons(render({ ...props, pending: requests.slice(1) }));
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].props.disabled, false);
});

test("a server browser stays busy independently after its opening request has returned", async () => {
  const render = host({ isDesktop: false });
  const first = buttons(render({ api: { solveChallenge: async () => ({}) } }))[0].props.onClick();
  await first;
  const busy = buttons(render({ pending: [{ ...requests[0], solving: true }, requests[1]] }));
  assert.deepEqual(busy.map((button) => Boolean(button.props.disabled)), [true, false]);
  const next = buttons(render({ pending: requests.slice(1) }));
  assert.equal(next[0].props.disabled, false);
});

test("asynchronous server launch errors appear beside the affected source", () => {
  const render = host({ isDesktop: false });
  const tree = render({ pending: [{ ...requests[0], error: "Browser executable is missing" }, requests[1]] });
  assert.match(renderToStaticMarkup(tree), /Browser executable is missing/);
  assert.equal(buttons(tree).every((button) => !button.props.disabled), true);
});

test("a solving source on the web embeds the viewer with a link to open it in a new tab", () => {
  const viewerUrl = "http://beelink.test:6080/vnc.html";
  const render = host({ isDesktop: false });
  const markup = renderToStaticMarkup(render({ viewerUrl, pending: [{ ...requests[0], solving: true }, requests[1]] }));
  assert.match(markup, /<iframe[^>]*src="http:\/\/beelink\.test:6080\/vnc_lite\.html\?scale=true"/);
  assert.match(markup, /<a [^>]*href="http:\/\/beelink\.test:6080\/vnc\.html"[^>]*target="_blank"[^>]*rel="noopener noreferrer"[^>]*>Open in a new tab/);
  assert.equal(markup.match(/<iframe/g).length, 1);
  assert.match(markup, /role="dialog"[^>]*aria-modal="true"/);
});

test("no viewer panel without a viewer address, when not solving, or in the desktop shell", () => {
  const viewerUrl = "http://beelink.test:6080/vnc.html";
  const solving = [{ ...requests[0], solving: true }];
  assert.doesNotMatch(renderToStaticMarkup(host({ isDesktop: false })({ pending: solving })), /iframe/);
  assert.doesNotMatch(renderToStaticMarkup(host({ isDesktop: false })({ viewerUrl, pending: requests })), /iframe/);
  assert.doesNotMatch(renderToStaticMarkup(host({ isDesktop: true })({ viewerUrl, pending: solving })), /iframe/);
});

test("the viewer panel can be collapsed and expanded, and goes with the row", () => {
  const viewerUrl = "http://beelink.test:6080/vnc.html";
  const render = host({ isDesktop: false });
  const props = { viewerUrl, pending: [{ ...requests[0], solving: true }] };
  const toggle = (node) => {
    if (!React.isValidElement(node)) return [];
    return [...(node.props["aria-expanded"] !== undefined ? [node] : []), ...React.Children.toArray(node.props.children).flatMap(toggle)];
  };
  const [button] = toggle(render(props));
  assert.equal(button.props["aria-expanded"], true);
  button.props.onClick();
  assert.doesNotMatch(renderToStaticMarkup(render(props)), /<iframe/);
  assert.match(renderToStaticMarkup(render(props)), /Open in a new tab/);
  toggle(render(props))[0].props.onClick();
  assert.match(renderToStaticMarkup(render(props)), /<iframe/);
  assert.doesNotMatch(renderToStaticMarkup(render({ ...props, pending: [] }) ?? ""), /iframe/);
});

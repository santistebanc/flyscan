/** The embedded security-check viewer shows only where the owner cannot reach the server's display. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { buildSync } = require("esbuild");
const bundle = buildSync({ entryPoints: [path.join(__dirname, "../src/challengeViewer.ts")],
  bundle: true, write: false, format: "cjs", platform: "node" }).outputFiles[0].text;
const module_ = { exports: {} };
new Function("module", "exports", bundle)(module_, module_.exports);
const { showsViewerPanel } = module_.exports;

const solving = { source: "ff-kayak", url: "https://example.test/one", solving: true };
const viewer = "http://beelink.test:6080/vnc.html";

test("the panel shows on the web when a viewer is configured and the source is solving", () => {
  assert.equal(showsViewerPanel({ isDesktop: false, viewerUrl: viewer, challenge: solving }), true);
});

test("a pending source that is not solving has no panel", () => {
  assert.equal(showsViewerPanel({ isDesktop: false, viewerUrl: viewer, challenge: { ...solving, solving: false } }), false);
  assert.equal(showsViewerPanel({ isDesktop: false, viewerUrl: viewer, challenge: { source: "ff-kayak", url: "u" } }), false);
});

test("without a viewer address there is no panel", () => {
  for (const viewerUrl of [undefined, null, ""]) {
    assert.equal(showsViewerPanel({ isDesktop: false, viewerUrl, challenge: solving }), false);
  }
});

test("the desktop shell never shows the panel", () => {
  assert.equal(showsViewerPanel({ isDesktop: true, viewerUrl: viewer, challenge: solving }), false);
});

test("noVNC's full page is embedded as its control-free lite page, other viewers as given", () => {
  const { embedViewerUrl } = module_.exports;
  assert.equal(embedViewerUrl("http://beelink.test:6080/vnc.html?autoconnect=1&resize=scale"),
    "http://beelink.test:6080/vnc_lite.html?scale=true");
  assert.equal(embedViewerUrl("http://viewer.test/screen"), "http://viewer.test/screen");
  assert.equal(embedViewerUrl("not a url"), "not a url");
});

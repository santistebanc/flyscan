const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildSync } = require("esbuild");
const path = require("node:path");
const vm = require("node:vm");
const code = buildSync({ entryPoints: [path.join(__dirname, "../src/api.ts")],
  bundle: true, write: false, format: "cjs", platform: "node" }).outputFiles[0].text;

function client(key) {
  const calls = [], streams = [];
  const mod = { exports: {} };
  vm.runInNewContext(code, { module: mod, exports: mod.exports,
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ status: "ok" }) }; },
    EventSource: class { constructor(url) { streams.push(url); } },
  });
  return { api: new mod.exports.FlyscanApi("http://127.0.0.1:51234", key), calls, streams };
}

test("desktop API requests and event streams carry their session credential", async () => {
  const ui = client("test session&key");
  await ui.api.health();
  assert.equal(ui.calls[0].options.headers.Authorization, "Bearer test session&key");
  ui.api.streamSearch("job", () => {});
  assert.equal(ui.streams[0], "http://127.0.0.1:51234/v1/searches/job/events?api_key=test%20session%26key");
});

test("ordinary browser use does not invent credentials", async () => {
  const ui = client();
  await ui.api.health();
  assert.equal(ui.calls[0].options.headers.Authorization, undefined);
  ui.api.streamSearch("job", () => {});
  assert.equal(ui.streams[0], "http://127.0.0.1:51234/v1/searches/job/events");
});

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildSync } = require("esbuild");
const path = require("node:path");
const vm = require("node:vm");
const built = buildSync({ entryPoints: [path.join(__dirname, "../src/updates.ts")], bundle: true,
  write: false, format: "cjs", platform: "node" }).outputFiles[0].text;
const moduleUnderTest = { exports: {} };
vm.runInNewContext(built, { module: moduleUnderTest, exports: moduleUnderTest.exports, Error });
const { UpdateManager, updatePreferences } = moduleUnderTest.exports;
function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { resolve, promise }; }
function fixture(preferences, overrides = {}) {
  const calls = { check: 0, download: 0, install: 0, before: 0, close: 0, preferences: [] };
  const artifact = { version: "0.3.3", body: "A tested update", close: async () => { calls.close++; },
    download: async (event) => { calls.download++; event({ event: "Started", data: { contentLength: 200 } });
      event({ event: "Progress", data: { chunkLength: 100 } }); event({ event: "Progress", data: { chunkLength: 100 } }); },
    install: async (options) => { calls.install++; assert.equal(options.restartAfterInstall, true); }, ...overrides.artifact };
  const dependencies = { check: async () => { calls.check++; return artifact; }, version: async () => "0.3.2",
    now: () => 12345, beforeInstall: async () => { calls.before++; }, savePreferences: (p) => calls.preferences.push(p),
    ...overrides.dependencies };
  const manager = new UpdateManager(dependencies, preferences);
  manager.setActivityGuard(() => true);
  return { manager, calls, artifact, dependencies };
}
test("automatic checks download and verify without restarting by default", async () => {
  const { manager, calls } = fixture();
  await manager.check(true);
  assert.equal(manager.snapshot().status, "ready");
  assert.equal(manager.snapshot().currentVersion, "0.3.2");
  assert.equal(manager.snapshot().downloaded, 200);
  assert.equal(calls.download, 1); assert.equal(calls.install, 0);
});
test("startup installation requires an explicit preference and a fresh activity check", async () => {
  const { manager, calls } = fixture({ installOnStartup: true });
  await manager.check(true);
  assert.equal(calls.before, 1); assert.equal(calls.install, 1);
});
test("periodic and manual checks never trigger startup installation", async () => {
  const { manager, calls } = fixture({ installOnStartup: true });
  await manager.check(); assert.equal(manager.snapshot().status, "ready"); assert.equal(calls.install, 0);
});
test("manual downloads work when automatic downloads are disabled", async () => {
  const { manager, calls } = fixture({ autoDownload: false, installOnStartup: true });
  await manager.check(true); assert.equal(manager.snapshot().status, "available"); assert.equal(calls.download, 0);
  await manager.download(); assert.equal(manager.snapshot().status, "ready"); assert.equal(calls.install, 0);
});
test("failed signature verification or download never becomes installable", async () => {
  const { manager, calls } = fixture(undefined, { artifact: { download: async () => { throw new Error("bad signature"); } } });
  await manager.check(true); assert.equal(manager.snapshot().status, "available");
  assert.match(manager.snapshot().error, /verify/); await manager.install(); assert.equal(calls.install, 0);
});
test("pending checks and ready downloads cannot be duplicated by repeated mounts or timers", async () => {
  const pending = deferred();
  const { manager, calls, artifact } = fixture(undefined, { dependencies: { check: () => pending.promise } });
  const first = manager.check(true); await Promise.resolve(); await manager.check(true);
  pending.resolve(artifact); await first; await manager.check(); await manager.download();
  assert.equal(calls.download, 1); assert.equal(manager.snapshot().status, "ready");
});
test("in-flight UI searches prevent installation before the backend is queried", async () => {
  const { manager, calls } = fixture(); await manager.check();
  manager.setActivityGuard(() => false); await manager.install();
  assert.equal(calls.before, 0); assert.equal(calls.install, 0); assert.equal(manager.snapshot().status, "ready");
  assert.match(manager.snapshot().error, /active searches/);
});
test("fresh backend and verification checks can veto installation and allow a later retry", async () => {
  let blocked = true;
  const { manager, calls } = fixture(undefined, { dependencies: { beforeInstall: async () => {
    if (blocked) throw new Error("Finish the verification first");
  } } });
  await manager.check(); await manager.install(); assert.equal(calls.install, 0);
  assert.equal(manager.snapshot().status, "ready"); assert.match(manager.snapshot().error, /verification/);
  blocked = false; await manager.install(); assert.equal(calls.install, 1);
});
test("turning off startup installation while downloading prevents an automatic restart", async () => {
  const pending = deferred();
  const { manager, calls } = fixture({ installOnStartup: true }, { artifact: { download: () => pending.promise } });
  const checking = manager.check(true); for (let i = 0; i < 10; i++) await Promise.resolve();
  manager.setPreferences({ installOnStartup: false }); pending.resolve(); await checking;
  assert.equal(calls.install, 0); assert.equal(manager.snapshot().status, "ready");
});
test("offline checks retain the installed version and are retryable", async () => {
  let offline = true;
  const { manager } = fixture(undefined, { dependencies: { check: async () => {
    if (offline) throw new Error("offline"); return null;
  } } });
  await manager.check(); assert.equal(manager.snapshot().status, "error"); assert.equal(manager.snapshot().currentVersion, "0.3.2");
  offline = false; await manager.check(); assert.equal(manager.snapshot().status, "current");
  assert.equal(manager.snapshot().checkedAt, 12345);
});
test("replaced update resources are released and current versions need no downloads", async () => {
  const { manager, calls, dependencies } = fixture({ autoDownload: false });
  await manager.check(); dependencies.check = async () => null; await manager.check();
  assert.equal(calls.close, 1); assert.equal(calls.download, 0); assert.equal(manager.snapshot().status, "current");
});
test("preferences default safely and disabling downloads also disables startup installation", () => {
  assert.equal(updatePreferences(null).autoDownload, true);
  assert.equal(updatePreferences({ installOnStartup: "yes" }).installOnStartup, false);
  const { manager, calls } = fixture({ installOnStartup: true });
  manager.setPreferences({ autoDownload: false });
  assert.equal(manager.snapshot().preferences.installOnStartup, false);
  assert.equal(calls.preferences.at(-1).autoDownload, false);
});


test("private-style automatic installation waits for an idle app and permits retry", async () => {
  const { manager, calls } = fixture({ autoInstall: true });
  manager.setActivityGuard(() => false);
  await manager.check();
  assert.equal(manager.snapshot().status, "ready");
  assert.equal(calls.install, 0);
  manager.setActivityGuard(() => true);
  await manager.install();
  assert.equal(calls.install, 1);
});

test("automatic idle installation can be disabled along with downloads", async () => {
  const { manager, calls } = fixture({ autoInstall: true, autoDownload: false });
  await manager.check();
  assert.equal(calls.download, 0);
  assert.equal(manager.snapshot().preferences.autoInstall, false);
});

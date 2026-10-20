/** Retry acknowledgement and snapshot ordering through the actual queue hook. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const path = require("node:path");
const { buildSync } = require("esbuild");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const bundle = (file) => buildSync({ entryPoints: [path.join(__dirname, "../src", file)],
  bundle: true, external: ["react"], write: false, format: "cjs", platform: "node", jsx: "automatic" }).outputFiles[0].text;
const hookBundle = bundle("useQueue.ts");
const viewModule = { exports: {} };
vm.runInNewContext(bundle("Queue.tsx"), { module: viewModule, exports: viewModule.exports, require });
const { Queue } = viewModule.exports;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function host(api) {
  let cursor = 0, now = 0, timerId = 0;
  const slots = [], effects = [], timers = new Map();
  const listeners = new Map();
  const listen = (name, callback) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); };
  const unlisten = (name, callback) => listeners.get(name)?.delete(callback);
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const hooks = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
      return [slots[i], (value) => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }];
    },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useCallback(callback, deps) {
      const i = cursor++;
      if (!same(slots[i]?.deps, deps)) slots[i] = { deps, callback };
      return slots[i].callback;
    },
    useEffect(effect, deps) {
      const i = cursor++;
      if (!same(slots[i]?.deps, deps)) effects.push(() => {
        slots[i]?.cleanup?.();
        slots[i] = { deps, cleanup: effect() };
      });
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(hookBundle, { module, exports: module.exports, Error,
    require: (name) => { assert.equal(name, "react"); return hooks; },
    window: {
      setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, at: now + ms }); return id; },
      clearTimeout(id) { timers.delete(id); },
      addEventListener: listen, removeEventListener: unlisten,
    },
    document: { visibilityState: "visible", addEventListener: listen, removeEventListener: unlisten },
  });
  return {
    emit(name) { for (const listener of listeners.get(name) ?? []) listener(); },
    render() {
      cursor = 0;
      const result = module.exports.useQueue(api, null, false, () => {});
      while (effects.length) effects.shift()();
      return result;
    },
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const next = [...timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
      }
      now = target;
    },
  };
}
function snapshot(queue_state = "failed") {
  const source = { source: "ff-sky", state: queue_state, queue_state, status: queue_state === "queued" ? "waiting" : queue_state,
    worker_busy: false, count: 0, error: "", elapsed: 0, ready_in: null };
  const group = { id: "one", origin: "BER", destination: "LON", depart: "2026-12-21", ret: "",
    adults: 1, children: 0, infants: 0, cabin: "economy", currency: "EUR", created_at: "", sources: [source] };
  return { query_jobs: [group], jobs: [source], scheduler: { running: 0, queued: queue_state === "queued" ? 1 : 0 } };
}
const outcome = { retried: 1, cancelled: 0, skipped: 0, errors: [] };
const selection = async () => ({ selected: null });

test("retry immediately animates its collapsed query while the request is pending", async () => {
  const action = deferred();
  const ui = host({ queue: async () => snapshot(), selectQueueQuery: selection, queryJobAction: () => action.promise });
  ui.render(); await flush();
  const running = ui.render().act("one", "retry", "ff-sky");
  const html = renderToStaticMarkup(React.createElement(Queue, { queue: ui.render() }));
  action.resolve(outcome); await running;
  assert.match(html, /class="[^"]*\bspinner\b/, "the clicked query must acknowledge retry before the network answers");
});

test("retry reads its new queue state before clearing busy, without waiting for a render or poll", async () => {
  const next = deferred();
  let reads = 0;
  const ui = host({ queue: () => ++reads === 1 ? Promise.resolve(snapshot()) : next.promise,
    selectQueueQuery: selection, queryJobAction: async () => outcome });
  ui.render(); await flush();
  const running = ui.render().act("one", "retry", "ff-sky");
  await flush();
  const readsAfterAcknowledgement = reads;
  const busyBeforeSnapshot = ui.render().busy;
  next.resolve(snapshot("queued")); await running;
  assert.equal(readsAfterAcknowledgement, 2, "POST acknowledgement must trigger a queue read immediately");
  assert.notEqual(busyBeforeSnapshot, null, "keep feedback visible until the new state is available");
  assert.equal(ui.render().state.query_jobs[0].sources[0].queue_state, "queued");
  assert.equal(ui.render().busy, null);
});

test("an older poll cannot restore failed status after retry is acknowledged", async () => {
  const old = deferred();
  let delayNext = false, retried = false, oldPollStarted = false;
  const ui = host({ queue: () => {
    if (delayNext) { delayNext = false; oldPollStarted = true; return old.promise; }
    return Promise.resolve(snapshot(retried ? "queued" : "failed"));
  }, selectQueueQuery: selection, queryJobAction: async () => { retried = true; return outcome; } });
  ui.render(); await flush();
  await ui.advance(200); ui.render(); await flush(); // Complete initial priority sync.
  delayNext = true;
  await ui.advance(3000); // Leave the pre-retry poll in flight.
  assert.equal(oldPollStarted, true);
  const running = ui.render().act("one", "retry", "ff-sky");
  await flush();
  old.resolve(snapshot()); await flush(); await running;
  assert.equal(ui.render().state.query_jobs[0].sources[0].queue_state, "queued");
});

test("a failed retry clears its indicator and retains the source status", async () => {
  const action = deferred();
  const ui = host({ queue: async () => snapshot(), selectQueueQuery: selection, queryJobAction: () => action.promise });
  ui.render(); await flush();
  const running = ui.render().act("one", "retry", "ff-sky");
  action.reject(new Error("Could not reach the server")); await running;
  const result = ui.render();
  assert.equal(result.busy, null);
  assert.equal(result.error, "Could not reach the server");
  assert.equal(result.state.query_jobs[0].sources[0].queue_state, "failed");
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(Queue, { queue: result })), /class="[^"]*\bspinner\b/);
});

test("a failed confirming read releases the control and marks the queue offline", async () => {
  let reads = 0;
  const ui = host({ queue: async () => {
    if (++reads > 1) throw new Error("Disconnected");
    return snapshot();
  }, selectQueueQuery: selection, queryJobAction: async () => outcome });
  ui.render(); await flush();
  await ui.render().act("one", "retry", "ff-sky");
  assert.equal(ui.render().busy, null);
  assert.equal(ui.render().offline, true);
});

test("background polling cannot replace an action's confirming queue read", async () => {
  const next = deferred();
  let reads = 0;
  const ui = host({ queue: () => ++reads === 1 ? Promise.resolve(snapshot()) : next.promise,
    selectQueueQuery: selection, queryJobAction: async () => outcome });
  ui.render(); await flush();
  const running = ui.render().act("one", "retry", "ff-sky");
  await flush(); await ui.advance(3500);
  const readsWhilePending = reads;
  next.resolve(snapshot("queued")); await running;
  assert.equal(readsWhilePending, 2, "periodic reads must wait for the action confirmation");
  assert.equal(ui.render().state.query_jobs[0].sources[0].queue_state, "queued");
});

test("other queue states keep updating while a retry request is still pending", async () => {
  const action = deferred();
  let current = snapshot();
  const ui = host({ queue: async () => current, selectQueueQuery: selection, queryJobAction: () => action.promise });
  ui.render(); await flush(); await ui.advance(200); ui.render(); await flush();
  const running = ui.render().act("one", "retry", "ff-sky");
  current = snapshot("done");
  await ui.advance(3500);
  const stateDuringAction = ui.render().state;
  action.resolve(outcome); await running;
  assert.equal(stateDuringAction.query_jobs[0].sources[0].queue_state, "done",
    "a slow action must not freeze updates for the entire queue");
});

test("returning to the app refreshes queue state immediately", async () => {
  let current = snapshot();
  const ui = host({ queue: async () => current, selectQueueQuery: selection });
  ui.render(); await flush(); await ui.advance(200); ui.render(); await flush();
  current = snapshot("queued");
  ui.emit("focus"); await flush();
  assert.equal(ui.render().state.query_jobs[0].sources[0].queue_state, "queued");
  current = snapshot("done");
  ui.emit("visibilitychange"); await flush();
  assert.equal(ui.render().state.query_jobs[0].sources[0].queue_state, "done");
});

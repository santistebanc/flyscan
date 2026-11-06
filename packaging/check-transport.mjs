import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export async function checkTransport(command) {
  const child = spawn(command, [], {
    env: { ...process.env, FLYSCAN_OFFLINE: "1" },
    windowsHide: true,
    stdio: "pipe",
  });
  let stderr = "",
    id = 0;
  const pending = new Map();
  child.stderr.on("data", (b) => (stderr += b));
  const fail = (error) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    pending.clear();
  };
  const closed = new Promise((done) => {
    child.once("error", (error) => {
      fail(error);
      done(null);
    });
    child.once("close", (code) => {
      fail(new Error("Curl worker exited: " + stderr));
      done(code);
    });
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const reply = JSON.parse(line),
        p = pending.get(reply.id);
      if (p) {
        pending.delete(reply.id);
        clearTimeout(p.timer);
        p.resolve(reply);
      }
    } catch (e) {
      fail(e);
    }
  });
  const send = (message) =>
    new Promise((resolve, reject) => {
      const requestId = ++id,
        timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error("Curl worker response timed out: " + stderr));
        }, 15000);
      pending.set(requestId, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id: requestId, ...message }) + "\n");
    });
  let timer;
  try {
    assert.equal((await send({ op: "open", session: "smoke" })).result, null);
    const response = await send({
      op: "request",
      session: "smoke",
      method: "GET",
      url: "https://example.invalid",
    });
    assert.match(response.error.message, /offline/);
    assert.equal((await send({ op: "close", session: "smoke" })).result, null);
    child.stdin.end();
    const code = await Promise.race([
      closed,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Curl worker failed to stop")),
          10000,
        );
      }),
    ]);
    assert.equal(code, 0);
    console.log(
      "Packaged curl transport passed: native session, offline guard, private pipe and cleanup.",
    );
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
    await closed;
    lines.close();
  }
}

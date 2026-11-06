import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { PythonTransport } from "../src/transport.js";

const root = resolve(".."),
  script = resolve(root, "flyscan/transport.py");
const python =
  process.env.FLYSCAN_PYTHON ||
  [
    resolve(root, ".venv/Scripts/python.exe"),
    resolve(root, ".venv/bin/python"),
  ].find(existsSync) ||
  "python";
function worker(offline = true) {
  const child = spawn(python, ["-u", script], {
    env: { ...process.env, FLYSCAN_OFFLINE: offline ? "1" : "0" },
    windowsHide: true,
    stdio: "pipe",
  });
  let id = 0,
    stderr = "";
  const pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  child.stderr.on("data", (b) => (stderr += b));
  createInterface({ input: child.stdout }).on("line", (line) => {
    const reply = JSON.parse(line),
      p = pending.get(reply.id);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(reply.id);
      p.resolve(reply);
    }
  });
  const closed = new Promise<number | null>((done) =>
    child.once("close", (code) => {
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("worker exited: " + stderr));
      }
      pending.clear();
      done(code);
    }),
  );
  child.once("error", (e) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
  });
  return {
    child,
    closed,
    send(message: Record<string, unknown>): Promise<any> {
      const requestId = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error("worker response timed out: " + stderr));
        }, 10000);
        pending.set(requestId, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id: requestId, ...message }) + "\n");
      });
    },
    async close() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 2000);
      try {
        return await closed;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
test("actual Python worker opens sessions and blocks all requests in offline mode", async () => {
  const w = worker();
  try {
    assert.equal((await w.send({ op: "open", session: "a" })).result, null);
    const r = await w.send({
      op: "request",
      session: "a",
      method: "GET",
      url: "https://example.invalid",
    });
    assert.match(r.error.message, /offline/);
    assert.equal((await w.send({ op: "close", session: "a" })).result, null);
  } finally {
    assert.equal(await w.close(), 0);
  }
});
test("unknown operations, missing sessions and duplicate sessions return structured errors", async () => {
  const w = worker(false);
  try {
    assert.equal(
      (await w.send({ op: "flight-search" })).error.kind,
      "ValueError",
    );
    assert.equal(
      (
        await w.send({
          op: "request",
          session: "missing",
          method: "GET",
          url: "https://example.invalid",
        })
      ).error.kind,
      "KeyError",
    );
    await w.send({ op: "open", session: "a" });
    assert.match(
      (await w.send({ op: "open", session: "a" })).error.message,
      /already exists/,
    );
  } finally {
    await w.close();
  }
});
test("worker carries bytes, repeated headers and session cookies on loopback", async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Set-Cookie": ["earned=fixture; Path=/", "other=value; Path=/"],
    });
    res.end(
      Buffer.concat([
        Buffer.from([0, 255]),
        Buffer.from(req.headers.cookie || ""),
      ]),
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as any).port}/`,
    w = worker(false);
  try {
    await w.send({ op: "open", session: "a" });
    const one = (
      await w.send({
        op: "request",
        session: "a",
        method: "GET",
        url,
        options: { timeout: 2 },
      })
    ).result;
    assert.deepEqual(Buffer.from(one.body, "base64"), Buffer.from([0, 255]));
    assert.equal(
      one.headers.filter(
        ([name]: string[]) => name.toLowerCase() === "set-cookie",
      ).length,
      2,
    );
    assert.equal(one.cookies[0].path, "/");
    const two = (
      await w.send({
        op: "request",
        session: "a",
        method: "GET",
        url,
        options: { timeout: 2 },
      })
    ).result;
    assert.match(Buffer.from(two.body, "base64").toString(), /earned=fixture/);
  } finally {
    await w.close();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
test("different sessions run native requests concurrently", async () => {
  const server = createServer(async (req, res) => {
    if (req.url === "/slow") await delay(150);
    res.end("ok");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as any).port}`,
    w = worker(false);
  try {
    for (const session of ["slow", "fast"])
      await w.send({ op: "open", session });
    const order: string[] = [];
    await Promise.all(
      ["slow", "fast"].map((session) =>
        w
          .send({
            op: "request",
            session,
            method: "GET",
            url: url + "/" + session,
            options: { timeout: 2 },
          })
          .then(() => order.push(session)),
      ),
    );
    assert.deepEqual(order, ["fast", "slow"]);
  } finally {
    await w.close();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
test("Node transport imports scoped cookies and preserves actual binary responses", async () => {
  let cookie = "";
  const server = createServer((req, res) => {
    cookie = req.headers.cookie || "";
    res.end(Buffer.from([0, 255, 195, 169]));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const saved = process.env.FLYSCAN_OFFLINE;
  process.env.FLYSCAN_OFFLINE = "0";
  const t = new PythonTransport(undefined, python, script);
  try {
    const session = await t.open([
      {
        name: "earned",
        value: "value",
        domain: "127.0.0.1",
        path: "/",
        expires: 1900000000,
      },
    ]);
    const r = await session.request(
      "GET",
      `http://127.0.0.1:${(server.address() as any).port}/`,
      { timeout: 2 },
    );
    assert.deepEqual(r.body, Buffer.from([0, 255, 195, 169]));
    assert.match(cookie, /earned=value/);
    await session.close();
  } finally {
    await t.close();
    if (saved === undefined) delete process.env.FLYSCAN_OFFLINE;
    else process.env.FLYSCAN_OFFLINE = saved;
    await new Promise<void>((done) => server.close(() => done()));
  }
});
test("owner shutdown releases an active native request without waiting for HTTP timeout", async () => {
  let entered!: () => void;
  const active = new Promise<void>((done) => (entered = done)),
    server = createServer((_req, _res) => entered());
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const saved = process.env.FLYSCAN_OFFLINE;
  process.env.FLYSCAN_OFFLINE = "0";
  const t = new PythonTransport(undefined, python, script);
  try {
    const session = await t.open(),
      request = assert.rejects(
        () =>
          session.request(
            "GET",
            `http://127.0.0.1:${(server.address() as any).port}/`,
            { timeout: 10 },
          ),
        /transport exited/,
      );
    await active;
    const started = Date.now();
    await t.close(true);
    await request;
    assert.ok(Date.now() - started < 1500);
  } finally {
    await t.close(true);
    if (saved === undefined) delete process.env.FLYSCAN_OFFLINE;
    else process.env.FLYSCAN_OFFLINE = saved;
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
test("losing the owning pipe stops the worker even with an HTTP request active", async () => {
  let entered!: () => void;
  const active = new Promise<void>((done) => (entered = done)),
    server = createServer(() => entered());
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const w = worker(false);
  try {
    await w.send({ op: "open", session: "a" });
    const pending = assert.rejects(
      () =>
        w.send({
          op: "request",
          session: "a",
          method: "GET",
          url: `http://127.0.0.1:${(server.address() as any).port}/`,
          options: { timeout: 10 },
        }),
      /worker exited/,
    );
    await active;
    assert.equal(await w.close(), 0);
    await pending;
  } finally {
    await w.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

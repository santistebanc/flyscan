import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  openSync,
  closeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { checkTransport } from "./check-transport.mjs";
const binary = resolve(process.argv[2] || ""),
  resources = dirname(binary),
  transport = join(
    resources,
    "flyscan-transport" + (process.platform === "win32" ? ".exe" : ""),
  );
for (const file of [
  binary,
  transport,
  join(resources, "backend/index.cjs"),
  join(resources, "frontend/index.html"),
])
  assert.ok(existsSync(file), `Missing packaged resource ${file}`);
const listener = createServer();
await new Promise((done) => listener.listen(0, "127.0.0.1", done));
const port = listener.address().port;
await new Promise((done) => listener.close(done));
const directory = mkdtempSync(join(tmpdir(), "flyscan-smoke-")),
  key = randomBytes(32).toString("base64url"),
  logPath = join(directory, "sidecar.log"),
  log = openSync(logPath, "w");
const child = spawn(
  binary,
  [
    join(resources, "backend/index.cjs"),
    "serve",
    "--port",
    String(port),
    "--exit-with-parent",
    String(process.pid),
  ],
  {
    cwd: directory,
    windowsHide: true,
    env: {
      ...process.env,
      FLYSCAN_API_KEY: key,
      FLYSCAN_OFFLINE: "1",
      FLYSCAN_TRANSPORT: transport,
      FLYSCAN_TRANSPORT_ARGS: "[]",
      FLYSCAN_FRONTEND: join(resources, "frontend"),
      FLYSCAN_DESKTOP_SHELL: "1",
    },
    stdio: ["ignore", log, log],
  },
);
let exited = false;
const closed = new Promise((done) => {
  child.once("error", () => {
    exited = true;
    done();
  });
  child.once("close", () => {
    exited = true;
    done();
  });
});
const request = (path, authenticated = true, options = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    ...options,
    headers: { ...(authenticated ? { Authorization: `Bearer ${key}` } : {}) },
    signal: AbortSignal.timeout(2000),
  });
try {
  const deadline = Date.now() + 45000;
  while (true) {
    if (exited)
      throw new Error("Sidecar exited: " + readFileSync(logPath, "utf8"));
    try {
      assert.equal((await request("/v1/health")).status, 200);
      break;
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await delay(150);
    }
  }
  assert.equal((await request("/v1/health", false)).status, 401);
  assert.equal((await request("/v1/health?api_key=" + key, false)).status, 401);
  assert.equal(
    (await request("/v1/searches/missing/events?api_key=" + key, false)).status,
    404,
  );
  const preflight = await request("/v1/health", false, { method: "OPTIONS" });
  assert.ok([200, 204].includes(preflight.status));
  assert.match(
    preflight.headers.get("Access-Control-Allow-Headers"),
    /Authorization/,
  );
  assert.equal((await (await request("/v1/version")).json()).mode, "desktop");
  const sources = (await (await request("/v1/sources")).json()).map(
    (s) => s.name,
  );
  assert.ok(sources.includes("momondo") && sources.includes("ff-kayak"));
  assert.equal((await request("/")).status, 200);
  assert.equal(
    (await request("/v1/flights?all=1&start=2026-12-21")).status,
    200,
  );
  assert.ok(existsSync(join(directory, "flights.db")));
  await checkTransport(transport);
  console.log(
    "Packaged Node backend passed: startup, authentication, SSE authentication, CORS, UI and SQLite.",
  );
} finally {
  child.kill();
  let timer;
  try {
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Sidecar did not stop")),
          10000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  closeSync(log);
  rmSync(directory, { recursive: true, force: true });
}

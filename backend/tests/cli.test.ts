import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";

function run(args: string[], data: string, extra: NodeJS.ProcessEnv = {}) {
  const p = spawn(
    process.execPath,
    ["--import", "tsx", resolve("src/cli.ts"), ...args],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        FLYSCAN_OFFLINE: "1",
        FLYSCAN_DATA_DIR: data,
        FLYSCAN_API_KEY: "cli-test-session",
        ...extra,
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  p.stdout.on("data", (b) => (stdout += b));
  p.stderr.on("data", (b) => (stderr += b));
  const closed = new Promise<number | null>((done, reject) => {
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error("CLI did not exit: " + stdout + " " + stderr));
    }, 15000);
    p.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.once("close", (code) => {
      clearTimeout(timer);
      done(code);
    });
  });
  return {
    p,
    closed,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}
test("checkout CLI replays the original recording without Python or source access", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flyscan-cli-"));
  try {
    const child = run(
      ["replay", resolve("../tests/recordings/ff-kiwi-ber-cdg")],
      directory,
      { FLYSCAN_PYTHON: "missing-python-is-never-started" },
    );
    assert.equal(await child.closed, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.offers, 3);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("server exits cleanly when its watched launcher disappears", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flyscan-parent-"));
  const parent = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    windowsHide: true,
    stdio: "ignore",
  });
  const child = run(
    ["serve", "--port", "0", "--exit-with-parent", String(parent.pid)],
    directory,
  );
  try {
    let port = 0;
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(
        () => reject(new Error("CLI startup timed out: " + child.stderr)),
        10000,
      );
      child.p.stdout.on("data", () => {
        const m = child.stdout.match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (m) {
          port = +m[1];
          clearTimeout(timer);
          done();
        }
      });
      child.p.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error("CLI exited early " + code + " " + child.stderr));
      });
    });
    const r = await fetch(`http://127.0.0.1:${port}/v1/health`, {
      headers: { Authorization: "Bearer cli-test-session" },
    });
    assert.equal(r.status, 200);
    parent.kill();
    assert.equal(await child.closed, 0, child.stderr);
  } finally {
    parent.kill();
    child.p.kill();
    await child.closed.catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
});
test("a failed server bind reports the error and releases its scheduler", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flyscan-bind-")),
    server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const port = (server.address() as any).port,
      child = run(["serve", "--port", String(port)], directory);
    assert.equal(await child.closed, 1);
    assert.match(child.stderr, /EADDRINUSE/);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(directory, { recursive: true, force: true });
  }
});

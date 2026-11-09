import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

export interface Cookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  expires?: number | null;
}
export interface RequestOptions {
  headers?: Record<string, string>;
  params?: Record<string, string>;
  json?: unknown;
  data?: Record<string, string> | string;
  timeout?: number;
  allow_redirects?: boolean;
}
export class HttpResponse {
  headers: Record<string, string>;
  constructor(
    public status: number,
    public url: string,
    public rawHeaders: [string, string][],
    public body: Buffer,
    public cookies: Cookie[] = [],
  ) {
    this.headers = Object.fromEntries(
      rawHeaders.map(([k, v]) => [k.toLowerCase(), v]),
    );
  }
  get text(): string {
    return this.body.toString("utf8");
  }
  json(): any {
    return JSON.parse(this.text);
  }
}
export interface Session {
  request(
    method: string,
    url: string,
    options?: RequestOptions,
  ): Promise<HttpResponse>;
  close(): Promise<void>;
}
export interface Transport {
  open(cookies?: Cookie[], impersonate?: string): Promise<Session>;
  close(force?: boolean): Promise<void>;
}
export class TransportError extends Error {
  constructor(
    public kind: string,
    message: string,
  ) {
    super(message);
    this.name = kind;
  }
}
export class PythonTransport implements Transport {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<
    string,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  private stopped = false;
  constructor(
    private command = process.env.FLYSCAN_TRANSPORT,
    private python = process.env.FLYSCAN_PYTHON || "python",
    private script = process.env.FLYSCAN_TRANSPORT_SCRIPT ||
      resolve(__dirnameSafe(), "../../flyscan/transport.py"),
  ) {}
  private start(): void {
    if (this.stopped) throw new Error("transport is closed");
    if (this.child) return;
    const child = this.command
      ? spawn(
          this.command,
          JSON.parse(process.env.FLYSCAN_TRANSPORT_ARGS || "[]"),
          { windowsHide: true, stdio: "pipe" },
        )
      : spawn(this.python, ["-u", this.script], {
          windowsHide: true,
          stdio: "pipe",
        });
    this.child = child;
    let stderr = "";
    child.stderr.on("data", (b) => {
      stderr = (stderr + b.toString()).slice(-4096);
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        const msg = JSON.parse(line);
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        if (msg.error)
          pending.reject(new TransportError(msg.error.kind, msg.error.message));
        else pending.resolve(msg.result);
      } catch {
        this.fail(new Error("invalid response from Python transport"));
        child.kill();
      }
    });
    // A crashed or unstartable worker fails what it was doing; the next
    // request starts a fresh one. Only close() stops the transport for good.
    child.on("error", (e) => {
      if (this.child === child) this.child = undefined;
      this.fail(e);
    });
    child.stdin.on("error", (e) => this.fail(e));
    child.on("close", (code, signal) => {
      if (this.child === child) this.child = undefined;
      this.fail(
        new Error(
          `Python transport exited (${code ?? signal})${stderr ? ": " + stderr : ""}`,
        ),
      );
    });
  }
  private fail(error: Error): void {
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
  }
  private rpc(op: string, data: Record<string, unknown>): Promise<any> {
    this.start();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child!.stdin.write(
        JSON.stringify({ id, op, ...data }) + "\n",
        (error) => {
          if (error) {
            this.pending.delete(id);
            reject(error);
          }
        },
      );
    });
  }
  async open(cookies: Cookie[] = [], impersonate = "chrome"): Promise<Session> {
    const session = randomUUID();
    await this.rpc("open", { session, cookies, impersonate });
    let active = false,
      closed = false,
      closeAfter = false;
    const shut = async () => {
      if (this.child) await this.rpc("close", { session }).catch(() => {});
    };
    return {
      request: async (method, url, options = {}) => {
        if (closed) throw new Error("session is closed");
        if (active) throw new Error("session already has an active request");
        active = true;
        try {
          const r = await this.rpc("request", {
            session,
            method,
            url,
            options,
          });
          return new HttpResponse(
            r.status,
            r.url,
            r.headers,
            Buffer.from(r.body, "base64"),
            r.cookies,
          );
        } finally {
          active = false;
          if (closeAfter) void shut();
        }
      },
      close: async () => {
        if (closed) return;
        closed = true;
        // An abandoned request (its attempt was aborted) closes the session
        // once the worker answers it.
        if (active) {
          closeAfter = true;
          return;
        }
        await shut();
      },
    };
  }
  async close(force = false): Promise<void> {
    this.stopped = true;
    const child = this.child;
    if (!child) return;
    await new Promise<void>((done) => {
      const timer = setTimeout(() => child.kill(), force ? 1000 : 65000);
      child.once("close", () => {
        clearTimeout(timer);
        done();
      });
      if (force) child.stdin.write(JSON.stringify({ op: "shutdown" }) + "\n");
      child.stdin.end();
    });
  }
}
function __dirnameSafe(): string {
  return typeof __dirname !== "undefined"
    ? __dirname
    : resolve(process.cwd(), "src");
}

export class OfflineTransport implements Transport {
  async open(): Promise<Session> {
    throw new Error("network requests are disabled in offline mode");
  }
  async close(): Promise<void> {}
}

/** Replay consumes recorded exchanges exactly; missing data never falls back to HTTP. */
export class ReplayTransport implements Transport {
  index: any;
  private position = 0;
  constructor(public directory: string) {
    this.index = JSON.parse(
      readFileSync(join(directory, "index.json"), "utf8"),
    );
  }
  async open(): Promise<Session> {
    return {
      request: async (method, url, options = {}) => {
        const exchanges = this.index.exchanges;
        const entry = exchanges[this.position++];
        if (!entry)
          throw new Error("recording exhausted; network fallback is forbidden");
        const request = entry.request || entry;
        if (request.method.toUpperCase() !== method.toUpperCase())
          throw new Error(
            `recorded method mismatch: ${request.method} != ${method}`,
          );
        const expected = new URL(request.url),
          actual = new URL(url);
        if (expected.href !== actual.href)
          throw new Error(`recorded URL mismatch: ${request.url} != ${url}`);
        const response = entry.response || entry;
        if (response.truncated || entry.truncated)
          throw new Error("recorded response was truncated");
        const file =
          response.body_file ||
          response.body_path ||
          entry.body_file ||
          entry.body;
        if (!file || !existsSync(join(this.directory, file)))
          throw new Error("recorded response body is missing");
        const headers = Array.isArray(response.headers)
          ? response.headers
          : Object.entries(response.headers || entry.response_headers || {});
        return new HttpResponse(
          response.status ?? response.status_code,
          response.response_url || request.url,
          headers,
          readFileSync(join(this.directory, file)),
        );
      },
      close: async () => {},
    };
  }
  assertConsumed(): void {
    if (this.position !== this.index.exchanges.length)
      throw new Error(
        `unconsumed recording exchanges: ${this.index.exchanges.length - this.position}`,
      );
  }
  async close(): Promise<void> {}
}

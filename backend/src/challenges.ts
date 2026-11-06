import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { checkPageScripts } from "./challenge-page.js";
import { addDays, now, query } from "./models.js";
import type { Scheduler } from "./scheduler.js";
import { ChallengeRequired, sourceNames, webMode } from "./sources.js";
import { atomicJSON, readJSON, type Data } from "./support.js";
import type { Cookie } from "./transport.js";

export class ChallengeCookies {
  constructor(
    public path = ".challenges",
    public ttl = 12,
  ) {}
  private file(source: string): string {
    if (!sourceNames.includes(source)) throw new Error("unknown source");
    return join(this.path, source + ".json");
  }
  save(
    source: string,
    cookies: Cookie[] | Record<string, string>,
    url = "",
    durable?: string[],
  ): void {
    const list = Array.isArray(cookies)
      ? cookies
      : Object.entries(cookies).map(([name, value]) => ({
          name,
          value: String(value),
        }));
    atomicJSON(this.file(source), {
      source,
      cookies: Object.fromEntries(list.map((c) => [c.name, c.value])),
      cookie_jar: list,
      url,
      solved_at: now(),
      ...(durable ? { durable: durable.sort() } : {}),
    });
  }
  load(source: string): Cookie[] {
    const r = readJSON(this.file(source));
    if (
      !r.solved_at ||
      !Number.isFinite(Date.parse(r.solved_at)) ||
      Date.now() - Date.parse(r.solved_at) > this.ttl * 3600000
    )
      return [];
    return Array.isArray(r.cookie_jar)
      ? r.cookie_jar.filter((c: Cookie) => r.cookies?.[c.name] === c.value)
      : Object.entries(r.cookies || {}).map(([name, value]) => ({
          name,
          value: String(value),
        }));
  }
  narrow(source: string): boolean {
    const r = readJSON(this.file(source));
    if (!r.durable || r.full) return false;
    const cookies = Object.fromEntries(
      Object.entries(r.cookies || {}).filter(([name]) =>
        r.durable.includes(name),
      ),
    );
    if (Object.keys(cookies).length === Object.keys(r.cookies || {}).length)
      return false;
    r.full = r.cookies;
    r.cookies = cookies;
    atomicJSON(this.file(source), r);
    return true;
  }
  restore(source: string): boolean {
    const r = readJSON(this.file(source));
    if (!r.full) return false;
    r.cookies = r.full;
    delete r.full;
    atomicJSON(this.file(source), r);
    return true;
  }
  clear(source: string): void {
    try {
      unlinkSync(this.file(source));
    } catch {}
  }
  profile(source: string): string {
    this.file(source);
    const path = join(this.path, source + "-profile");
    mkdirSync(path, { recursive: true });
    return path;
  }
  status(): Data[] {
    let files: string[];
    try {
      files = readdirSync(this.path);
    } catch {
      return [];
    }
    return files
      .filter((f) => sourceNames.some((s) => f === s + ".json"))
      .map((f) => {
        const r = readJSON(join(this.path, f)),
          age = (Date.now() - Date.parse(r.solved_at)) / 3600000;
        return {
          source: r.source || f.slice(0, -5),
          solved_at: r.solved_at || "",
          cookies: Object.keys(r.cookies || {}).length,
          fresh: Number.isFinite(age) && age <= this.ttl,
          age_hours: Number.isFinite(age) ? Math.round(age * 10) / 10 : null,
        };
      });
  }
}
export class ChallengeControl {
  cookies = new ChallengeCookies();
  private ephemeral: Record<string, string> = {};
  private solving = new Map<string, Promise<void>>();
  private recoveryErrors: Record<string, string> = {};
  private contexts = new Set<import("playwright").BrowserContext>();
  private stopped = false;
  constructor(private scheduler: Scheduler) {}
  pending(): Record<string, string> {
    return { ...this.scheduler.store?.pendingChallenges(), ...this.ephemeral };
  }
  reconcile(): void {
    /* The dispatcher reads SQLite on every tick, including clearance from another process. */
  }
  record(source: string, url: string, fetchId?: number): void {
    if (fetchId && this.scheduler.store)
      this.scheduler.store.challengeFetch(fetchId, url);
    else this.ephemeral[source] = url;
    delete this.recoveryErrors[source];
    if (process.env.FLYSCAN_CHALLENGE_VIEWER_URL && !webMode())
      this.startRecovery(source);
  }
  clear(source: string): boolean {
    const pending = !!this.pending()[source];
    this.scheduler.store?.clearChallenges(source);
    delete this.ephemeral[source];
    delete this.recoveryErrors[source];
    return pending;
  }
  accept(
    source: string,
    cookies: Cookie[] | Record<string, string>,
    url = "",
  ): number {
    this.cookies.save(source, cookies, url);
    this.clear(source);
    return Array.isArray(cookies)
      ? cookies.length
      : Object.keys(cookies).length;
  }
  status(): Data {
    return {
      pending: Object.entries(this.pending()).map(([source, url]) => ({
        source,
        url,
        solving: this.solving.has(source),
        error: this.recoveryErrors[source] || null,
      })),
      can_solve_here:
        !webMode() &&
        process.env.FLYSCAN_DESKTOP_SHELL !== "1" &&
        process.env.FLYSCAN_OFFLINE !== "1",
      mode: webMode() ? "web" : "desktop",
      how_to_clear: "npm run flyscan -- unblock <source>",
      ...(!webMode() && process.env.FLYSCAN_CHALLENGE_VIEWER_URL
        ? { viewer_url: process.env.FLYSCAN_CHALLENGE_VIEWER_URL }
        : {}),
    };
  }
  startRecovery(source: string): boolean {
    if (this.stopped || this.solving.has(source)) return false;
    const task = this.recover(source)
      .then((report) => {
        if (!report.solved && !this.stopped)
          this.recoveryErrors[source] =
            report.error || "verification was not completed";
      })
      .catch((e) => {
        this.recoveryErrors[source] = String(e);
        this.scheduler.errors.record("challenge.browser", e, { source });
      })
      .finally(() => this.solving.delete(source));
    this.solving.set(source, task);
    return true;
  }
  async probe(
    source: string,
  ): Promise<{ url: string | null; outcome: string }> {
    const s = this.scheduler.source(source),
      q = query({
        origin: "BER",
        destination: "LON",
        depart: addDays(new Date().toISOString().slice(0, 10), 30),
      });
    try {
      await s.search(q);
      return { url: null, outcome: "clear" };
    } catch (e) {
      return e instanceof ChallengeRequired
        ? { url: e.url, outcome: "challenged" }
        : { url: null, outcome: "error" };
    }
  }
  async recover(
    source: string,
    url = this.pending()[source],
    waitSeconds = 300,
  ): Promise<Data> {
    if (!url) {
      const probe = await this.probe(source);
      if (probe.outcome === "clear") {
        this.clear(source);
        return { source, solved: true, cookies: 0, outcome: "clear" };
      }
      url = probe.url || this.pending()[source];
    }
    if (!url)
      return {
        source,
        solved: false,
        cookies: 0,
        error: "could not obtain a challenge URL",
      };
    if (this.stopped)
      return { source, solved: false, cookies: 0, cancelled: true };
    const { chromium } = await import("playwright");
    const script = checkPageScripts[source],
      size = (process.env.FLYSCAN_CHECK_SCREEN || "1280x900").match(
        /^(\d+)x(\d+)$/,
      ),
      width = Number(size?.[1] || 1280),
      height = Number(size?.[2] || 900),
      scale = 1.3;
    const args = [
      "--hide-crash-restore-bubble",
      "--noerrdialogs",
      ...(script
        ? [
            `--app=${url}`,
            `--force-device-scale-factor=${scale}`,
            `--window-size=${Math.round(width / scale)},${Math.round(height / scale)}`,
            "--window-position=0,0",
          ]
        : []),
    ];
    const context = await chromium.launchPersistentContext(
      this.cookies.profile(source),
      {
        headless: false,
        locale: "en-GB",
        args,
        viewport: script ? null : { width: 1280, height: 900 },
      },
    );
    this.contexts.add(context);
    try {
      if (this.stopped)
        return { source, solved: false, cookies: 0, cancelled: true };
      if (script) await context.addInitScript(script);
      const page = context.pages()[0] || (await context.newPage());
      if (script) {
        try {
          const cdp = await context.newCDPSession(page);
          const window = await cdp.send("Browser.getWindowForTarget");
          await cdp.send("Browser.setWindowBounds", {
            windowId: window.windowId,
            bounds: {
              left: 0,
              top: 0,
              width: Math.round(width / scale),
              height: Math.round(height / scale),
              windowState: "normal",
            },
          });
          await cdp.detach();
        } catch {
          /* Window-manager support varies; verification remains usable without sizing. */
        }
      }
      const origin = new URL(url).origin;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      let stableSince = 0;
      const deadline = Date.now() + waitSeconds * 1000;
      while (Date.now() < deadline && !this.stopped && !page.isClosed()) {
        const landed = page.url(),
          clear =
            landed.startsWith(origin + "/") &&
            !landed.includes("/security/check");
        if (clear) {
          if (!stableSince) stableSince = Date.now();
          if (Date.now() - stableSince >= 2500) {
            const earned = (await context.cookies(origin)).filter(
              (c) =>
                c.domain &&
                new URL(origin).hostname.endsWith(c.domain.replace(/^\./, "")),
            );
            if (!earned.length) break;
            this.cookies.save(
              source,
              earned,
              url,
              earned.filter((c) => c.expires > 0).map((c) => c.name),
            );
            await this.keepClearingCookies(source);
            if (this.stopped)
              return { source, solved: false, cookies: 0, cancelled: true };
            this.clear(source);
            return {
              source,
              solved: true,
              cookies: earned.length,
              landed_on: landed,
            };
          }
        } else stableSince = 0;
        await delay(250);
      }
      return {
        source,
        solved: false,
        cookies: 0,
        ...(this.stopped ? { cancelled: true } : {}),
      };
    } finally {
      this.contexts.delete(context);
      await context.close();
    }
  }
  private async keepClearingCookies(source: string): Promise<void> {
    if (
      (await this.probe(source)).outcome !== "challenged" ||
      !this.cookies.narrow(source)
    )
      return;
    if ((await this.probe(source)).outcome !== "clear")
      this.cookies.restore(source);
  }
  async close(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.contexts].map((c) => c.close()));
    await Promise.allSettled([...this.solving.values()]);
  }
}

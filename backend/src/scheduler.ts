import { ChallengeControl } from "./challenges.js";
import {
  belongsTo,
  query,
  queryKey,
  type Progress,
  type Query,
  type SourceResult,
} from "./models.js";
import {
  ChallengeRequired,
  RateLimited,
  RetryableError,
  Source,
  SourceError,
  allowedSources,
  webMode,
  type AttemptContext,
} from "./sources.js";
import { CACHE_HOURS, FlightStore } from "./store.js";
import { ErrorLog, Rates, type Data } from "./support.js";
import { type Transport } from "./transport.js";

export class QueueFull extends Error {}
export class QueueClosed extends Error {}
export class JobTimeout extends Error {
  constructor() {
    super("attempt timed out");
    this.name = "JobTimeout";
  }
}
export class Cancelled extends Error {
  constructor() {
    super("search cancelled");
    this.name = "CancelledError";
  }
}
type State =
  | "queued"
  | "running"
  | "retry_wait"
  | "waiting_action"
  | "done"
  | "failed"
  | "timed_out"
  | "cancelled";
const terminal = (s: State) =>
  ["done", "failed", "timed_out", "cancelled"].includes(s);
interface Subscriber {
  owner: string;
  progress: Progress;
  resolve: (r: SourceResult) => void;
  done: boolean;
}
interface Scrape {
  id: number;
  key: string;
  q: Query;
  source: Source;
  state: State;
  owner: string;
  priority: number;
  created: number;
  started: number | null;
  finished: number | null;
  ready: number;
  attempts: number;
  failures: number;
  maxAttempts: number;
  error: string;
  count: number;
  busy: boolean;
  subscribers: Subscriber[];
  controller?: AbortController;
  fetchId?: number;
  action: Data | null;
  actionDeadline: number;
  actionRequests: number;
  waitReason: string;
  refresh: boolean;
  ttl: number;
  cached: boolean;
}
export interface Submission {
  id: number | null;
  result: Promise<SourceResult>;
}
export class Scheduler {
  actionTimeout = 900;
  /** Seconds an aborted attempt may take to let go before it is settled anyway. */
  timeoutGrace = 10;
  private nextId = 1;
  private pending = new Map<string, Scrape>();
  private scrapes = new Map<number, Scrape>();
  /** Scrapes not yet terminal, so a large finished history costs nothing. */
  private open = new Set<Scrape>();
  private busyCount = 0;
  private dispatchQueued = false;
  private sincePrune = 0;
  private groups = new Map<string, Map<string, Scrape>>();
  private gates = new Map<string, { busy: number; next: number }>();
  private timer?: ReturnType<typeof setTimeout>;
  private monitor: ReturnType<typeof setInterval>;
  private closed = false;
  private selection: Data | null = null;
  private selectionSet = false;
  private stats = { submitted: 0, shared: 0, cached: 0, scraped: 0 };
  readonly challenges: ChallengeControl;
  constructor(
    public store: FlightStore | null,
    public transport: Transport,
    public rates: Rates,
    public errors = new ErrorLog(),
    public maxWorkers = 12,
    public maxPending = 10000,
    public ttl = CACHE_HOURS,
    public maxRetries = 3,
    public sourceFactory = (name: string) => new Source(name, transport),
  ) {
    if (
      !Number.isInteger(maxWorkers) ||
      maxWorkers < 1 ||
      !Number.isInteger(maxPending) ||
      maxPending < 1
    )
      throw new Error("invalid queue capacity");
    this.challenges = new ChallengeControl(this);
    this.monitor = setInterval(() => {
      this.challenges.reconcile();
      this.dispatch();
    }, 500);
  }
  source(name: string): Source {
    const source = this.sourceFactory(name);
    source.cookies = this.challenges.cookies.load(name);
    return source;
  }
  submit(
    source: Source,
    q: Query,
    options: {
      owner?: string;
      priority?: number;
      refresh?: boolean;
      ttl?: number;
      retries?: number;
      progress?: Progress;
      delay?: number;
    } = {},
  ): Submission {
    if (this.closed) throw new QueueClosed("scheduler is shutting down");
    if (!allowedSources().includes(source.name))
      throw new SourceError("source disabled on the web");
    const priority = this.selectionSet
      ? belongsTo(this.queryFields(q), this.selection)
        ? 0
        : 10
      : (options.priority ?? 10);
    const key = queryKey(source.name, q),
      owner = options.owner || "",
      progress = options.progress || (() => {}),
      ttl = options.ttl ?? this.ttl;
    let task = this.pending.get(key);
    if (task && terminal(task.state)) {
      if (task.busy) throw new QueueFull("previous attempt is still stopping");
      this.pending.delete(key);
      task = undefined;
    }
    if (task) {
      this.stats.shared++;
      task.priority = Math.min(task.priority, priority);
      return this.subscribe(task, owner, progress);
    }
    if (webMode() && this.challenges.pending()[source.name])
      return {
        id: null,
        result: Promise.resolve({
          source: source.name,
          offers: [],
          error: "Temporarily unavailable: verification required",
          elapsed: 0,
          url: source.searchURL(q),
        }),
      };
    const decision =
      this.store && !options.refresh
        ? this.store.plan(q, [source.name], ttl, this.maxRetries)[source.name]
        : null;
    const fresh = decision?.why === "fresh";
    const skip =
      decision && !decision.fetch && decision.why !== "needs a human";
    if (!skip && this.open.size >= this.maxPending)
      throw new QueueFull(`queue capacity (${this.maxPending}) reached`);
    const id = this.nextId++;
    task = {
      id,
      key,
      q: structuredClone(q),
      source,
      state: skip ? (fresh ? "done" : "failed") : "queued",
      owner,
      priority,
      created: Date.now(),
      started: null,
      finished: skip ? Date.now() : null,
      ready: Date.now() + (options.delay || 0) * 1000,
      attempts: 0,
      failures: 0,
      maxAttempts: Math.max(1, options.retries ?? source.retries),
      error: skip && !fresh ? decision!.why : "",
      count: decision?.count || 0,
      busy: false,
      subscribers: [],
      action: null,
      actionDeadline: 0,
      actionRequests: 0,
      waitReason: "",
      refresh: !!options.refresh,
      ttl,
      cached: !!fresh,
    };
    this.scrapes.set(id, task);
    if (!skip) this.open.add(task);
    this.remember(task);
    this.stats.submitted++;
    if (skip) {
      if (fresh) this.stats.cached++;
      const result = {
        source: source.name,
        offers: [],
        error: task.error,
        elapsed: 0,
        url: source.searchURL(q),
        found: decision!.count,
      };
      this.notify(progress, "source_done", {
        source: source.name,
        day: q.depart,
        ret: q.ret,
        scrape_id: null,
        attempt: 0,
        count: result.found,
        error: result.error,
        elapsed: 0,
        origin: "cache",
        age_hours: decision!.age_hours,
        url: result.url,
      });
      return { id: null, result: Promise.resolve(result) };
    }
    this.pending.set(key, task);
    const submission = this.subscribe(task, owner, progress);
    this.dispatchSoon();
    return submission;
  }
  private subscribe(t: Scrape, owner: string, progress: Progress): Submission {
    const result = new Promise<SourceResult>((resolve) =>
      t.subscribers.push({ owner, progress, resolve, done: false }),
    );
    return { id: t.id, result };
  }
  private remember(t: Scrape): void {
    const id = queryKey("", t.q);
    let group = this.groups.get(id);
    if (!group) {
      group = new Map();
      this.groups.set(id, group);
    }
    group.set(t.source.name, t);
    this.groups.delete(id);
    this.groups.set(id, group);
    // Pruning walks every scrape; doing it per submission made bulk enqueues
    // quadratic. Readers (jobs, queryJobs) still prune before they answer.
    if (++this.sincePrune >= 256) this.prune();
  }
  /** One dispatch for a burst of submissions or completions. */
  private dispatchSoon(): void {
    if (this.dispatchQueued) return;
    this.dispatchQueued = true;
    queueMicrotask(() => {
      this.dispatchQueued = false;
      this.dispatch();
    });
  }
  private prune(): void {
    this.sincePrune = 0;
    const completed = [...this.groups.entries()].filter(([, group]) =>
      [...group.values()].every((t) => terminal(t.state) && !t.busy),
    );
    for (const [id] of completed.slice(0, -100)) this.groups.delete(id);
    const keep = new Set(
      [...this.groups.values()].flatMap((g) =>
        [...g.values()].map((t) => t.id),
      ),
    );
    for (const t of [...this.scrapes.values()]
      .filter((t) => terminal(t.state))
      .slice(-1000))
      keep.add(t.id);
    for (const [id, t] of this.scrapes)
      if (terminal(t.state) && !t.busy && !keep.has(id))
        this.scrapes.delete(id);
  }
  private notify(callback: Progress, event: string, data: Data): void {
    try {
      callback(event, structuredClone(data));
    } catch (e) {
      this.errors.record("scheduler.observer", e);
    }
  }
  private emit(t: Scrape, event: string, data: Data): void {
    for (const s of t.subscribers)
      if (!s.done)
        this.notify(s.progress, event, {
          ...data,
          source: t.source.name,
          day: t.q.depart,
          ret: t.q.ret,
          scrape_id: t.id,
          attempt: t.attempts,
        });
  }
  private settle(
    t: Scrape,
    state: State,
    error = "",
    offers: SourceResult["offers"] = [],
  ): void {
    if (terminal(t.state)) return;
    t.state = state;
    this.open.delete(t);
    t.error = error;
    t.finished = Date.now();
    const result: SourceResult = {
      source: t.source.name,
      offers,
      error,
      elapsed: t.started ? (Date.now() - t.started) / 1000 : 0,
      url: t.source.searchURL(t.q),
    };
    try {
      if (
        error &&
        t.fetchId &&
        this.store &&
        !this.challenges.pending()[t.source.name]
      )
        this.store.failFetch(t.fetchId, error);
    } catch (e) {
      this.errors.record("scheduler.ledger", e, { id: t.id });
    }
    t.subscribers.forEach((s, index) => {
      if (s.done) return;
      s.done = true;
      this.notify(s.progress, "source_done", {
        source: t.source.name,
        day: t.q.depart,
        ret: t.q.ret,
        scrape_id: t.id,
        attempt: t.attempts,
        count: offers.length,
        error,
        elapsed: result.elapsed,
        origin: index ? "shared" : "scrape",
        url: result.url,
      });
      s.resolve(structuredClone(result));
    });
    t.subscribers = [];
    if (!t.busy && this.pending.get(t.key) === t) this.pending.delete(t.key);
  }
  private dispatch(): void {
    if (this.closed) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const time = Date.now();
    let wake = Infinity;
    for (const t of [...this.open])
      if (
        t.state === "waiting_action" &&
        t.actionDeadline &&
        time >= t.actionDeadline
      ) {
        t.controller?.abort(new JobTimeout());
        this.settle(t, "timed_out", "challenge wait timed out");
      }
    let busy = this.busyCount;
    const waiting = [...this.open]
      .filter(
        (t) =>
          ["queued", "retry_wait", "waiting_action"].includes(t.state) &&
          !t.busy,
      )
      .sort((a, b) => a.priority - b.priority || a.id - b.id);
    const held = this.challenges.pending();
    for (const t of waiting) {
      if (held[t.source.name] && !webMode()) {
        t.state = "waiting_action";
        t.action = {
          kind: "captcha",
          message: "source needs a human",
          url: held[t.source.name],
        };
        if (!t.actionDeadline)
          t.actionDeadline = time + this.actionTimeout * 1000;
        wake = Math.min(wake, t.actionDeadline);
        continue;
      }
      if (t.state === "waiting_action") {
        t.state = "queued";
        t.action = null;
        t.actionDeadline = 0;
      }
      const gate = this.gates.get(t.source.name) || { busy: 0, next: 0 };
      this.gates.set(t.source.name, gate);
      t.waitReason = "";
      const ready = Math.max(t.ready, gate.next);
      if (ready > time) {
        t.waitReason = t.ready > time ? "backoff" : "rate_limit";
        wake = Math.min(wake, ready);
        continue;
      }
      if (gate.busy >= t.source.maxConcurrency) {
        t.waitReason = "resource_limit";
        continue;
      }
      if (busy >= this.maxWorkers) {
        t.waitReason = "capacity";
        continue;
      }
      gate.busy++;
      gate.next = time + t.source.minInterval * 1000;
      busy++;
      this.busyCount++;
      t.busy = true;
      t.state = "running";
      t.started = time;
      t.finished = null;
      t.attempts++;
      t.action = null;
      t.controller = new AbortController();
      void this.execute(t, gate);
    }
    if (Number.isFinite(wake)) {
      this.timer = setTimeout(
        () => this.dispatch(),
        Math.max(1, wake - Date.now()),
      );
      this.timer.unref();
    }
  }
  private async execute(
    t: Scrape,
    gate: { busy: number; next: number },
  ): Promise<void> {
    const deadline = Date.now() + t.source.jobTimeout * 1000,
      controller = t.controller!;
    const context: AttemptContext = {
      signal: controller.signal,
      remaining: () => Math.max(0.001, (deadline - Date.now()) / 1000),
      check: () => {
        if (controller.signal.aborted)
          throw controller.signal.reason || new Cancelled();
        if (Date.now() >= deadline) throw new JobTimeout();
      },
    };
    // Out of time, the attempt is aborted and handled like any failed attempt:
    // retried with backoff while attempts remain. Should the source not let go
    // within a grace period, the scrape is settled anyway.
    let grace: ReturnType<typeof setTimeout> | undefined;
    const attempt = t.attempts;
    const timeout = setTimeout(() => {
      controller.abort(new JobTimeout());
      grace = setTimeout(() => {
        if (t.busy && t.attempts === attempt) {
          this.settle(t, "timed_out", "attempt timed out");
          this.dispatch();
        }
      }, this.timeoutGrace * 1000);
      grace.unref();
    }, t.source.jobTimeout * 1000);
    timeout.unref();
    t.source.cookies = this.challenges.cookies.load(t.source.name);
    try {
      context.check();
      if (!t.subscribers.some((s) => !s.done)) throw new Cancelled();
      if (this.store) t.fetchId = this.store.beginFetch(t.q, t.source.name);
      this.emit(t, "source_start", {});
      const offers = await t.source.runInContext(context, () =>
        t.source.search(t.q),
      );
      context.check();
      const rates = await this.rates.get("EUR");
      context.check();
      if (this.store && t.fetchId)
        this.store.completeFetch(t.fetchId, offers, (p, c) =>
          rates.convert(p, c),
        );
      context.check();
      t.count = offers.length;
      this.stats.scraped++;
      this.settle(t, "done", "", offers);
    } catch (e) {
      if (terminal(t.state)) return;
      const error = e instanceof Error ? e : new Error(String(e));
      const timedOut =
        e instanceof JobTimeout ||
        controller.signal.reason instanceof JobTimeout;
      const slow =
        timedOut ||
        (e instanceof RetryableError &&
          /did not finish in time/.test(error.message));
      if ((controller.signal.aborted && !timedOut) || e instanceof Cancelled)
        this.settle(t, "cancelled", error.message);
      else if (e instanceof ChallengeRequired) {
        this.challenges.record(t.source.name, e.url, t.fetchId);
        this.emit(t, "challenge_required", { url: e.url });
        if (webMode())
          this.settle(
            t,
            "failed",
            "Temporarily unavailable: verification required",
          );
        else if (++t.actionRequests > 3) {
          this.settle(t, "failed", "source repeatedly requires human action");
        } else {
          t.state = "waiting_action";
          t.action = { kind: "captcha", message: error.message, url: e.url };
          t.actionDeadline = Date.now() + this.actionTimeout * 1000;
        }
      } else if (!(e instanceof SourceError) && ++t.failures < t.maxAttempts) {
        const base = slow ? t.source.timeoutBackoff : 1.5;
        let seconds =
          e instanceof RateLimited
            ? e.retryAfter
            : Math.min(
                slow ? 120 : 60,
                base * 2 ** Math.min(t.failures - 1, 30),
              ) *
              (0.5 + Math.random() * 0.5);
        if (e instanceof RateLimited)
          gate.next = Math.max(gate.next, Date.now() + seconds * 1000);
        t.ready = Date.now() + seconds * 1000;
        t.state = "retry_wait";
        t.error = timedOut ? "attempt timed out" : error.message;
        this.emit(t, "source_retry", { error: t.error });
      } else {
        this.errors.record(`source.${t.source.name}`, error, {
          query: t.q,
          attempts: t.attempts,
        });
        if (timedOut) this.settle(t, "timed_out", "attempt timed out");
        else this.settle(t, "failed", `${error.name}: ${error.message}`);
      }
    } finally {
      clearTimeout(timeout);
      clearTimeout(grace);
      t.busy = false;
      this.busyCount--;
      gate.busy--;
      if (terminal(t.state) && this.pending.get(t.key) === t)
        this.pending.delete(t.key);
      this.dispatchSoon();
    }
  }
  cancelOwner(owner: string): number {
    let count = 0;
    for (const t of this.scrapes.values()) {
      for (const s of t.subscribers)
        if (!s.done && s.owner === owner) {
          s.done = true;
          s.resolve({
            source: t.source.name,
            offers: [],
            error: "cancelled",
            elapsed: 0,
            url: t.source.searchURL(t.q),
          });
          count++;
        }
      if (!terminal(t.state) && !t.subscribers.some((s) => !s.done))
        this.cancelJob(t.id);
    }
    return count;
  }
  cancelJob(id: number): "cancelled" | "gone" {
    const t = this.scrapes.get(id);
    if (!t || terminal(t.state)) return "gone";
    t.controller?.abort(new Cancelled());
    this.settle(t, "cancelled", "cancelled");
    this.dispatch();
    return "cancelled";
  }
  cancelQueued(): number {
    let n = 0;
    for (const t of this.scrapes.values())
      if (
        ["queued", "retry_wait", "waiting_action"].includes(t.state) &&
        this.cancelJob(t.id) === "cancelled"
      )
        n++;
    return n;
  }
  promote(id: number): boolean {
    const t = this.scrapes.get(id);
    if (!t || terminal(t.state) || t.busy) return false;
    t.priority = 0;
    this.dispatch();
    return true;
  }
  retry(id: number): number | null {
    const t = this.scrapes.get(id);
    if (!t || !terminal(t.state) || t.busy) return null;
    return this.submit(this.source(t.source.name), t.q, {
      owner: t.owner,
      refresh: true,
      priority: 0,
      ttl: t.ttl,
    }).id;
  }
  select(selection: Data | null): void {
    this.selectionSet = true;
    this.selection = selection ? structuredClone(selection) : null;
    for (const t of this.scrapes.values())
      if (!terminal(t.state))
        t.priority = belongsTo(this.queryFields(t.q), selection) ? 0 : 10;
    this.dispatch();
  }
  private queryFields(q: Query): Data {
    return { ...q, ret: q.ret || "", route: q.origin + "-" + q.destination };
  }
  describe(t: Scrape): Data {
    const end = t.finished || Date.now(),
      ready = Math.max(t.ready, this.gates.get(t.source.name)?.next || 0),
      state =
        (
          {
            retry_wait: "queued",
            waiting_action: "blocked",
            timed_out: "failed",
          } as Data
        )[t.state] || t.state;
    let status =
      (
        {
          queued: "waiting",
          retry_wait: "retrying",
          waiting_action: "waiting_input",
          done: t.cached ? "cached" : "completed",
        } as Data
      )[t.state] || t.state;
    if (terminal(t.state) && t.busy)
      status = t.state === "cancelled" ? "cancelling" : "stopping";
    else if (t.state === "queued" && t.waitReason === "rate_limit")
      status = "rate_limited";
    return {
      id: t.cached ? null : t.id,
      kind: "scrape",
      resource: t.source.name,
      source: t.source.name,
      query_id: queryKey("", t.q),
      ...this.queryFields(t.q),
      state,
      queue_state: t.state,
      status,
      params: [
        ...(t.q.adults !== 1 || t.q.children || t.q.infants
          ? [
              `${t.q.adults} adults, ${t.q.children} children, ${t.q.infants} infants`,
            ]
          : []),
        ...(t.q.cabin !== "economy"
          ? [t.q.cabin[0].toUpperCase() + t.q.cabin.slice(1)]
          : []),
      ].join(" · "),
      owner: t.owner,
      priority: t.priority,
      attempts: t.attempts,
      failures: t.failures,
      error: t.error,
      action: t.action,
      queued_at: new Date(t.created).toISOString(),
      created_at: new Date(t.created).toISOString(),
      started_at: t.started ? new Date(t.started).toISOString() : null,
      finished_at: t.finished ? new Date(t.finished).toISOString() : null,
      count: t.count,
      elapsed: t.started ? Math.round((end - t.started) / 100) / 10 : null,
      waited: Math.round(((t.started || end) - t.created) / 100) / 10,
      worker_busy: t.busy,
      retry_in:
        t.state === "retry_wait"
          ? Math.max(0, (t.ready - Date.now()) / 1000)
          : null,
      ready_in: ["queued", "retry_wait"].includes(t.state)
        ? Math.max(0, (ready - Date.now()) / 1000)
        : null,
      wait_reason: t.waitReason,
    };
  }
  find(id: number): Data | null {
    const t = this.scrapes.get(id);
    return t ? this.describe(t) : null;
  }
  jobs(): Data[] {
    this.prune();
    return [...this.scrapes.values()].map((t) => this.describe(t));
  }
  queryJobs(): Data[] {
    this.prune();
    return [...this.groups.entries()].map(([id, g]) => {
      const first = [...g.values()][0];
      return {
        id,
        ...this.queryFields(first.q),
        mine: belongsTo(this.queryFields(first.q), this.selection),
        sources: [...g.values()]
          .map((t) => this.describe(t))
          .sort((a, b) => a.source.localeCompare(b.source)),
        created_at: new Date(
          Math.min(...[...g.values()].map((t) => t.created)),
        ).toISOString(),
      };
    });
  }
  queryAction(id: string, action: string, source?: string): Data | null {
    const group = this.groups.get(id);
    if (!group || (source && !group.has(source))) return null;
    const rows = source ? [group.get(source)!] : [...group.values()],
      counts: Data = { cancelled: 0, retried: 0, skipped: 0, errors: [] };
    for (const t of rows) {
      if (action === "cancel") {
        counts[
          this.cancelJob(t.id) === "cancelled" ? "cancelled" : "skipped"
        ]++;
        continue;
      }
      if (!terminal(t.state) || t.busy || (!source && t.state === "done")) {
        counts.skipped++;
        continue;
      }
      try {
        counts[this.retry(t.id) !== null ? "retried" : "skipped"]++;
      } catch (e) {
        counts.skipped++;
        counts.errors.push({ source: t.source.name, error: String(e) });
      }
    }
    return counts;
  }
  selectionAction(selection: Data, action: string): Data {
    const groups = this.queryJobs().filter((g) => belongsTo(g, selection)),
      out: Data = {
        groups: groups.length,
        cancelled: 0,
        retried: 0,
        skipped: 0,
        errors: [],
      };
    for (const g of groups) {
      const r = this.queryAction(g.id, action)!;
      for (const k of ["cancelled", "retried", "skipped"]) out[k] += r[k];
      out.errors.push(...r.errors);
    }
    return out;
  }
  restore(groups: Data[], capturedAt = Date.now() / 1000): void {
    if (this.groups.size)
      throw new Error("queue restoration requires a fresh scheduler");
    const elapsed = Math.max(0, Date.now() / 1000 - capturedAt);
    for (const g of groups) {
      const q = query({
        ...g,
        origin: g.origin,
        destination: g.destination,
        depart: g.depart,
        ret: g.ret || null,
      });
      for (const row of g.sources) {
        if (!allowedSources().includes(row.source)) continue;
        if (
          ["done", "failed", "timed_out", "cancelled"].includes(row.queue_state)
        ) {
          const submission = this.submit(this.source(row.source), q, {
            refresh: true,
            delay: 3600000,
          });
          const t = this.scrapes.get(submission.id!)!;
          t.count = row.count;
          t.attempts = row.attempts || 0;
          t.created = Date.parse(row.queued_at);
          this.settle(t, row.queue_state, row.error || "");
          continue;
        }
        if (row.queue_state === "waiting_action" && row.action?.url)
          this.challenges.record(row.source, row.action.url);
        this.submit(this.source(row.source), q, {
          refresh: true,
          owner: row.owner,
          priority: row.priority,
          delay: Math.max(
            0,
            (row.ready_in || 0) - elapsed,
            row.queue_state === "running"
              ? this.source(row.source).minInterval -
                  (row.elapsed || 0) -
                  elapsed
              : 0,
          ),
        });
      }
    }
  }
  snapshot(): Data {
    const counts: Partial<Record<State, number>> = {};
    for (const t of this.scrapes.values())
      counts[t.state] = (counts[t.state] || 0) + 1;
    const count = (s: State) => counts[s] || 0,
      busy = this.busyCount;
    return {
      ...this.stats,
      queued: count("queued") + count("retry_wait"),
      running: count("running"),
      retry_wait: count("retry_wait"),
      waiting_action: count("waiting_action"),
      done: count("done"),
      failed: count("failed"),
      cancelled: count("cancelled"),
      timed_out: count("timed_out"),
      workers_busy: busy,
      in_flight: busy,
      max_workers: this.maxWorkers,
      max_pending: this.maxPending,
      challenges: this.challenges.pending(),
    };
  }
  storedOffers(q: Query): SourceResult["offers"] | null {
    return (
      this.store
        ?.offersForSearch(q)
        .filter(
          (o) => o.source === "manual" || allowedSources().includes(o.source),
        ) ?? null
    );
  }
  async close(force = false): Promise<void> {
    this.closed = true;
    clearInterval(this.monitor);
    if (this.timer) clearTimeout(this.timer);
    for (const t of this.scrapes.values())
      if (!terminal(t.state)) {
        t.controller?.abort(new Cancelled());
        this.settle(t, "cancelled", "scheduler is shutting down");
      }
    if (force) await this.transport.close(true);
    await this.challenges.close();
    while ([...this.scrapes.values()].some((t) => t.busy))
      await new Promise((r) => setTimeout(r, 10));
    this.store?.close();
    if (!force) await this.transport.close();
  }
}

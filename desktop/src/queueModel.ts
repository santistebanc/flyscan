import type { QueryJob, QueueJob, SearchRequest } from "./api";

const TERMINAL = new Set(["done", "failed", "timed_out", "cancelled"]);
export const canCancel = (job: QueueJob) => !TERMINAL.has(job.queue_state);
export const canRetry = (job: QueueJob) => TERMINAL.has(job.queue_state) && !job.worker_busy;

type QueueRank = readonly [stage: number, delay: number, priority: number, id: number];

function sourceQueueRank(job: QueueJob): QueueRank {
  const priority = job.priority ?? 10;
  const id = job.id ?? Infinity;
  if (job.worker_busy || job.queue_state === "running") return [0, 0, priority, id];
  if (job.queue_state === "queued" || job.queue_state === "retry_wait") {
    // Dispatch skips source gates before choosing by priority and task ID.
    // Snapshots are read separately: ignore subsecond drift in a shared cooldown.
    const delay = job.wait_reason === "source_busy" ? Infinity : Math.ceil(Math.max(0, job.ready_in ?? 0));
    return [delay > 0 ? 2 : 1, delay, priority, id];
  }
  return [job.queue_state === "waiting_action" ? 3 : 4, 0, priority, id];
}

function compareQueueRank(a: QueueRank, b: QueueRank): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  }
  return 0;
}

/** Rank a search by its next source; finished searches follow all live work. */
export function sortQueueGroups(groups: QueryJob[]): QueryJob[] {
  return groups.map((group) => ({ group, rank: group.sources.reduce<QueueRank>((best, source) => {
    const rank = sourceQueueRank(source);
    return compareQueueRank(rank, best) < 0 ? rank : best;
  }, [4, 0, Infinity, Infinity]) })).sort((a, b) => {
    if (a.rank[0] !== 4 || b.rank[0] !== 4) {
      const order = compareQueueRank(a.rank, b.rank);
      if (order) return order;
    }
    return b.group.created_at.localeCompare(a.group.created_at) || a.group.id.localeCompare(b.group.id);
  }).map(({ group }) => group);
}

/** Keep the selected range and unfinished work visible; fold away settled history. */
export function splitQueueGroups(groups: QueryJob[], pendingIds: readonly string[] = []) {
  const active: QueryJob[] = [], inactive: QueryJob[] = [];
  const pending = new Set(pendingIds);
  for (const group of sortQueueGroups(groups)) {
    const visible = group.mine || pending.has(group.id)
      || group.sources.some((source) => canCancel(source) || source.worker_busy);
    (visible ? active : inactive).push(group);
  }
  return { active, inactive };
}

export function groupStatus(jobs: QueueJob[]) {
  const loading = jobs.some((job) => job.queue_state === "running" || job.worker_busy);
  const state = jobs.some((job) => ["failed", "timed_out"].includes(job.queue_state)) ? "failed"
    : jobs.some((job) => job.queue_state === "waiting_action") ? "input"
    : loading ? "running"
    : jobs.some((job) => ["queued", "retry_wait"].includes(job.queue_state)) ? "waiting"
    : jobs.some((job) => job.queue_state === "cancelled") ? "cancelled" : "done";
  return { state, loading, label: jobs.length ? queueSummary(jobs) : "Waiting for sources" } as const;
}

type PendingSourceAction = { action: "cancel" | "retry"; source?: string };

export function sourceIsPending(job: QueueJob, pending?: PendingSourceAction): boolean {
  return Boolean(pending && (!pending.source || pending.source === job.source)
    && (pending.action === "cancel" ? canCancel(job) : canRetry(job) && (pending.source || job.state !== "done")));
}

/** Each source contributes to one count; cached results share the completed count. */
export function queueStatusCounts(jobs: QueueJob[], pending?: PendingSourceAction) {
  const labels = { done: "completed", cancelled: "cancelled", failed: "failed", input: "need verification",
    running: "in progress", waiting: "queued or waiting to retry" };
  type Status = keyof typeof labels;
  const counts: Record<Status, number> = { done: 0, cancelled: 0, failed: 0, input: 0, running: 0, waiting: 0 };
  for (const job of jobs) {
    const state: Status = sourceIsPending(job, pending) || job.worker_busy || job.queue_state === "running" ? "running"
      : job.queue_state === "done" ? "done"
      : job.queue_state === "cancelled" ? "cancelled"
      : job.queue_state === "waiting_action" ? "input"
      : job.queue_state === "queued" || job.queue_state === "retry_wait" ? "waiting" : "failed";
    counts[state]++;
  }
  return (Object.keys(counts) as Status[]).filter((state) => counts[state] > 0)
    .map((state) => ({ state, count: counts[state], label: `${counts[state]} ${labels[state]}` }));
}

export function matchesSelection(job: QueryJob, selection: SearchRequest | null): boolean {
  if (!selection) return false;
  const ret = selection.ret || "";
  return job.origin.toUpperCase() === selection.origin.trim().toUpperCase()
    && job.destination.toUpperCase() === selection.destination.trim().toUpperCase()
    && job.depart >= selection.start && job.depart <= (selection.end || selection.start)
    && (ret ? job.ret >= ret && job.ret <= (selection.ret_end || ret) : !job.ret)
    && job.adults === (selection.adults ?? 1) && job.children === (selection.children ?? 0)
    && job.infants === (selection.infants ?? 0) && job.cabin === (selection.cabin ?? "economy")
    && job.currency === (selection.currency || "EUR").toUpperCase();
}

export function rangeStats(groups: QueryJob[]) {
  const sources = groups.flatMap((group) => group.sources);
  return {
    groups: groups.length, total: sources.length,
    completedGroups: groups.filter((g) => g.sources.length > 0 && g.sources.every((s) => s.state === "done")).length,
    done: sources.filter((s) => s.state === "done").length,
    offers: sources.reduce((sum, s) => sum + (s.count || 0), 0),
    cancellable: sources.filter(canCancel).length,
    retryable: sources.filter((s) => s.state !== "done" && canRetry(s)).length,
    summary: queueSummary(sources),
  };
}

/**
 * True when every trip has an answer from every wanted source. Without
 * `sources`, a trip wants whichever sources were queued for it; with them, an
 * earlier fetch that skipped one of them leaves the trip unfinished.
 */
export function rangeAnswered(groups: QueryJob[], trips: number, sources?: readonly string[]): boolean {
  return trips > 0 && groups.length === trips && groups.every((group) => {
    const wanted = sources ?? group.sources.map((job) => job.source);
    return wanted.length > 0
      && wanted.every((name) => group.sources.some((job) => job.source === name && job.state === "done"));
  });
}

export function sourceLabel(source: string): string {
  return ({ "ff-kayak": "Kayak", "ff-sky": "Skyscanner", "ff-kiwi": "Kiwi",
    momondo: "Momondo", jetradar: "Jetradar" } as Record<string, string>)[source] ?? source;
}

export function queueSummary(jobs: QueueJob[]): string {
  const running = jobs.filter((j) => j.queue_state === "running").length;
  const waiting = jobs.filter((j) => ["queued", "retry_wait"].includes(j.queue_state)).length;
  const input = jobs.filter((j) => j.queue_state === "waiting_action").length;
  const failed = jobs.filter((j) => ["failed", "timed_out"].includes(j.queue_state)).length;
  const stopping = jobs.filter((j) => j.worker_busy && TERMINAL.has(j.queue_state)).length;
  const cancelled = jobs.filter((j) => j.queue_state === "cancelled" && !j.worker_busy).length;
  return [running && `${running} searching`, waiting && `${waiting} queued`,
    input && `${input} ${input === 1 ? "needs" : "need"} your help`, failed && `${failed} failed`,
    stopping && `${stopping} stopping`, cancelled && `${cancelled} cancelled`].filter(Boolean).join(" · ") || "All done";
}

export function sourceDetail(job: QueueJob): string {
  const attempt = (job.attempts ?? 0) > 0 ? `Attempt ${job.attempts}` : "";
  const ready = job.ready_in ? `in ${Math.ceil(job.ready_in)}s` : "shortly";
  switch (job.status) {
    case "rate_limited": return `This source needs a short break. Trying again ${ready}.`;
    case "retrying": return `${attempt} · trying again ${ready}${job.error ? ` · ${job.error}` : ""}`;
    case "waiting_input": return "Complete the verification above to continue.";
    case "cancelling": case "stopping": return "Waiting for the current request to stop.";
    case "waiting": return "Your search will start as soon as this source is ready.";
    case "running": return `${attempt} · ${Math.floor(job.elapsed ?? 0)}s elapsed`;
    case "cached": return `${job.count} offers from a recent search.`;
    case "completed": return `${job.count} offers found.`;
    case "cancelled": return "Cancelled. You can try again anytime.";
    case "timed_out": return "This source took too long to respond. Try again.";
    default: return "Couldn’t get prices from this source. Try again.";
  }
}

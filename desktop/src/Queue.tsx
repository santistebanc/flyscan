/** Process-wide query jobs. Result filters select priority, never visibility. */
import { useState } from "react";
import type { QueryJob, QueueJob } from "./api";
import type { QueueController, QueueMutation } from "./useQueue";
import { canCancel, canRetry, queueStatusCounts, sourceIsPending, splitQueueGroups, sourceDetail, sourceLabel } from "./queueModel";
import { Icon, Spinner } from "./Icon";

const day = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined,
  { month: "short", day: "numeric", ...(iso.slice(0, 4) !== String(new Date().getFullYear()) ? { year: "numeric" as const } : {}) });

export function ActionButton({ action, label, busy, pending = false, onClick }: {
  action: "cancel" | "retry"; label: string; busy: boolean; pending?: boolean; onClick: () => void;
}) {
  return <button type="button" className="queue-icon-button" disabled={busy}
    title={label} aria-label={label} aria-busy={pending || undefined} onClick={onClick}>
    {pending ? <Spinner /> : <Icon name={action} />}
  </button>;
}

/** What a source is doing, in the words the queue uses. */
function sourceState(job: QueueJob): string {
  switch (job.status) {
    case "completed": case "cached": return "Done";
    case "running": return "Searching…";
    case "waiting": return "Queued";
    case "rate_limited": return "Rate limited";
    case "retrying": return "Trying again";
    case "waiting_input": return "Verify to continue";
    case "cancelled": return "Cancelled";
    case "cancelling": return "Cancelling";
    case "stopping": return "Stopping";
    case "timed_out": return "Took too long";
    default: return job.error ? `Failed · ${job.error}` : "Failed";
  }
}

function SourceRow({ job, busy, pending, onAct }: {
  job: QueueJob; busy: boolean; pending?: QueueMutation; onAct: (action: "cancel" | "retry", source?: string) => void;
}) {
  const name = sourceLabel(job.source);
  const submitting = sourceIsPending(job, pending);
  const text = submitting ? pending?.action === "retry" ? "Requesting retry" : "Cancelling" : sourceState(job);
  const metric = job.state === "done" ? `${job.count} offers`
    : job.ready_in ? `in ${Math.ceil(job.ready_in)}s` : "";
  return <li className={`query-source ${submitting ? "running" : job.status}`}>
    <span className="query-source-name">{name}</span>
    <span className="query-source-status" title={submitting ? text : `${text}. ${sourceDetail(job)}`}>{text}</span>
    <span className="query-source-metric">{metric}</span>
    {canCancel(job) && <ActionButton action="cancel" busy={busy} pending={submitting && pending?.action === "cancel"}
      label={`Cancel ${name}`} onClick={() => onAct("cancel", job.source)} />}
    {canRetry(job) && <ActionButton action="retry" busy={busy} pending={submitting && pending?.action === "retry"}
      label={`${job.state === "done" ? "Refresh" : "Retry"} ${name}`}
      onClick={() => onAct("retry", job.source)} />}
  </li>;
}

function QueryGroup({ group, busy, pending, expanded, onToggle, onAct }: {
  group: QueryJob; busy: boolean; pending?: QueueMutation; expanded: boolean; onToggle: () => void;
  onAct: (action: "cancel" | "retry", source?: string) => void;
}) {
  const counts = queueStatusCounts(group.sources, pending);
  const retryable = group.sources.some((s) => s.state !== "done" && canRetry(s));
  const cancellable = group.sources.some(canCancel);
  const options: string[] = [];
  if (group.adults !== 1) options.push(`${group.adults} adults`);
  if (group.children) options.push(`${group.children} child${group.children === 1 ? "" : "ren"}`);
  if (group.infants) options.push(`${group.infants} infant${group.infants === 1 ? "" : "s"}`);
  if (group.cabin !== "economy") options.push(group.cabin === "premiumeconomy" ? "Premium"
    : group.cabin.charAt(0).toUpperCase() + group.cabin.slice(1));
  if (group.currency !== "EUR") options.push(group.currency);
  const dates = `${day(group.depart)}${group.ret ? ` – ${day(group.ret)}` : ""}`;
  return <article className={`query-group${group.mine ? " selected" : ""}`}>
    <div className="query-group-row">
      <button type="button" className="query-group-head" aria-expanded={expanded}
        aria-current={group.mine ? "true" : undefined}
        title={`${group.origin} to ${group.destination}, ${dates}${options.length ? ` · ${options.join(" · ")}` : ""}`}
        aria-controls={expanded ? `query-${group.id}` : undefined} onClick={onToggle}>
        <Icon name="chevron-right" className="caret" />
        <span className="query-route">{group.origin} → {group.destination}</span>
        <span className="query-dates">{dates}</span>
        {options.length > 0 && <span className="query-options">{options.join(" · ")}</span>}
      </button>
      <span className="query-group-progress" role="img" aria-label={counts.map((status) => status.label).join(". ")}>
        {counts.map(({ state, count, label }) => <span key={state} className={`queue-progress ${state}`} title={label}>
          {count}{state === "running" ? <Spinner /> : <Icon name={state} />}
        </span>)}
      </span>
      {retryable && <ActionButton action="retry" busy={busy} pending={pending?.action === "retry" && !pending.source} onClick={() => onAct("retry")}
        label={`Retry unfinished sources for ${group.origin} to ${group.destination} on ${group.depart}`} />}
      {cancellable && <ActionButton action="cancel" busy={busy} pending={pending?.action === "cancel" && !pending.source} onClick={() => onAct("cancel")}
        label={`Cancel search ${group.origin} to ${group.destination} on ${group.depart}`} />}
    </div>
    {expanded && <ul className="query-sources" id={`query-${group.id}`}>
      {group.sources.map((job) => <SourceRow key={job.source} job={job} busy={busy} pending={pending} onAct={onAct} />)}
    </ul>}
  </article>;
}

export function Queue({ queue }: { queue: QueueController }) {
  const { state, groups: allGroups, busy, error, offline, priorityError, act } = queue;
  const [shown, setShown] = useState(20);
  const [inactiveShown, setInactiveShown] = useState(20);
  const [inactiveOpen, setInactiveOpen] = useState(false);
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const { active, inactive } = splitQueueGroups(allGroups, busy?.groupIds);
  // Other searches with unfinished sources open by default, so trouble is visible.
  const opens = (group: QueryJob) => toggled[group.id]
    ?? (!group.mine && group.sources.some((source) => source.state !== "done"));
  const renderGroup = (group: QueryJob) => <QueryGroup key={group.id} group={group}
    expanded={opens(group)} busy={busy !== null}
    pending={busy?.groupIds.includes(group.id) ? busy : undefined}
    onToggle={() => setToggled((was) => ({ ...was, [group.id]: !opens(group) }))}
    onAct={(action, source) => void act(group.id, action, source)} />;
  return <section className="queue" aria-label="Search queue">
    {offline && <p role="status" className="queue-notice">Reconnecting… Status may be out of date.</p>}
    {priorityError && <p role="alert" className="queue-notice">{priorityError}</p>}
    {error && <p role="alert" className="queue-notice">{error}</p>}
    {!state && !offline && <p className="side-note" role="status">Loading queue…</p>}
    {state && !allGroups.length && <p className="side-note">No searches yet. Fetch flights to get started.</p>}
    {active.slice(0, shown).map(renderGroup)}
    {active.length > shown && <button type="button" className="queue-more"
      onClick={() => setShown((n) => n + 20)}>Show more ({active.length - shown} remaining)</button>}
    {inactive.length > 0 && <div className="queue-inactive">
      <button type="button" className="queue-inactive-toggle" aria-expanded={inactiveOpen}
        aria-controls={inactiveOpen ? "inactive-searches" : undefined}
        onClick={() => setInactiveOpen((was) => !was)}>
        <Icon name="chevron-right" className="caret" />
        <span>Inactive searches</span>
        <span className="queue-inactive-count">{inactive.length}</span>
      </button>
      {inactiveOpen && <div id="inactive-searches">
        {inactive.slice(0, inactiveShown).map(renderGroup)}
        {inactive.length > inactiveShown && <button type="button" className="queue-more"
          onClick={() => setInactiveShown((n) => n + 20)}>Show more ({inactive.length - inactiveShown} remaining)</button>}
      </div>}
    </div>}
  </section>;
}

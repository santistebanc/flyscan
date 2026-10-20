/** Process-wide query jobs. Result filters select priority, never visibility. */
import { useState } from "react";
import type { QueryJob, QueueJob } from "./api";
import type { QueueController, QueueMutation } from "./useQueue";
import { canCancel, canRetry, groupStatus, queueStatusCounts, sourceIsPending, splitQueueGroups, sourceDetail, sourceLabel, statusLabel } from "./queueModel";
import { QueueStatusIcon } from "./QueueStatusIcon";
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

function SourceRow({ job, busy, pending, onAct }: {
  job: QueueJob; busy: boolean; pending?: QueueMutation; onAct: (action: "cancel" | "retry", source?: string) => void;
}) {
  const name = sourceLabel(job.source);
  const detail = sourceDetail(job);
  const submitting = sourceIsPending(job, pending);
  const status = submitting ? { state: "running" as const, loading: true } : groupStatus([job]);
  const description = submitting ? pending?.action === "retry" ? "Requesting retry" : "Cancelling"
    : `${statusLabel(job.status)}. ${job.error || detail}`;
  const metric = job.state === "done" ? { value: job.count, label: `${job.count} offers` }
    : job.ready_in ? { value: `${Math.ceil(job.ready_in)}s`, label: `Trying again in ${Math.ceil(job.ready_in)} seconds` }
    : null;
  return <li className={`query-source ${job.status}`}>
    <div className="query-source-line">
      <span className="query-source-name">{name}</span>
      <span className="query-source-status" role="img" aria-label={description} title={description}>
        <QueueStatusIcon {...status} />
      </span>
      {job.status === "waiting_input" && <span className="query-source-hint">Verify to continue</span>}
      <span className="query-source-metric" role={metric ? "img" : undefined} aria-label={metric?.label} title={metric?.label}>
        {metric?.value}
      </span>
      <span className="query-source-actions">
        {canCancel(job) && <ActionButton action="cancel" busy={busy} pending={submitting && pending?.action === "cancel"}
          label={`Cancel ${name}`} onClick={() => onAct("cancel", job.source)} />}
        {canRetry(job) && <ActionButton action="retry" busy={busy} pending={submitting && pending?.action === "retry"}
          label={`${job.state === "done" ? "Refresh" : "Retry"} ${name}`}
          onClick={() => onAct("retry", job.source)} />}
      </span>
    </div>
  </li>;
}

function QueryGroup({ group, busy, pending, expanded, onToggle, onAct }: {
  group: QueryJob; busy: boolean; pending?: QueueMutation; expanded: boolean; onToggle: () => void;
  onAct: (action: "cancel" | "retry", source?: string) => void;
}) {
  const counts = queueStatusCounts(group.sources, pending);
  const retryable = group.sources.some((s) => s.state !== "done" && canRetry(s));
  const cancellable = group.sources.some(canCancel);
  const options: { text: string; label: string; person?: boolean }[] = [];
  if (group.adults !== 1) options.push({ text: String(group.adults), label: `${group.adults} adults`, person: true });
  if (group.children) options.push({ text: `${group.children} child${group.children === 1 ? "" : "ren"}`, label: `${group.children} child${group.children === 1 ? "" : "ren"}` });
  if (group.infants) options.push({ text: `${group.infants} infant${group.infants === 1 ? "" : "s"}`, label: `${group.infants} infant${group.infants === 1 ? "" : "s"}` });
  if (group.cabin !== "economy") options.push({
    text: group.cabin === "premiumeconomy" ? "Premium" : group.cabin.charAt(0).toUpperCase() + group.cabin.slice(1),
    label: group.cabin === "premiumeconomy" ? "Premium economy" : group.cabin,
  });
  if (group.currency !== "EUR") options.push({ text: group.currency, label: `Prices in ${group.currency}` });
  return <article className={`query-group${group.mine ? " selected" : ""}`}>
    <div className="query-group-row">
    <button type="button" className="query-group-head" aria-expanded={expanded}
      aria-current={group.mine ? "true" : undefined}
      title={`${group.origin} to ${group.destination}, ${group.depart}${group.ret ? ` to ${group.ret}` : ""}${options.length ? ` · ${options.map((option) => option.label).join(" · ")}` : ""}`}
      aria-controls={expanded ? `query-${group.id}` : undefined} onClick={onToggle}>
      <span className="query-group-title">
        <span className="query-heading">
          <span className="query-route">{group.origin} <Icon name="arrow-right" /> {group.destination}</span>
          <span className="query-dates">{day(group.depart)}{group.ret ? ` – ${day(group.ret)}` : ""}</span>
          {options.length > 0 && <span className="query-options">
            {options.map((option) => <span key={option.label} className="query-option" title={option.label}
              role={option.person ? "img" : undefined} aria-label={option.person ? option.label : undefined}>
              {option.person && <Icon name="person" />}
              {option.text}
            </span>)}
          </span>}
        </span>
      </span>
    </button>
      <span className="query-group-progress" role="img" aria-label={counts.map((status) => status.label).join(". ")}>
        {counts.map(({ state, count, label }) => <span key={state} className={`queue-status-count queue-progress ${state}`}
          title={label}>
          <span>{count}</span>
          {state === "running" ? <Spinner /> : <Icon name={state === "cancelled" ? "cancel" : state} />}
        </span>)}
      </span>
      <span className="query-group-actions">
        {retryable && <ActionButton action="retry" busy={busy} pending={pending?.action === "retry" && !pending.source} onClick={() => onAct("retry")}
          label={`Retry unfinished sources for ${group.origin} to ${group.destination} on ${group.depart}`} />}
        {cancellable && <ActionButton action="cancel" busy={busy} pending={pending?.action === "cancel" && !pending.source} onClick={() => onAct("cancel")}
          label={`Cancel search ${group.origin} to ${group.destination} on ${group.depart}`} />}
      </span>
    </div>
    {expanded && <div id={`query-${group.id}`}>
      <ul className="query-sources">
      {group.sources.map((job) => <SourceRow key={job.source} job={job} busy={busy} pending={pending} onAct={onAct} />)}
      </ul>
    </div>}
  </article>;
}

export function Queue({ queue }: { queue: QueueController }) {
  const { state, groups: allGroups, busy, error, offline, priorityError, act } = queue;
  const [shown, setShown] = useState(20);
  const [inactiveShown, setInactiveShown] = useState(20);
  const [inactiveOpen, setInactiveOpen] = useState(false);
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const { active, inactive } = splitQueueGroups(allGroups, busy?.groupIds);
  const renderGroup = (group: QueryJob) => <QueryGroup key={group.id} group={group}
    expanded={toggled[group.id] ?? false} busy={busy !== null}
    pending={busy?.groupIds.includes(group.id) ? busy : undefined}
    onToggle={() => setToggled((was) => ({ ...was, [group.id]: !was[group.id] }))}
    onAct={(action, source) => void act(group.id, action, source)} />;
  return <section className="side-section queue">
    <div className="section-body">
      {offline && <p role="status" className="queue-notice">Reconnecting… Status may be out of date.</p>}
      {priorityError && <p role="alert" className="queue-notice">{priorityError}</p>}
      {error && <p role="alert" className="queue-notice">{error}</p>}
      {!state && !offline && <p className="muted" role="status">Loading queue…</p>}
      {state && !allGroups.length && <p className="muted">No searches yet. Fetch flights to get started.</p>}
      {active.slice(0, shown).map(renderGroup)}
      {active.length > shown && <button type="button" className="queue-more"
        onClick={() => setShown((n) => n + 20)}>Show more ({active.length - shown} remaining)</button>}
      {inactive.length > 0 && <div className="queue-inactive">
        <button type="button" className="queue-inactive-toggle" aria-expanded={inactiveOpen}
          aria-controls={inactiveOpen ? "inactive-searches" : undefined}
          onClick={() => setInactiveOpen((was) => !was)}>
          <Icon name={inactiveOpen ? "chevron-down" : "chevron-right"} className="caret" />
          <span>Inactive searches</span>
          <span className="section-gist">{inactive.length}</span>
        </button>
        {inactiveOpen && <div id="inactive-searches">
          {inactive.slice(0, inactiveShown).map(renderGroup)}
          {inactive.length > inactiveShown && <button type="button" className="queue-more"
            onClick={() => setInactiveShown((n) => n + 20)}>Show more ({inactive.length - inactiveShown} remaining)</button>}
        </div>}
      </div>}
    </div>
  </section>;
}

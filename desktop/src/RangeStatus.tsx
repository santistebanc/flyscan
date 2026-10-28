import { ActionButton } from "./Queue";
import { groupStatus, rangeStats } from "./queueModel";
import { QueueStatusIcon } from "./QueueStatusIcon";
import type { QueueController } from "./useQueue";
import { Icon, Spinner } from "./Icon";

/** True when every source has answered for every trip on screen. */
export function rangeComplete(queue: QueueController, trips: number) {
  const stats = rangeStats(queue.selected);
  return stats.groups === trips && stats.total > 0 && stats.done === stats.total;
}

/** The end of the search bar: the one control that contacts a source. */
export function FetchButton({ queue, trips, canSearch, fetching, onFetch }: {
  queue: QueueController; trips: number; canSearch: boolean; fetching: boolean;
  onFetch: (refresh: boolean) => void;
}) {
  const complete = rangeComplete(queue, trips);
  const unavailable = !canSearch || !queue.state || queue.offline || queue.busy !== null || trips === 0;
  return <button type="button" className="fetch-button" data-state={fetching ? "running" : undefined}
    disabled={!fetching && unavailable} aria-disabled={fetching || undefined}
    title={complete ? "Refresh all sources for the selected dates" : "Fetch flights for every selected date"}
    onClick={() => { if (!fetching && !unavailable) onFetch(complete); }}>
    {fetching ? <><Spinner /> Searching</> : complete ? <><Icon name="retry" /> Refresh</> : "Fetch"}
  </button>;
}

/** Queue progress and actions for exactly the route, dates and party on screen. */
export function RangeStatus({ queue, trips, canSearch }: {
  queue: QueueController; trips: number; canSearch: boolean;
}) {
  const stats = rangeStats(queue.selected);
  const complete = rangeComplete(queue, trips);
  const busy = queue.busy !== null;
  const pending = queue.busy?.key === "range" ? queue.busy : null;
  const unavailable = !canSearch || !queue.state || queue.offline;
  const status = groupStatus(queue.selected.flatMap((group) => group.sources));
  const state = queue.offline ? "failed" : !queue.state ? "running" : !stats.groups ? "waiting" : status.state;
  const text = queue.offline ? "Reconnecting…"
    : !queue.state ? "Loading queue…"
    : !stats.groups ? "Not fetched for these dates"
    : state === "input" ? "Verification needed"
    : state === "failed" ? "Some sources failed"
    : complete ? `${trips} of ${trips} ${trips === 1 ? "search" : "searches"} complete`
    : `${stats.completedGroups} of ${trips} ${trips === 1 ? "search" : "searches"} done`;
  const title = queue.offline ? "Reconnecting. Queue status may be out of date."
    : `${stats.done} of ${stats.total} sources done for the route, dates and party on screen. ${stats.summary}`;
  return <div className="range-status" role="group" aria-label="Queue status for selected filters">
    <span className="range-status-text" role="status" title={title}>
      <span className={`queue-progress ${state}`}>
        <QueueStatusIcon state={state} loading={!queue.offline && (!queue.state || status.loading)} />
      </span>
      {text}
    </span>
    {stats.retryable > 0 && <ActionButton action="retry" label="Retry failed or cancelled sources in the selected dates"
      pending={pending?.action === "retry"}
      busy={unavailable || busy} onClick={() => void queue.rangeAction("retry")} />}
    {stats.cancellable > 0 && <ActionButton action="cancel" label="Cancel all unfinished sources in the selected dates"
      pending={pending?.action === "cancel"}
      busy={unavailable || busy} onClick={() => void queue.rangeAction("cancel")} />}
    {queue.rangeError && <span role="alert" className="range-status-error">{queue.rangeError}</span>}
  </div>;
}

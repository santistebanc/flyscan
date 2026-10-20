import { ActionButton } from "./Queue";
import { groupStatus, rangeStats } from "./queueModel";
import { QueueStatusIcon } from "./QueueStatusIcon";
import type { QueueController } from "./useQueue";
import { Spinner } from "./Icon";

/** Queue progress and actions for exactly the route, dates and party on screen. */
export function RangeStatus({ queue, trips, canSearch, fetching, onFetch }: {
  queue: QueueController; trips: number; canSearch: boolean; fetching: boolean;
  onFetch: (refresh: boolean) => void;
}) {
  const stats = rangeStats(queue.selected);
  const complete = stats.groups === trips && stats.total > 0 && stats.done === stats.total;
  const busy = queue.busy !== null;
  const pending = queue.busy?.key === "range" ? queue.busy : null;
  const unavailable = !canSearch || !queue.state || queue.offline;
  const status = groupStatus(queue.selected.flatMap((group) => group.sources));
  const description = queue.offline ? "Reconnecting. Queue status may be out of date."
    : !queue.state ? "Loading queue"
    : !stats.groups ? `${trips} selected ${trips === 1 ? "search" : "searches"}. Not queued yet.`
    : `${stats.completedGroups} of ${trips} selected searches complete. ${stats.done} of ${stats.total} sources done. ${stats.summary}`;
  const state = queue.offline ? "failed" : !queue.state ? "running" : !stats.groups ? "waiting" : status.state;
  return <div className="status range-status">
    <div className="range-status-info" aria-label="Queue status for selected filters">
      <span className={`queue-progress ${state}`} role="img" aria-label={description} title={description}>
        <span>{stats.completedGroups}/{trips}</span>
        <QueueStatusIcon state={state} loading={!queue.offline && (!queue.state || status.loading)} />
      </span>
      {queue.rangeError && <div role="alert" className="range-status-error">{queue.rangeError}</div>}
    </div>
    <div className="range-status-actions">
      {stats.retryable > 0 && <ActionButton action="retry" label="Retry failed or cancelled sources in the selected dates"
        pending={pending?.action === "retry"}
        busy={unavailable || busy} onClick={() => void queue.rangeAction("retry")} />}
      {stats.cancellable > 0 && <ActionButton action="cancel" label="Cancel all unfinished sources in the selected dates"
        pending={pending?.action === "cancel"}
        busy={unavailable || busy} onClick={() => void queue.rangeAction("cancel")} />}
      <button type="button" className="status-go" disabled={unavailable || busy || fetching || trips === 0}
        title={complete ? "Refresh all sources for the selected dates" : "Fetch flights for every selected date"}
        onClick={() => onFetch(complete)}>
        {fetching ? <><Spinner /> Searching</> : complete ? "Refresh" : "Fetch"}
      </button>
    </div>
  </div>;
}

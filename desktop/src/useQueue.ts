/** One queue subscription shared by the global sidebar and selected-range header. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { FlyscanApi, QueueActionResult, QueueState, SearchRequest } from "./api";
import { matchesSelection } from "./queueModel";

export interface QueueMutation {
  key: string;
  action: "cancel" | "retry";
  groupIds: string[];
  source?: string;
}

export function useQueue(api: FlyscanApi | null, mine: SearchRequest | null,
  active: boolean, onChanged: () => void) {
  const [state, setState] = useState<QueueState | null>(null);
  const [busy, setBusy] = useState<QueueMutation | null>(null);
  const [error, setError] = useState("");
  const [rangeError, setRangeError] = useState("");
  const [offline, setOffline] = useState(false);
  const [priorityError, setPriorityError] = useState("");
  const [revision, setRevision] = useState(0);
  const [resolved, setResolved] = useState<{ input: SearchRequest | null; value: SearchRequest | null } | null>(null);
  const selection = useRef(mine);
  const syncing = useRef(false);
  const selectionVersion = useRef(0);
  const acting = useRef(false);
  const confirming = useRef(false);
  const mounted = useRef(false);
  const readVersion = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const readQueue = useCallback(async (current: () => boolean = () => true) => {
    if (!api) return null;
    const version = ++readVersion.current;
    try {
      const next = await api.queue();
      if (mounted.current && current() && version === readVersion.current) {
        setState(next);
        setOffline(false);
      }
      return next;
    } catch {
      if (mounted.current && current() && version === readVersion.current) setOffline(true);
      return null;
    }
  }, [api]);

  // Serialize edits so a slow place lookup cannot restore an older selection.
  useEffect(() => {
    selection.current = mine;
    selectionVersion.current++;
    const timer = window.setTimeout(async () => {
      if (!api || syncing.current) return;
      syncing.current = true;
      try {
        let version;
        do {
          version = selectionVersion.current;
          const input = selection.current;
          try {
            const answer = await api.selectQueueQuery(input);
            if (mounted.current && version === selectionVersion.current) {
              setResolved({ input, value: answer.selected });
              setPriorityError("");
            }
          } catch (exc) {
            if (mounted.current && version === selectionVersion.current) {
              setPriorityError(`Couldn’t prioritise this search. ${exc instanceof Error ? exc.message : String(exc)}`);
            }
          }
        } while (mounted.current && version !== selectionVersion.current);
        if (mounted.current) setRevision((n) => n + 1);
      } finally { syncing.current = false; }
    }, 200);
    return () => window.clearTimeout(timer);
  }, [api, mine]);

  useEffect(() => {
    if (!api) return;
    let disposed = false;
    let timer = 0;
    let polling = false;
    let refreshAgain = false;
    const poll = async () => {
      if (disposed) return;
      window.clearTimeout(timer);
      // Only the confirming read is exclusive; a slow POST must not freeze the queue.
      if (confirming.current) {
        timer = window.setTimeout(poll, 1000);
        return;
      }
      if (polling) { refreshAgain = true; return; }
      polling = true;
      const next = await readQueue(() => !disposed);
      polling = false;
      if (disposed) return;
      if (refreshAgain) {
        refreshAgain = false;
        void poll();
        return;
      }
      const moving = active || acting.current || Boolean(next && (next.scheduler.running || next.scheduler.queued));
      timer = window.setTimeout(poll, moving ? 1000 : 3000);
    };
    const resume = () => { if (document.visibilityState !== "hidden") void poll(); };
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    void poll();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [api, active, revision, readQueue]);

  const mutate = useCallback(async (pending: QueueMutation, action: () => Promise<QueueActionResult>) => {
    if (acting.current) return;
    acting.current = true;
    setBusy(pending);
    setError("");
    if (pending.key === "range") setRangeError("");
    try {
      const outcome = await action();
      const message = outcome.errors.length ? outcome.errors.map((e) => `${e.source}: ${e.error}`).join("; ")
        : !outcome.cancelled && !outcome.retried ? "These searches have already changed. Their latest status is shown below." : "";
      setError(message);
      if (pending.key === "range") setRangeError(message);
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      setError(message);
      if (pending.key === "range") setRangeError(message);
    } finally {
      // A timed out POST may have succeeded. Confirm state, never resend the action.
      // This read also invalidates any older poll still returning pre-action data.
      if (mounted.current) {
        confirming.current = true;
        await readQueue();
        confirming.current = false;
      }
      acting.current = false;
      if (mounted.current) {
        setBusy(null);
        onChanged();
      }
    }
  }, [onChanged, readQueue]);

  const act = useCallback(async (id: string, action: "cancel" | "retry", source?: string) => {
    if (api) await mutate({ key: id, action, source, groupIds: [id] }, () => api.queryJobAction(id, action, source));
  }, [api, mutate]);

  const effectiveSelection = resolved?.input === mine ? resolved.value : mine;
  const groups = (state?.query_jobs ?? []).map((group) => ({ ...group, mine: matchesSelection(group, effectiveSelection) }));
  const selected = groups.filter((g) => g.mine);
  const rangeAction = useCallback(async (action: "cancel" | "retry") => {
    // Capture the actual filters at the click. A later edit or another tab's
    // foreground selection must never widen this action to unrelated jobs.
    if (api && mine) await mutate({ key: "range", action, groupIds: selected.map((group) => group.id) },
      () => api.queueRangeAction(mine, action));
  }, [api, mine, mutate, selected]);

  return { state, groups, selected, busy, error, rangeError, offline, priorityError,
    act, rangeAction, refresh: () => setRevision((n) => n + 1) };
}

export type QueueController = ReturnType<typeof useQueue>;

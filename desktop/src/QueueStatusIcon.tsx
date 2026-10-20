import type { groupStatus } from "./queueModel";
import { Icon, Spinner } from "./Icon";

/** Shared visual language for source, search and selected-range progress. */
export function QueueStatusIcon({ state, loading }: Pick<ReturnType<typeof groupStatus>, "state" | "loading">) {
  return <>
    {loading && <Spinner />}
    {state !== "running" && <Icon name={state} />}
  </>;
}

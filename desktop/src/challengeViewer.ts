import type { PendingChallenge } from "./api";

/**
 * Whether to embed the server's display under a source's row.
 *
 * Only a browser tab needs it: the desktop shell opens the check in its own
 * webview. And only once the server has opened the check (`solving`) and
 * been told where a person can watch it.
 */
export function showsViewerPanel({ isDesktop, viewerUrl, challenge }: {
  isDesktop: boolean;
  viewerUrl?: string | null;
  challenge: Pick<PendingChallenge, "solving">;
}): boolean {
  return !isDesktop && typeof viewerUrl === "string" && viewerUrl !== "" && Boolean(challenge.solving);
}

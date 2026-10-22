import type { PendingChallenge } from "./api";

/** Embed the challenge viewer only on the web, for a solving source, when the server gave an address. */
export function showsViewerPanel({ isDesktop, viewerUrl, challenge }: {
  isDesktop: boolean;
  viewerUrl?: string | null;
  challenge: Pick<PendingChallenge, "solving">;
}): boolean {
  return !isDesktop && typeof viewerUrl === "string" && viewerUrl !== "" && Boolean(challenge.solving);
}

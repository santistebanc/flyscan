import type { PendingChallenge } from "./api";

/** Embed the challenge viewer only on the web, for a solving source, when the server gave an address. */
export function showsViewerPanel({ isDesktop, viewerUrl, challenge }: {
  isDesktop: boolean;
  viewerUrl?: string | null;
  challenge: Pick<PendingChallenge, "solving">;
}): boolean {
  return !isDesktop && typeof viewerUrl === "string" && viewerUrl !== "" && Boolean(challenge.solving);
}

/** noVNC's full page carries a control bar; its lite page is just the screen, scaled to fit. Other viewers are used as given. */
export function embedViewerUrl(viewerUrl: string): string {
  try {
    const url = new URL(viewerUrl);
    if (!url.pathname.endsWith("/vnc.html")) return viewerUrl;
    url.pathname = url.pathname.replace(/vnc\.html$/, "vnc_lite.html");
    url.search = "?scale=true";
    return url.toString();
  } catch { return viewerUrl; }
}

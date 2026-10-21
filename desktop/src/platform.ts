/**
 * The three things that need the desktop shell — and what to do without it.
 *
 * The UI is the same code in both places. Running it as a plain web page buys
 * live reload and lets a browser drive it, which is worth a lot while the UI
 * is changing quickly: a Rust change otherwise costs a full stop-rebuild-
 * restart, because the running app holds its own sidecar binary and the build
 * script cannot delete it.
 *
 * Only the challenge handshake is genuinely desktop-only. That is the whole
 * reason this is a desktop app: a source's security check grants cookies, and
 * cookies earned in a normal browser tab stay in that browser, where the
 * scraper cannot reach them. Everything else degrades cleanly.
 */

import { invoke } from "@tauri-apps/api/core";

export interface ChallengeOutcome {
  solved: boolean;
  cookies: { name: string; value: string }[];
  landed_on: string;
}

/** True when running inside the Tauri shell rather than a browser tab. */
export const isDesktop = "__TAURI_INTERNALS__" in window;

/**
 * Where the sidecar is listening.
 *
 * The shell reserves a free port at launch and is the only one who knows it.
 * In a browser there is no shell, so the port comes from `?api=…`, else the
 * `VITE_API_BASE` env var, else a default. The default depends on who served
 * the page: the Vite dev server only has the UI, so the API is on the
 * documented port, but a built bundle served by `flight-scraper serve` sits
 * beside the API it should talk to, on whatever port that happens to be.
 */
export async function apiBase(): Promise<string> {
  if (isDesktop) return invoke<string>("api_base");
  const fromQuery = new URLSearchParams(location.search).get("api");
  return (
    fromQuery ??
    (import.meta.env.VITE_API_BASE as string | undefined) ??
    (import.meta.env.DEV ? "http://127.0.0.1:5111" : location.origin)
  );
}

/** The session secret is available only through the main desktop window's IPC. */
export async function apiConnection(): Promise<{ base: string; apiKey?: string }> {
  const base = await apiBase();
  return { base, apiKey: isDesktop ? await invoke<string>("api_key") : undefined };
}

/**
 * Send a booking link to the user's real browser.
 *
 * In a browser tab that is just `window.open`. In the shell it has to be a
 * command, because a webview has no handler for `target="_blank"` — the link
 * silently does nothing.
 */
export async function openExternal(url: string): Promise<void> {
  if (isDesktop) {
    await invoke("open_external", { url });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Hold a source's security check and hand back the cookies it grants.
 *
 * Desktop only, and not for want of trying: a browser cannot read cookies from
 * another origin, so opening the check in a tab would let the person solve it
 * and still leave the scraper blocked. Say so plainly rather than appearing to
 * work.
 */
export async function openChallenge(url: string): Promise<ChallengeOutcome> {
  if (isDesktop) return invoke<ChallengeOutcome>("open_challenge", { url });
  throw new Error(
    "clearing a security check needs the desktop app — a browser cannot hand " +
      "back the cookies it grants",
  );
}

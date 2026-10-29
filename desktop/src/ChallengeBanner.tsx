import { useRef, useState } from "react";
import type { FlightScraperApi, PendingChallenge } from "./api";
import { isDesktop, openChallenge, openExternal } from "./platform";
import { Icon, Spinner } from "./Icon";
import { sourceLabel } from "./queueModel";

/** Each source owns its verification request; other sources remain available. */
export function ChallengeBanner({ api, pending, canSolveHere, viewerUrl = null, onCleared }: {
  api: FlightScraperApi | null;
  pending: PendingChallenge[];
  canSolveHere: boolean;
  /** Where the server's display is streamed (the preview), so a check it opens can be solved from anywhere. */
  viewerUrl?: string | null;
  onCleared: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(new Set<string>());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const opening = useRef(new Set<string>());
  const available = Boolean(api && (isDesktop || canSolveHere));

  const verify = async (challenge: PendingChallenge) => {
    // Guard the handler too: two clicks can arrive before the disabled state paints.
    if (!api || !available || opening.current.has(challenge.source) || challenge.solving) return;
    opening.current.add(challenge.source);
    setBusy((was) => new Set(was).add(challenge.source));
    setErrors((was) => ({ ...was, [challenge.source]: "" }));
    try {
      if (isDesktop) {
        const outcome = await openChallenge(challenge.url);
        if (!outcome.solved) throw new Error("Verification wasn’t completed. Try again.");
        await api.submitChallengeCookies(challenge.source, outcome.cookies, outcome.landed_on);
      } else {
        // Before any await: a tab opened later than the click is a popup, and phones block those.
        if (viewerUrl) void openExternal(viewerUrl);
        await api.solveChallenge(challenge.source);
      }
    } catch (error) {
      setErrors((was) => ({ ...was, [challenge.source]: error instanceof Error ? error.message : String(error) }));
    } finally {
      // Check even after a failed response: the server may already have accepted it.
      try { await onCleared(); }
      catch {
        setErrors((was) => ({ ...was, [challenge.source]: "Couldn’t refresh verification status. Try again." }));
      }
      opening.current.delete(challenge.source);
      setBusy((was) => { const next = new Set(was); next.delete(challenge.source); return next; });
    }
  };

  if (!pending.length) return null;
  return <div className="challenges" role="group" aria-label="Verification requests">
    {pending.map((challenge) => {
      const name = sourceLabel(challenge.source);
      const working = busy.has(challenge.source) || Boolean(challenge.solving);
      const error = errors[challenge.source] || challenge.error;
      const streamed = !isDesktop && Boolean(viewerUrl);
      // A streamed check is open on the server already; the button just shows it again.
      const watching = streamed && working;
      const title = watching ? "Open the stream to complete verification"
        : working ? "Complete verification in the open window"
        : available ? `Verify ${name}` : "Open the desktop app to verify";
      return <div key={challenge.source} className="challenge">
        <span className="challenge-source"><b>{name}</b> wants to check you’re human.</span>
        <span className="challenge-note">{available && streamed
          ? "It opens in a new tab streaming the server’s browser, where the check is already loading. Solve it there and the search continues. Other sources keep running."
          : available
          ? "It opens in a window this app owns. Solve it there and the search continues. Other sources keep running."
          : "Open the desktop app to verify: a browser tab can’t hand the clearance back to the search."}</span>
        <div className="challenge-row">
          {watching
            ? <button type="button" aria-label={`Open the stream for ${name}`} title={title}
              onClick={() => void openExternal(viewerUrl!)}>
              <Icon name="input" />Open stream
            </button>
            : <button type="button" disabled={!available || working}
              aria-label={`${working ? "Verifying" : "Verify"} ${name}`}
              aria-busy={working || undefined} title={title} onClick={() => verify(challenge)}>
              {working ? <Spinner /> : <Icon name="input" />}
              {working ? "Verifying" : "Verify"}
            </button>}
          {working && <span className="challenge-hint">{watching
            ? "Solve it in the stream; this clears by itself"
            : "Complete it in the open window"}</span>}
        </div>
        {!working && error && <div className="challenge-error" role="alert">{error}</div>}
      </div>;
    })}
  </div>;
}

import { useRef, useState } from "react";
import type { FlightScraperApi, PendingChallenge } from "./api";
import { isDesktop, openChallenge } from "./platform";
import { Icon, Spinner } from "./Icon";
import { sourceLabel } from "./queueModel";
import { showsViewerPanel } from "./challengeViewer";

/** Each source owns its verification request; other sources remain available. */
export function ChallengeBanner({ api, pending, canSolveHere, viewerUrl, onCleared }: {
  api: FlightScraperApi | null;
  pending: PendingChallenge[];
  canSolveHere: boolean;
  /** Where the server's display can be watched; lets a browser tab show the check inline. */
  viewerUrl?: string | null;
  onCleared: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(new Set<string>());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [collapsed, setCollapsed] = useState(new Set<string>());
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

  const toggleViewer = (source: string) => setCollapsed((was) => {
    const next = new Set(was);
    if (!next.delete(source)) next.add(source);
    return next;
  });

  if (!pending.length) return null;
  return <div className="challenges" role="group" aria-label="Verification requests">
    {pending.map((challenge) => {
      const name = sourceLabel(challenge.source);
      const working = busy.has(challenge.source) || Boolean(challenge.solving);
      const error = errors[challenge.source] || challenge.error;
      const title = working ? "Complete verification in the open window"
        : available ? `Verify ${name}` : "Open the desktop app to verify";
      const viewing = showsViewerPanel({ isDesktop, viewerUrl, challenge });
      const expanded = !collapsed.has(challenge.source);
      return <div key={challenge.source} className="challenge">
        <div className="challenge-row">
          <span className="challenge-source">{name}</span>
          <button type="button" disabled={!available || working}
            aria-label={`${working ? "Verifying" : "Verify"} ${name}`}
            aria-busy={working || undefined} title={title} onClick={() => verify(challenge)}>
            {working ? <Spinner /> : <Icon name="input" />}
            {working ? "Verifying" : "Verify"}
          </button>
        </div>
        {viewing && <div className="challenge-viewer">
          <div className="challenge-viewer-bar">
            <button type="button" aria-expanded={expanded} aria-label={`${expanded ? "Collapse" : "Expand"} ${name} verification view`}
              onClick={() => toggleViewer(challenge.source)}>{expanded ? "Hide view" : "Show view"}</button>
            <a href={viewerUrl!} target="_blank" rel="noopener noreferrer">Open in a new tab</a>
          </div>
          {expanded && <iframe className="challenge-viewer-frame" src={viewerUrl!} title={`${name} verification`} />}
        </div>}
        {!working && error && <div className="challenge-error" role="alert">{error}</div>}
      </div>;
    })}
  </div>;
}

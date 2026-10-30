import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "./Icon";
import { isDesktop } from "./platform";
import { desktopUpdates } from "./desktopUpdates";
import { UPDATE_INTERVAL, type UpdateManager, type UpdateState } from "./updates";

export function UpdatePanel({ state, manager, busy, onClose }: {
  state: UpdateState; manager: UpdateManager; busy: boolean; onClose: () => void;
}) {
  const working = ["checking", "downloading", "installing"].includes(state.status);
  const status = state.status === "checking" ? "Checking for updates…"
    : state.status === "current" ? "You have the latest version."
    : state.status === "downloading" ? "Downloading and verifying update…"
    : state.status === "ready" ? `Version ${state.version} is ready to install.`
    : state.status === "available" ? `Version ${state.version} is available.`
    : state.status === "installing" ? "Installing update. The app will restart…"
    : "Checks automatically at startup and every six hours.";
  return <>
    <div className="update-panel-heading">
      <div><h2 id="app-updates-title">App updates</h2>
        <p className="muted">Flyscan{state.currentVersion && ` ${state.currentVersion}`}</p></div>
      <button type="button" className="update-close" aria-label="Close app updates"
        disabled={state.status === "installing"} onClick={onClose}><Icon name="cancel" /></button>
    </div>
    <p role="status" aria-live="polite">{status}</p>
    {state.status === "downloading" && <div className="update-download">
      <progress aria-label="Update download" max={state.total || 1}
        value={state.total ? Math.min(state.downloaded, state.total) : undefined} />
      <span>{(state.downloaded / 1048576).toFixed(1)} MB{state.total ? ` of ${(state.total / 1048576).toFixed(1)} MB` : ""}</span>
    </div>}
    {state.error && <p className="update-error" role="alert">{state.error}</p>}
    {state.notes && <details className="update-notes"><summary>What’s new</summary><p>{state.notes}</p></details>}
    <PrivateUpdateAccess manager={manager} />
    <div className="update-preferences">
      <label><input type="checkbox" checked={state.preferences.autoDownload}
        onChange={(event) => manager.setPreferences({ autoDownload: event.target.checked })} />
        Download updates automatically</label>
      <label><input type="checkbox" checked={state.preferences.installOnStartup}
        disabled={!state.preferences.autoDownload}
        onChange={(event) => manager.setPreferences({ installOnStartup: event.target.checked })} />
        Install updates at startup</label>
      <label><input type="checkbox" checked={state.preferences.autoInstall}
        disabled={!state.preferences.autoDownload}
        onChange={event => manager.setPreferences({ autoInstall: event.target.checked })} />
        Install updates automatically when idle</label>
      <p className="muted">Installation waits until no searches or verification windows are active.</p>
    </div>
    <div className="update-actions">
      {state.status === "ready" ? <button type="button" disabled={busy}
        onClick={() => void manager.install()}>Restart and update</button>
        : state.status === "available" ? <button type="button" onClick={() => void manager.download()}>Download update</button>
        : <button type="button" disabled={working} onClick={() => void manager.check()}>Check now</button>}
      {state.status === "ready" && busy && <span className="muted">Waiting for searches to finish</span>}
    </div>
  </>;
}

export function UpdateControls({ busy, manager = desktopUpdates }: { busy: boolean; manager?: UpdateManager }) {
  const state = useSyncExternalStore(manager.subscribe, manager.snapshot, manager.snapshot);
  const dialog = useRef<HTMLDialogElement>(null);
  const activity = useRef(busy);
  activity.current = busy;
  useEffect(() => {
    if (!isDesktop) return;
    manager.setActivityGuard(() => !activity.current);
    void manager.check(true);
    const timer = window.setInterval(() => void manager.check(), UPDATE_INTERVAL);
    const online = () => { if (Date.now() - (manager.snapshot().checkedAt ?? 0) >= UPDATE_INTERVAL) void manager.check(); };
    window.addEventListener("online", online);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", online);
      manager.setActivityGuard(() => false);
    };
  }, [manager]);
  useEffect(() => {
    if (state.status === "installing" && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [state.status]);
  useEffect(() => {
    if (isDesktop && state.status === "ready" && state.preferences.autoInstall && !busy) void manager.install();
  }, [state.status, state.preferences.autoInstall, busy, manager]);
  if (!isDesktop) return null;
  // Quiet until there is something to install; then it asks for attention.
  const pill = state.status === "ready" ? "Update ready"
    : state.status === "available" || state.status === "downloading" ? "Update available" : "";
  return <>
    {pill ? <button type="button" className="update-pill" aria-haspopup="dialog"
      onClick={() => dialog.current?.showModal()}><span aria-hidden="true" />{pill}</button>
      : <button type="button" className="queue-icon-button update-trigger" aria-label="App updates"
        aria-haspopup="dialog" title="App updates" onClick={() => dialog.current?.showModal()}>
        <Icon name="retry" />
      </button>}
    <dialog ref={dialog} className="update-panel" aria-labelledby="app-updates-title"
      aria-busy={state.status === "installing" || undefined}
      onKeyDown={(event) => { if (event.key === "Escape") event.stopPropagation(); }}
      onCancel={(event) => { if (state.status === "installing") event.preventDefault(); }}
      onClick={(event) => { if (event.target === event.currentTarget && state.status !== "installing") dialog.current?.close(); }}>
      <div><UpdatePanel state={state} manager={manager} busy={busy} onClose={() => dialog.current?.close()} /></div>
    </dialog>
  </>;
}

function PrivateUpdateAccess({ manager }: { manager: UpdateManager }) {
  const [privateEdition, setPrivate] = useState(false);
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (isDesktop) void invoke<boolean>("update_edition").then(setPrivate).catch(() => {}); }, []);
  if (!privateEdition) return null;
  return <form onSubmit={async event => {
    event.preventDefault(); setSaving(true); setStatus("");
    try {
      await invoke("save_update_password", { password });
      setPassword("");
      await manager.check(true);
      setStatus(manager.snapshot().status === "error" ? "Could not connect. Check the password and try again." : "Private updates connected. Password saved securely for this Windows user.");
    } catch { setStatus("Could not save update access. Try again."); }
    finally { setSaving(false); }
  }}>
    <label htmlFor="private-update-password">Private update password</label>
    <div className="update-actions"><input id="private-update-password" type="password" required maxLength={512}
      autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} />
      <button disabled={saving || !password} type="submit">{saving ? "Connecting?" : "Connect updates"}</button></div>
    <p className="muted" role="status">{status || "Enter once to enable automatic private updates. The app works offline."}</p>
  </form>;
}

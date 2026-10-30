/** One update lifecycle per app, independent of React mounts and queue polling. */
export const UPDATE_INTERVAL = 6 * 60 * 60 * 1000;
export const UPDATE_PREFERENCES_KEY = "flyscan.updates";
export interface UpdatePreferences { autoDownload: boolean; installOnStartup: boolean }
export type UpdateStatus = "idle" | "checking" | "current" | "available" | "downloading" | "ready" | "installing" | "error";
export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  version: string;
  notes: string;
  downloaded: number;
  total?: number;
  error: string;
  checkedAt?: number;
  preferences: UpdatePreferences;
}
export type DownloadEvent = { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } } | { event: "Finished" };
export interface UpdateArtifact {
  version: string;
  body?: string;
  download(onEvent: (event: DownloadEvent) => void, options: { timeout: number }): Promise<void>;
  install(options: { restartAfterInstall: boolean }): Promise<void>;
  close(): Promise<void>;
}
export interface UpdateDependencies {
  check(): Promise<UpdateArtifact | null>;
  version(): Promise<string>;
  beforeInstall(): Promise<void>;
  savePreferences(preferences: UpdatePreferences): void;
  now(): number;
}
export function updatePreferences(raw: unknown): UpdatePreferences {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return { autoDownload: value.autoDownload !== false,
    installOnStartup: value.autoDownload !== false && value.installOnStartup === true };
}

export class UpdateManager {
  private artifact: UpdateArtifact | null = null;
  private working = false;
  private activityGuard = () => false;
  private listeners = new Set<() => void>();
  private state: UpdateState;
  constructor(private dependencies: UpdateDependencies, preferences?: unknown) {
    this.state = { status: "idle", currentVersion: "", version: "", notes: "", downloaded: 0,
      error: "", preferences: updatePreferences(preferences) };
  }
  snapshot = () => this.state;
  setActivityGuard(guard: () => boolean) { this.activityGuard = guard; }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private change(patch: Partial<UpdateState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  setPreferences(patch: Partial<UpdatePreferences>) {
    const preferences = updatePreferences({ ...this.state.preferences, ...patch });
    this.dependencies.savePreferences(preferences);
    this.change({ preferences });
  }
  async check(startup = false) {
    if (this.working || this.state.status === "ready" || this.state.status === "installing") return;
    this.working = true;
    this.change({ status: "checking", error: "" });
    let download = false;
    try {
      const currentVersion = await this.dependencies.version();
      this.change({ currentVersion });
      const next = await this.dependencies.check();
      const previous = this.artifact;
      this.artifact = next;
      if (previous && previous !== next) await previous.close().catch(() => {});
      this.change({ currentVersion, checkedAt: this.dependencies.now(), version: next?.version ?? "",
        notes: next?.body ?? "", status: next ? "available" : "current", downloaded: 0, total: undefined });
      download = Boolean(next && this.state.preferences.autoDownload);
    } catch {
      this.change({ status: "error", error: "Could not check for updates. Check your connection and try again." });
    } finally { this.working = false; }
    if (download) await this.download(startup && this.state.preferences.installOnStartup);
  }
  async download(installAfter = false) {
    if (this.working || !this.artifact || !["available", "error"].includes(this.state.status)) return;
    this.working = true;
    this.change({ status: "downloading", error: "", downloaded: 0, total: undefined });
    let ready = false;
    try {
      await this.artifact.download((event) => {
        if (event.event === "Started") this.change({ total: event.data.contentLength });
        if (event.event === "Progress") this.change({ downloaded: this.state.downloaded + event.data.chunkLength });
      }, { timeout: 120_000 });
      // The native updater verifies the signature before this promise resolves.
      ready = true;
      this.change({ status: "ready" });
    } catch {
      this.change({ status: "available", error: "Could not download or verify the update. Try again." });
    } finally { this.working = false; }
    if (ready && installAfter && this.state.preferences.installOnStartup) await this.install();
  }
  async install() {
    if (this.working || !this.artifact || this.state.status !== "ready") return;
    this.working = true;
    this.change({ status: "installing", error: "" });
    try {
      if (!this.activityGuard()) throw new Error("Finish or cancel active searches before updating.");
      await this.dependencies.beforeInstall();
      await this.artifact.install({ restartAfterInstall: true });
    } catch (error) {
      this.change({ status: "ready", error: error instanceof Error ? error.message : "Could not install the update. Try again." });
    } finally { this.working = false; }
  }
}

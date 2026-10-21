import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import { FlightScraperApi } from "./api";
import { apiConnection } from "./platform";
import { UpdateManager, UPDATE_PREFERENCES_KEY } from "./updates";

let stored: unknown;
try { stored = JSON.parse(localStorage.getItem(UPDATE_PREFERENCES_KEY) ?? "null"); } catch { stored = null; }

export const desktopUpdates = new UpdateManager({
  check: () => check({ timeout: 15_000 }),
  version: getVersion,
  now: Date.now,
  savePreferences(value) { try { localStorage.setItem(UPDATE_PREFERENCES_KEY, JSON.stringify(value)); } catch { /* Session preferences still work. */ } },
  async beforeInstall() {
    const { base, apiKey } = await apiConnection();
    const queue = await new FlightScraperApi(base, apiKey).queue();
    if (queue.scheduler.running || queue.scheduler.queued) {
      throw new Error("Finish or cancel active searches before updating.");
    }
    await invoke("validate_update_restart");
  },
}, stored);

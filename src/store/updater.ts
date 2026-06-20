// Auto-update state machine. Thin wrapper around the official, signature-verified
// Tauri updater (`@tauri-apps/plugin-updater`): we never download/replace the
// binary ourselves — the plugin verifies the cryptographic signature (pubkey in
// tauri.conf.json) before installing, then `@tauri-apps/plugin-process` relaunches.
//
// Checks run on launch and every 2h while the app is open (see startUpdaterAutoCheck),
// plus on demand from the Settings "Vérifier les mises à jour" button.
import { create } from "zustand";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdaterStatus =
  | "idle" // nothing checked yet
  | "checking" // querying the release manifest
  | "available" // a newer signed version exists, not downloaded yet
  | "downloading" // fetching the artifact
  | "installing" // verified + applying, about to relaunch
  | "uptodate" // checked, already on the latest
  | "error";

export interface AvailableUpdate {
  version: string;
  currentVersion: string;
  date?: string;
  notes?: string;
}

interface UpdaterState {
  status: UpdaterStatus;
  update: AvailableUpdate | null;
  /** Download progress, bytes. `total` is null until the server reports a length. */
  progress: { downloaded: number; total: number | null } | null;
  error: string | null;
  lastCheckedAt: number | null;
  /** Query the manifest. `silent` (auto checks) never surfaces errors — just logs. */
  check: (opts?: { silent?: boolean }) => Promise<void>;
  /** Download + verify + install the pending update, then relaunch onto it. */
  install: () => Promise<void>;
}

// The Update handle (a class instance with download/install methods) is not React
// state — it isn't serialisable and we only ever act on the latest one.
let pending: Update | null = null;

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

// The updater only exists inside the Tauri webview; in a plain browser (or the
// mock IPC dev server) we no-op rather than throw.
function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export const useUpdater = create<UpdaterState>((set, get) => ({
  status: "idle",
  update: null,
  progress: null,
  error: null,
  lastCheckedAt: null,

  check: async (opts) => {
    const silent = opts?.silent ?? false;
    const busy = get().status;
    if (busy === "checking" || busy === "downloading" || busy === "installing") return;
    if (!inTauri()) return;

    set({ status: "checking", ...(silent ? {} : { error: null }) });
    try {
      const found = await check();
      set({ lastCheckedAt: Date.now() });
      if (found) {
        pending = found;
        set({
          status: "available",
          error: null,
          update: {
            version: found.version,
            currentVersion: found.currentVersion,
            date: found.date ?? undefined,
            notes: found.body ?? undefined,
          },
        });
      } else {
        pending = null;
        set({ status: "uptodate", update: null });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("update check failed:", msg);
      // Auto checks must never nag: keep the prior state, just log.
      if (!silent) set({ status: "error", error: msg });
      else set({ status: get().update ? "available" : "idle" });
    }
  },

  install: async () => {
    if (!pending) return;
    set({ status: "downloading", progress: { downloaded: 0, total: null }, error: null });
    try {
      let downloaded = 0;
      let total: number | null = null;
      await pending.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? null;
            set({ progress: { downloaded: 0, total } });
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            set({ progress: { downloaded, total } });
            break;
          case "Finished":
            set({ status: "installing" });
            break;
        }
      });
      // Verified, installed — restart onto the new version. The plugin has already
      // rejected anything with a bad/absent signature before reaching here.
      await relaunch();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("update install failed:", msg);
      set({ status: "error", error: msg });
    }
  },
}));

// Kick the periodic check loop: once now, then every 2h. Idempotent — safe to
// call from a React effect that may run twice (StrictMode).
let autoStarted = false;
export function startUpdaterAutoCheck(): void {
  if (autoStarted || !inTauri()) return;
  autoStarted = true;
  const run = () => void useUpdater.getState().check({ silent: true });
  run();
  setInterval(run, TWO_HOURS_MS);
}

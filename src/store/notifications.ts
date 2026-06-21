// User preferences for agent notifications. Three independently-toggleable
// channels fired when a session finishes a turn OR needs the user's attention
// (permission / question). The dispatch logic lives in `src/notifications/`; this
// store only holds the persisted on/off prefs.
//
// Persisted to localStorage (same lightweight pattern as commandsStore) rather
// than the Rust core: these are pure UI prefs, not domain data, so they don't
// belong in the SQLite metadata store.
import { create } from "zustand";

const STORAGE_KEY = "tosse:notifications";

export interface NotificationPrefs {
  /** OS banner / Notification Center entry (tauri-plugin-notification). */
  systemNotification: boolean;
  /** A short synthesized chime (Web Audio — no asset, see notifications/sound.ts). */
  sound: boolean;
  /** Bounce the Dock icon / flash the taskbar (request_user_attention command). */
  dockBounce: boolean;
}

// Opt-out by default: every channel on. The user silences what they don't want
// from the Settings → Notifications section.
const DEFAULTS: NotificationPrefs = {
  systemNotification: true,
  sound: true,
  dockBounce: true,
};

function load(): NotificationPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    // Merge over defaults so a newly-added channel defaults to on for users who
    // already have a stored (older, smaller) prefs object.
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<NotificationPrefs>) };
  } catch {
    return DEFAULTS;
  }
}

function save(prefs: NotificationPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* quota / disabled storage — best-effort, ignore */
  }
}

interface NotificationsState extends NotificationPrefs {
  /** Patch one or more prefs and persist. */
  set: (patch: Partial<NotificationPrefs>) => void;
}

export const useNotifications = create<NotificationsState>((set) => ({
  ...load(),
  set: (patch) =>
    set((s) => {
      const next: NotificationPrefs = {
        systemNotification: patch.systemNotification ?? s.systemNotification,
        sound: patch.sound ?? s.sound,
        dockBounce: patch.dockBounce ?? s.dockBounce,
      };
      save(next);
      return next;
    }),
}));

// Agent notification dispatcher. Fires when a session finishes a turn ("done")
// or starts waiting on the user ("attention"), routed from the global session
// event listener (see ipc/useGlobalSessionEvents.ts).
//
// Three independently-toggleable channels (Settings → Notifications): an OS
// banner, a synthesized sound, and a Dock bounce. Each respects its pref and
// fails loudly to the console (never silently) but never throws into the caller.
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { commands } from "../ipc/client";
import { useNotifications } from "../store/notifications";
import { playChime, type ChimeKind } from "./sound";

/** The plugins/commands only exist inside the Tauri webview; no-op elsewhere. */
function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// Cached OS permission grant, primed once at startup by `initNotifications`.
let osGranted = false;

// Conversations the user just interrupted. Interrupting ends the current turn,
// which the core reports as busy→false — indistinguishable from a normal
// completion at the state level. We record the interrupt here and swallow the
// single "done" that follows, so stopping an agent doesn't ping the user about
// work they halted themselves. Timestamped so a flag that's never consumed (no
// result followed) goes stale instead of muting a genuine later completion.
const interruptedAt = new Map<string, number>();
const INTERRUPT_WINDOW_MS = 15_000;

/** Record that the user interrupted `convId`'s current turn. */
export function noteInterrupt(convId: string): void {
  interruptedAt.set(convId, Date.now());
}

/** Whether `convId` was interrupted within the window; consumes the flag. */
function consumeInterrupt(convId: string): boolean {
  const ts = interruptedAt.get(convId);
  if (ts === undefined) return false;
  interruptedAt.delete(convId);
  return Date.now() - ts < INTERRUPT_WINDOW_MS;
}

/**
 * Ask the OS for notification permission once at launch, so the first real
 * notification doesn't race a permission prompt. Best-effort: a denial just
 * means the system channel stays silent (sound/dock still work).
 */
export async function initNotifications(): Promise<void> {
  if (!inTauri()) return;
  try {
    osGranted = await isPermissionGranted();
    if (!osGranted) osGranted = (await requestPermission()) === "granted";
  } catch (e) {
    console.error("notification permission init failed:", e);
  }
}

export interface AgentNotification {
  kind: ChimeKind; // "done" | "attention"
  /** Stable conversation id, to compare against the active selection. */
  convId: string;
  /** Conversation name, shown in the banner. */
  title: string;
  /** Repo basename, appended for context (null if unknown). */
  repoName: string | null;
  /** The currently-selected conversation id (for the focus-suppression check). */
  activeId: string | null;
}

/**
 * Fire the enabled notification channels for an agent event — unless the user is
 * already watching this exact conversation (window focused AND it's the active
 * one), in which case there's nothing to notify them about.
 */
export function dispatchAgentNotification(ev: AgentNotification): void {
  // A user-initiated interrupt ends the turn just like a normal completion;
  // consume the flag and skip the "done" so a self-halted agent stays quiet.
  if (ev.kind === "done" && consumeInterrupt(ev.convId)) return;

  const watching =
    ev.convId === ev.activeId && typeof document !== "undefined" && document.hasFocus();
  if (watching) return;

  const prefs = useNotifications.getState();

  if (prefs.sound) {
    try {
      playChime(ev.kind);
    } catch (e) {
      console.error("notification sound failed:", e);
    }
  }

  if (prefs.systemNotification) sendOsNotification(ev);

  if (prefs.dockBounce && inTauri()) {
    // Critical (bounces until focused) when input is needed; informational
    // (one bounce) when a turn merely finished.
    void commands
      .requestUserAttention(ev.kind === "attention")
      .then((r) => {
        if (r.status !== "ok") console.error("dock bounce failed:", r.error);
      })
      .catch((e) => console.error("dock bounce threw:", e));
  }
}

function sendOsNotification(ev: AgentNotification): void {
  if (!inTauri()) return;
  const where = ev.repoName ? ` · ${ev.repoName}` : "";
  const title = ev.kind === "attention" ? "Action requise" : "Agent terminé";
  const body =
    ev.kind === "attention"
      ? `${ev.title}${where} a besoin de ton attention.`
      : `${ev.title}${where} a terminé.`;

  const fire = () => {
    try {
      sendNotification({ title, body });
    } catch (e) {
      console.error("notification send failed:", e);
    }
  };

  if (osGranted) {
    fire();
    return;
  }
  // Not granted yet (init denied/raced): try once more, then send if allowed.
  void (async () => {
    try {
      osGranted = (await isPermissionGranted()) || (await requestPermission()) === "granted";
      if (osGranted) fire();
    } catch (e) {
      console.error("notification permission re-check failed:", e);
    }
  })();
}

/** Play just the chime — used by the Settings "Tester le son" button. */
export function testSound(kind: ChimeKind = "done"): void {
  try {
    playChime(kind);
  } catch (e) {
    console.error("notification sound failed:", e);
  }
}

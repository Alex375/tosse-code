// Live Remote Control ("bridge") state per conversation. The bridge is the native
// Claude Code `/remote-control`: it mirrors a local session onto claude.ai/code + the
// Claude mobile app, so it can be viewed and driven from another device. Messages
// typed on the phone/web arrive INLINE on the session's normal stream, so they render
// automatically — this store only tracks the on/off + the session URL, so the composer
// chip can show whether the bridge is active and offer "open in browser".
//
// LIVE-only, in memory: the bridge lives exactly as long as the `claude` process, so
// there is nothing to persist (a re-spawn re-enables it). Keyed by the STABLE
// conversation id (like every other per-conversation UI slice), fed by the
// `set_remote_control` ack and the async `SessionRemoteControlEvent`. Cleared when the
// session dies (the `ended` state event, in useGlobalSessionEvents) AND on every
// user-initiated teardown that bypasses `ended` — stop / remove / removeRepo / wipe
// (wired in conversationsStore) — so the chip never shows a stale "connected" over a
// dead or gone session.

import { create } from "zustand";
import type { RemoteControlState } from "../ipc/client";

/** The bridge status, narrowed from the loosely-typed contract `string`. */
export type RemoteControlStatus = "disconnected" | "connecting" | "connected" | "error";

interface RemoteControlStore {
  /** convId → live bridge state. Absent = never enabled (treated as disconnected). */
  byConv: Record<string, RemoteControlState>;
  set: (convId: string, state: RemoteControlState) => void;
  clear: (convId: string) => void;
  /** Drop every conversation's bridge state (wipe-all). */
  clearAll: () => void;
}

export const useRemoteControlStore = create<RemoteControlStore>((set) => ({
  byConv: {},
  set: (convId, state) =>
    set((s) => ({ byConv: { ...s.byConv, [convId]: state } })),
  clear: (convId) =>
    set((s) => {
      if (!(convId in s.byConv)) return s;
      const next = { ...s.byConv };
      delete next[convId];
      return { byConv: next };
    }),
  clearAll: () => set({ byConv: {} }),
}));

/** Reactive Remote Control state for one conversation (`undefined` until enabled). */
export function useRemoteControl(convId: string): RemoteControlState | undefined {
  return useRemoteControlStore((s) => s.byConv[convId]);
}

/** Narrowed status for a conversation; `"disconnected"` when never enabled. */
export function statusOf(state: RemoteControlState | undefined): RemoteControlStatus {
  return (state?.status as RemoteControlStatus) ?? "disconnected";
}

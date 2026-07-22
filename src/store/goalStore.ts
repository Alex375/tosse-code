// Active `/goal` per conversation. `/goal <condition>` is Claude Code's native goal feature:
// Claude keeps working across turns until a small fast model confirms the condition holds, then
// auto-clears. We only DISPLAY it — a target icon on the Flight Deck card and a chip (+ clear
// button) in the composer bar — so the user can see whether a conversation is driving toward a goal.
//
// Read from the on-disk transcript, NOT the live stream: the CLI records goal state as
// `attachment` lines of `type:"goal_status"` that are DISK-ONLY (never emitted on stdout), so
// there is nothing to intercept live. We fetch it from the Rust `load_session_goal` tail-scan at
// conversation load/reload, once per Flight Deck card, and on turn edges — but ONLY for
// conversations that have (or recently had) a goal (`goalSeen`), so a fleet of goalless
// conversations never pays a per-turn transcript read. Kept in memory, keyed by the STABLE
// conversation id; the transcript is its durable source of truth, so nothing to persist. Unlike
// Remote Control, a goal SURVIVES session end (the CLI restores it on `--resume`), so its state is
// only forgotten when the conversation itself is removed (stop/remove/removeRepo/wipe).

import { create } from "zustand";
import { commands } from "../ipc/client";
import type { GoalState } from "../ipc/client";

// Conversations that have, or recently had, an active goal. Only these pay a transcript refetch on
// turn edges (see useGlobalSessionEvents) — a conversation that never used `/goal` reads nothing
// per turn. Seeded by any non-null read, by the load-time seed, and by issuing a `/goal` command.
const goalSeen = new Set<string>();
// Clear lifecycle (composer chip's clear button). `/goal clear` is a LOCAL command whose transcript
// write lands asynchronously — and worse, `useClearGoal` may cold-spawn a `--resume` process first
// (several seconds). So the guard is driven by the mutation lifecycle, NOT a wall-clock from the
// click: `clearingInFlight` freezes the optimistic null while the send is in flight (no flicker
// however long the spawn takes), then a short post-send `clearGraceUntil` window covers the write
// landing. On failure the guard is released and the true (still-active) goal is refetched.
const clearingInFlight = new Set<string>();
const clearGraceUntil = new Map<string, number>();
/** Post-send grace: how long after `/goal clear` is accepted we still ignore a "still active" read
 *  (the transcript write can lag the send). */
const CLEAR_GRACE_MS = 2500;

interface GoalStore {
  /** convId → active goal, or `null` when no goal is active. Absent = not yet fetched. */
  byConv: Record<string, GoalState | null>;
  set: (convId: string, goal: GoalState | null) => void;
  clear: (convId: string) => void;
  /** Drop every conversation's goal (wipe-all). */
  clearAll: () => void;
}

export const useGoalStore = create<GoalStore>((set) => ({
  byConv: {},
  set: (convId, goal) =>
    set((s) => {
      // Short-circuit a genuine no-op (the turn-edge refetch runs every turn) so subscribers don't
      // re-render. Guarded on the KEY already existing: a first fetch that returns `null` (no goal)
      // must still RECORD the key, so `seedActiveGoalOnce` knows this conversation has been read.
      if (convId in s.byConv && sameGoal(s.byConv[convId], goal)) return s;
      return { byConv: { ...s.byConv, [convId]: goal } };
    }),
  clear: (convId) => {
    // Prune every per-conversation goal slice on the same removal paths as the rest of the app.
    goalSeen.delete(convId);
    clearingInFlight.delete(convId);
    clearGraceUntil.delete(convId);
    set((s) => {
      if (!(convId in s.byConv)) return s;
      const next = { ...s.byConv };
      delete next[convId];
      return { byConv: next };
    });
  },
  clearAll: () => {
    goalSeen.clear();
    clearingInFlight.clear();
    clearGraceUntil.clear();
    set({ byConv: {} });
  },
}));

function sameGoal(a: GoalState | null, b: GoalState | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.condition === b.condition && (a.reason ?? null) === (b.reason ?? null);
}

/** Does this composer text invoke the `/goal` local command (set / clear / status)? Used to (a) mark
 *  the conversation `goalSeen` so the next turn edge picks up a freshly set goal, and (b) send it
 *  silently — goal plumbing is represented by the chip, never as a thread bubble. Word-bounded so a
 *  message that merely mentions `/goal` in prose does not match. */
export function isGoalCommand(text: string): boolean {
  return /^\/goal(\s|$)/.test(text.trimStart());
}

/** Mark a conversation as having a goal to track, so its turn edges refetch (see the `goalSeen`
 *  gate). Called when the user issues a `/goal` command — the goal_status lands on disk a moment
 *  later, so the gate must be armed before the next turn edge, not by the read itself. */
export function markGoalSeen(convId: string): void {
  goalSeen.add(convId);
}

/** Whether a conversation is worth a per-turn goal refetch (it has, or recently had, a goal). */
export function hasSeenGoal(convId: string): boolean {
  return goalSeen.has(convId);
}

/** Arm the clear guard: freeze the optimistic null while `/goal clear` is in flight (however long a
 *  cold `--resume` spawn takes). Call at click, before any async. */
export function beginGoalClearing(convId: string): void {
  clearingInFlight.add(convId);
}

/** The clear send was accepted: switch from "in flight" to a short grace window while the transcript
 *  write lands, then normal refetches resume. */
export function settleGoalClearing(convId: string): void {
  clearingInFlight.delete(convId);
  clearGraceUntil.set(convId, Date.now() + CLEAR_GRACE_MS);
}

/** The clear send FAILED: release the guard entirely so the caller's rollback refetch can restore
 *  the still-active goal (never leave the chip wrongly hidden over a live goal). */
export function endGoalClearing(convId: string): void {
  clearingInFlight.delete(convId);
  clearGraceUntil.delete(convId);
}

/**
 * Refresh a conversation's active goal from its on-disk transcript. `sessionId` is the CLI
 * session id (the transcript key); a conversation that never sent a message has none → no goal.
 * A read failure is non-fatal (the next turn-edge refetch corrects it) and leaves the last known
 * value untouched. Codex conversations have no Claude transcript, so callers gate this off for them.
 */
export async function refreshActiveGoal(convId: string, sessionId: string | null | undefined): Promise<void> {
  if (!sessionId) {
    if (clearingInFlight.has(convId)) return; // a clear is racing — don't clobber it
    goalSeen.delete(convId);
    useGoalStore.getState().set(convId, null);
    return;
  }
  const res = await commands.loadSessionGoal(sessionId);
  if (res.status !== "ok") {
    console.error("loadSessionGoal failed:", res.error);
    return;
  }
  // A clear is still in flight (send not yet accepted): keep the optimistic null, ignore any read.
  if (clearingInFlight.has(convId)) return;
  const grace = clearGraceUntil.get(convId);
  if (grace !== undefined && Date.now() < grace) {
    // Post-send grace: accept a confirmed null (the clear landed → done), but ignore a still-active
    // read (the transcript write hasn't caught up) so the chip doesn't flicker back on.
    if (res.data == null) {
      clearGraceUntil.delete(convId);
      goalSeen.delete(convId);
      useGoalStore.getState().set(convId, null);
    }
    return;
  }
  clearGraceUntil.delete(convId);
  if (res.data != null) goalSeen.add(convId);
  else goalSeen.delete(convId);
  useGoalStore.getState().set(convId, res.data);
}

/** Seed a conversation's goal from its transcript the FIRST time it's needed this run (a Flight Deck
 *  card mounting), so a goal set in a PRIOR app session shows right after quit/relaunch — the goal
 *  lives on disk but this store is in-memory. No-op once the conversation has been read (its key is
 *  present, even if the value is `null`). Live freshness then comes from the turn-edge refetch and
 *  direct clears; a stopped conversation re-seeds on its next history reload. */
export function seedActiveGoalOnce(convId: string, sessionId: string | null | undefined): void {
  if (convId in useGoalStore.getState().byConv) return;
  void refreshActiveGoal(convId, sessionId);
}

/** Reactive active goal for one conversation (`null` when none / not yet fetched). */
export function useActiveGoal(convId: string | null | undefined): GoalState | null {
  return useGoalStore((s) => (convId ? s.byConv[convId] ?? null : null));
}

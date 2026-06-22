// TanStack Query mutation wrappers around the IPC commands. Events feed Zustand
// directly (see useSessionEvents); Query only models the imperative commands so we
// get loading/error states and never silently swallow a Result.error branch.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { commands } from "./client";
import type { PermissionDecision, Result } from "./client";
import { useConversationStore } from "../store/conversationStore";
import {
  ensureConversationSession,
  liveHandle,
  useConversationsStore,
} from "../store/conversationsStore";
import { noteInterrupt } from "../notifications/notify";
import { worktreesKey } from "./useWorktrees";

// These hooks are keyed by a conversation's STABLE id, not its live session
// handle. Reads (the message store) key by the stable id; commands target the
// live `claude` session, so each one resolves the id → handle at call time. With
// the lazy policy a conversation may have no live session yet: `useSendMessage`
// spawns it on the first message, while the other commands no-op when there is
// nothing live to talk to.

/** Throw on the Result.error branch so onError fires and callers can surface it. */
async function unwrap<T>(p: Promise<Result<T, string>>): Promise<T> {
  const res = await p;
  if (res.status === "error") throw new Error(res.error);
  return res.data;
}

export function useSendMessage(convId: string) {
  const addUserTurn = useConversationStore((s) => s.addUserTurn);
  const addErrorTurn = useConversationStore((s) => s.addErrorTurn);
  const qc = useQueryClient();
  return useMutation({
    // `worktree` (first send only): spawn this conversation inside a freshly
    // created git worktree instead of the repo's main checkout. `queued`: the
    // agent was busy at send time, so the CLI will inject this mid-turn — flag the
    // optimistic turn so the UI shows it as "en attente".
    mutationFn: async ({ text, worktree, queued }: { text: string; worktree?: boolean; queued?: boolean }) => {
      // The core does not echo user turns, so append optimistically (keyed by the
      // stable id) before sending — instant even while the session spawns.
      addUserTurn(convId, text, queued);
      // Sending IS activity: float the conversation to the top now and persist
      // the new timestamp so the recency order survives a restart.
      useConversationsStore.getState().noteActivity(convId, { persist: true });
      // Lazy spawn: a conversation has no live process until its first message
      // (or its first message after being stopped/ended).
      const handle = await ensureConversationSession(convId, { worktree });
      const res = await unwrap(commands.sendMessage(handle, text));
      if (worktree) {
        // The first spawn just created a worktree — refresh the repo's list so
        // the indicator/manager show it.
        const repoPath = repoPathForConv(convId);
        if (repoPath) void qc.invalidateQueries({ queryKey: worktreesKey(repoPath) });
      }
      return res;
    },
    // The send can fail before anything streams back — most importantly when the
    // `claude` session fails to spawn (binary not found). Surface it as a visible
    // error bubble instead of leaving the optimistic user turn dangling silently.
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err);
      addErrorTurn(convId, message);
    },
  });
}

/** Repo path of a conversation, for invalidating its cached worktree list. */
function repoPathForConv(convId: string): string | null {
  const s = useConversationsStore.getState();
  const conv = s.conversations.find((c) => c.id === convId);
  return conv ? (s.repos.find((r) => r.id === conv.repoId)?.path ?? null) : null;
}

export function useAnswerPermission(convId: string) {
  const removePermission = useConversationStore((s) => s.removePermission);
  return useMutation({
    mutationFn: async (args: { requestId: string; decision: PermissionDecision }) => {
      // Optimistically dismiss the card; the state event confirms awaiting=false.
      removePermission(convId, args.requestId);
      const handle = liveHandle(convId);
      if (!handle) return; // nothing live to answer
      return unwrap(
        commands.answerPermission(handle, args.requestId, args.decision),
      );
    },
  });
}

// Model / effort / ultracode / permission are NOT TanStack mutations: they route
// through the conversations store (`setConvModel` / `setConvEffort` /
// `setConvUltracode` / `setConvPermission`), which persists the choice AND pushes
// it to the live stream. That keeps a pre-spawn pick (persisted, applied at spawn)
// and a live change on one path, and lets the core's get_settings read-back be the
// source of truth for what the indicator shows.

export function useInterrupt(convId: string) {
  return useMutation({
    mutationFn: async () => {
      const handle = liveHandle(convId);
      if (!handle) return; // nothing running to interrupt
      // The interrupt ends the turn (busy→false), which would otherwise fire a
      // "done" notification for a stop the user just performed — suppress it.
      noteInterrupt(convId);
      return unwrap(commands.interruptSession(handle));
    },
  });
}

export function useStop(convId: string) {
  return useMutation({
    mutationFn: async () => {
      const handle = liveHandle(convId);
      if (!handle) return; // already off
      return unwrap(commands.stopSession(handle));
    },
  });
}

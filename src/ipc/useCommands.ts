// TanStack Query mutation wrappers around the IPC commands. Events feed Zustand
// directly (see useSessionEvents); Query only models the imperative commands so we
// get loading/error states and never silently swallow a Result.error branch.

import { useMutation } from "@tanstack/react-query";
import { commands } from "./client";
import type { PermissionDecision, PermissionMode, Result } from "./client";
import { useConversationStore } from "../store/conversationStore";
import {
  ensureConversationSession,
  liveHandle,
  useConversationsStore,
} from "../store/conversationsStore";

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
  return useMutation({
    mutationFn: async (text: string) => {
      // The core does not echo user turns, so append optimistically (keyed by the
      // stable id) before sending — instant even while the session spawns.
      addUserTurn(convId, text);
      // Sending IS activity: float the conversation to the top now and persist
      // the new timestamp so the recency order survives a restart.
      useConversationsStore.getState().noteActivity(convId, { persist: true });
      // Lazy spawn: a conversation has no live process until its first message
      // (or its first message after being stopped/ended).
      const handle = await ensureConversationSession(convId);
      return unwrap(commands.sendMessage(handle, text));
    },
  });
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

export function useSetPermissionMode(convId: string) {
  return useMutation({
    mutationFn: async (mode: PermissionMode) => {
      const handle = liveHandle(convId);
      if (!handle) return; // applied once the session is live
      return unwrap(commands.setPermissionMode(handle, mode));
    },
  });
}

export function useSetModel(convId: string) {
  return useMutation({
    mutationFn: async (model: string) => {
      const handle = liveHandle(convId);
      if (!handle) return;
      return unwrap(commands.setModel(handle, model));
    },
  });
}

export function useSetEffortLevel(convId: string) {
  return useMutation({
    mutationFn: async (level: string) => {
      const handle = liveHandle(convId);
      if (!handle) return;
      return unwrap(commands.setEffortLevel(handle, level));
    },
  });
}

export function useInterrupt(convId: string) {
  return useMutation({
    mutationFn: async () => {
      const handle = liveHandle(convId);
      if (!handle) return; // nothing running to interrupt
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

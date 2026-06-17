// TanStack Query mutation wrappers around the IPC commands. Events feed Zustand
// directly (see useSessionEvents); Query only models the imperative commands so we
// get loading/error states and never silently swallow a Result.error branch.

import { useMutation } from "@tanstack/react-query";
import { commands } from "./client";
import type { PermissionDecision, PermissionMode, Result } from "./client";
import { useConversationStore } from "../store/conversationStore";

/** Throw on the Result.error branch so onError fires and callers can surface it. */
async function unwrap<T>(p: Promise<Result<T, string>>): Promise<T> {
  const res = await p;
  if (res.status === "error") throw new Error(res.error);
  return res.data;
}

export function useSpawn() {
  return useMutation({
    mutationFn: (args: { repoPath: string; resume?: string | null }) =>
      unwrap(commands.spawnSession(args.repoPath, args.resume ?? null)),
  });
}

export function useSendMessage(session: string) {
  const addUserTurn = useConversationStore((s) => s.addUserTurn);
  return useMutation({
    mutationFn: async (text: string) => {
      // The core does not echo user turns, so append optimistically before sending.
      addUserTurn(session, text);
      return unwrap(commands.sendMessage(session, text));
    },
  });
}

export function useAnswerPermission(session: string) {
  const removePermission = useConversationStore((s) => s.removePermission);
  return useMutation({
    mutationFn: async (args: { requestId: string; decision: PermissionDecision }) => {
      // Optimistically dismiss the card; the state event confirms awaiting=false.
      removePermission(session, args.requestId);
      return unwrap(
        commands.answerPermission(session, args.requestId, args.decision),
      );
    },
  });
}

export function useSetPermissionMode(session: string) {
  return useMutation({
    mutationFn: (mode: PermissionMode) =>
      unwrap(commands.setPermissionMode(session, mode)),
  });
}

export function useSetModel(session: string) {
  return useMutation({
    mutationFn: (model: string) => unwrap(commands.setModel(session, model)),
  });
}

export function useSetEffortLevel(session: string) {
  return useMutation({
    mutationFn: (level: string) => unwrap(commands.setEffortLevel(session, level)),
  });
}

export function useInterrupt(session: string) {
  return useMutation({
    mutationFn: () => unwrap(commands.interruptSession(session)),
  });
}

export function useStop(session: string) {
  return useMutation({
    mutationFn: () => unwrap(commands.stopSession(session)),
  });
}

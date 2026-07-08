// TanStack Query mutation wrappers around the IPC commands. Events feed Zustand
// directly (see useSessionEvents); Query only models the imperative commands so we
// get loading/error states and never silently swallow a Result.error branch.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { commands } from "./client";
import type { PermissionDecision, Result } from "./client";
import { useConversationStore } from "../store/conversationStore";
import type { UserTurnImage } from "../store/types";
import {
  ensureConversationSession,
  liveHandle,
  useConversationsStore,
} from "../store/conversationsStore";
import { noteInterrupt } from "../notifications/notify";
import { worktreesKey } from "./useWorktrees";
import { useRemoteControlStore } from "../store/remoteControl";
import { triggerLastMessageSummary } from "../store/lastMessageSummary";
import { buildCodexControls } from "../features/conversation/codexControls";

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
    // optimistic turn so the UI shows it as "en attente". `images`: files joined via
    // the composer's "+" / paste, sent as `image` blocks and shown as thumbnails.
    mutationFn: async ({
      text,
      worktree,
      queued,
      images,
    }: {
      text: string;
      worktree?: boolean;
      queued?: boolean;
      images?: UserTurnImage[];
    }) => {
      // The core does not echo user turns, so append optimistically (keyed by the
      // stable id) before sending — instant even while the session spawns.
      addUserTurn(convId, text, queued, images);
      // Sending the next message consumes any pending reminder: the user has moved
      // on from the previous result. `addUserTurn` clears the LIVE turnSeen; clear
      // the PERSISTED reminder too so it doesn't re-surface on the next restart.
      useConversationsStore.getState().setReminder(convId, null);
      // Sending IS activity: float the conversation to the top now and persist
      // the new timestamp so the recency order survives a restart.
      useConversationsStore.getState().noteActivity(convId, { persist: true });
      // Lazy spawn: a conversation has no live process until its first message
      // (or its first message after being stopped/ended).
      const handle = await ensureConversationSession(convId, { worktree });
      // Map the UI's image shape to the wire's `ImageAttachment` (media_type + raw
      // base64). Empty array for a plain text turn.
      const wireImages = (images ?? []).map((i) => ({ media_type: i.mediaType, data: i.dataBase64 }));
      // For a Codex conversation, fold its composer controls (model / effort / preset /
      // network / summary / personality) into the per-turn override object; `null` for
      // Claude (which pushes each control live instead).
      const conv = useConversationsStore.getState().conversations.find((c) => c.id === convId);
      const codexControls = conv?.kind === "codex" ? buildCodexControls(conv) : null;
      const res = await unwrap(commands.sendMessage(handle, text, wireImages, codexControls));
      // On each of the first few messages of a still-untitled conversation, ask the
      // binary to (re)generate a smart title from the accumulated intent (capped, then
      // frozen; no-op once renamed / over the cap / no live session). Like the VS Code
      // extension, but tracking the evolving topic. The title arrives via
      // SessionTitleEvent and replaces the optimistic placeholder name.
      useConversationsStore.getState().triggerAutoTitle(convId, text);
      // Also (re)generate the Flight Deck's few-word summary of THIS message (the
      // "last ask"). Instant truncation now, replaced by a ≤6-word Haiku summary that
      // arrives via SessionSummaryEvent. Regenerated on every send (unlike the title,
      // which settles). `handle` is the live session we just sent through.
      triggerLastMessageSummary(convId, handle, text);
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
  const addErrorTurn = useConversationStore((s) => s.addErrorTurn);
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
    // The card was dismissed optimistically: if the reply never reached the session,
    // the agent stays blocked CLI-side with nothing in the thread — surface it.
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err);
      addErrorTurn(convId, `Réponse à la demande d'autorisation échouée : ${message}`);
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
  const addErrorTurn = useConversationStore((s) => s.addErrorTurn);
  return useMutation({
    mutationFn: async () => {
      const handle = liveHandle(convId);
      if (!handle) return; // nothing running to interrupt
      // The interrupt ends the turn (busy→false), which would otherwise fire a
      // "done" notification for a stop the user just performed — suppress it.
      noteInterrupt(convId);
      return unwrap(commands.interruptSession(handle));
    },
    // A failed interrupt is otherwise invisible (the "done" notif was already
    // suppressed) — say it didn't take so the user knows the agent is still running.
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err);
      addErrorTurn(convId, `Interruption échouée : ${message}`);
    },
  });
}

/** Compact a Codex conversation's context via the native `thread/compact/start` RPC.
 *  Claude compacts via the `/compact` text turn instead, so the composer only calls this
 *  for a Codex conversation. A no-op if nothing is running (the ring is only interactive
 *  after the first turn). A failure is already surfaced as a thread notice by the actor,
 *  so here we only guard the transport path. */
export function useCodexCompact(convId: string) {
  const addErrorTurn = useConversationStore((s) => s.addErrorTurn);
  return useMutation({
    mutationFn: async () => {
      const handle = liveHandle(convId);
      if (!handle) return; // no live thread → nothing to compact
      return unwrap(commands.codexCompact(handle));
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err);
      addErrorTurn(convId, `Compactage impossible : ${message}`);
    },
  });
}

export function useStop(convId: string) {
  const addErrorTurn = useConversationStore((s) => s.addErrorTurn);
  return useMutation({
    mutationFn: async () => {
      const handle = liveHandle(convId);
      if (!handle) return; // already off
      return unwrap(commands.stopSession(handle));
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err);
      addErrorTurn(convId, `Arrêt de la session échoué : ${message}`);
    },
  });
}

/** Enable/disable this conversation's Remote Control bridge (native `/remote-control`).
 *  Enabling needs a LIVE `claude` process (the bridge rides the running session), so we
 *  spawn one lazily if needed — clicking the chip on an idle conversation both starts it
 *  and bridges it. Disabling only matters if something is live. The result (connected +
 *  claude.ai/code URL / disconnected / error) is written to the live remote-control store;
 *  async health downgrades then arrive via `SessionRemoteControlEvent`. */
export function useSetRemoteControl(convId: string) {
  const addErrorTurn = useConversationStore((s) => s.addErrorTurn);
  return useMutation({
    mutationFn: async ({
      enabled,
      name,
      worktree,
    }: {
      enabled: boolean;
      name?: string;
      /** On a not-yet-spawned conversation, enabling spawns the session lazily; honor a
       *  pending "start in a fresh worktree" choice so activating remote control first
       *  doesn't silently foreclose it. */
      worktree?: boolean;
    }) => {
      const rc = useRemoteControlStore.getState();
      // Disabling with nothing live: the bridge is already gone with the process.
      const handle = enabled ? await ensureConversationSession(convId, { worktree }) : liveHandle(convId);
      if (!handle) {
        rc.set(convId, { status: "disconnected", session_url: null, error: null, pairing_code: null });
        return;
      }
      // Optimistic "connecting" so the chip reacts instantly during the handshake.
      if (enabled) rc.set(convId, { status: "connecting", session_url: null, error: null, pairing_code: null });
      const state = await unwrap(commands.setRemoteControl(handle, enabled, name ?? null));
      rc.set(convId, state);
      // An IN-BAND rejection (e.g. the binary answers success-with-status:"error" — a
      // policy-disabled bridge, or a wire success that returned no session_url) does NOT
      // throw, so `onError` never runs. Surface it in the thread too (not only the chip
      // dot) — every error stays visible, per the project's no-silent-failure rule.
      if (state.status === "error") {
        addErrorTurn(convId, `Remote control échoué : ${state.error ?? "erreur inconnue"}`);
      } else if (state.error) {
        // The bridge came UP but a secondary step failed (e.g. Codex enable succeeded yet
        // the pairing-code fetch failed): still surface it — the bridge is on but a device
        // can't be paired, and the user must know rather than see a silent no-code state.
        addErrorTurn(convId, `Remote control : ${state.error}`);
      }
      return state;
    },
    // A failed bridge toggle is otherwise invisible — reflect it on the chip AND
    // surface it in the thread so the user knows remote control didn't take.
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err);
      useRemoteControlStore
        .getState()
        .set(convId, { status: "error", session_url: null, error: message, pairing_code: null });
      addErrorTurn(convId, `Remote control échoué : ${message}`);
    },
  });
}

/** Stop ONE background task (a `run_in_background` Bash) by its `task_id`, without
 *  ending the turn or the session. The task settles to `stopped` via its `task_*`
 *  lifecycle (the bar reflects it). No-op if nothing is live. */
export function useStopTask(convId: string) {
  const addErrorTurn = useConversationStore((s) => s.addErrorTurn);
  return useMutation({
    mutationFn: async (taskId: string) => {
      const handle = liveHandle(convId);
      if (!handle) return; // nothing live to stop
      return unwrap(commands.stopTask(handle, taskId));
    },
    // A failed stop is otherwise invisible — say it didn't take so the user knows the
    // background command is still running.
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err);
      addErrorTurn(convId, `Arrêt de la tâche de fond échoué : ${message}`);
    },
  });
}

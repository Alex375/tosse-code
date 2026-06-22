// React binding for the pure status model (agent/status.ts). It gathers the raw
// signals from BOTH stores — the message store (live session state, pending
// permissions, finished turns) keyed by the conversation's STABLE id, and the
// conversations store (the live `handle`, the on/off source of truth) — then runs
// the pure `deriveAgentStatus`. Kept separate from status.ts so that module stays
// React-free and unit-testable; this hook is what the sidebar and the future
// fleet view both call.
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useConversationStore } from "../store/conversationStore";
import { useConversationsStore } from "../store/conversationsStore";
import type { SessionEntry } from "../store/types";
import { deriveAgentStatus, type AgentSignals, type AgentStatus } from "./status";

// Everything in AgentSignals except the handle (which lives in the other store).
type InnerSignals = Omit<AgentSignals, "handle">;

const NEUTRAL: InnerSignals = {
  busy: false,
  awaitingPermission: false,
  pendingToolName: null,
  pendingPrompt: null,
  activity: null,
  lastTurnSubtype: null,
  lastTurnIsError: false,
  turnSeen: true,
  lastAssistantText: null,
};

/** Text of the most recent assistant turn (its joined text blocks), for the
 *  open-question heuristic. Scans the timeline tail backwards and stops at the
 *  first assistant turn, so it visits only a few entries in practice. */
function lastAssistantText(entry: SessionEntry): string | null {
  for (let i = entry.timeline.length - 1; i >= 0; i--) {
    const e = entry.timeline[i];
    if (e.kind !== "turn") continue;
    const turn = entry.turns[e.id];
    if (!turn || turn.role !== "assistant") continue;
    const text = turn.blocks
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    // Finalized turns hold their text in `blocks`; fall back to the live buffer.
    return text || turn.streamingText.trim() || null;
  }
  return null;
}

/** subtype + is_error of the most recent finished turn (its turn_result). */
function lastTurnOutcome(entry: SessionEntry): { subtype: string | null; isError: boolean } {
  for (let i = entry.timeline.length - 1; i >= 0; i--) {
    const e = entry.timeline[i];
    if (e.kind !== "turn_result") continue;
    const meta = entry.turnResults[e.id];
    if (meta) return { subtype: meta.subtype, isError: meta.isError };
  }
  return { subtype: null, isError: false };
}

/** Flatten a session entry into the shallow-stable signal slice. The timeline
 *  scans (last turn / last assistant text) run ONLY when the session is settled
 *  and unconsumed — i.e. when the result could actually be review/need-input. */
function gather(entry: SessionEntry | undefined): InnerSignals {
  if (!entry) return NEUTRAL;
  const st = entry.state;
  const pending = entry.pendingPermissions[0] ?? null;
  const settled = !st.busy && !st.awaiting_permission && !entry.turnSeen;
  const outcome = settled ? lastTurnOutcome(entry) : { subtype: null, isError: false };
  return {
    busy: st.busy,
    awaitingPermission: st.awaiting_permission,
    pendingToolName: pending?.tool_name ?? null,
    pendingPrompt: pending?.title ?? pending?.description ?? null,
    activity: st.activity,
    lastTurnSubtype: outcome.subtype,
    lastTurnIsError: outcome.isError,
    turnSeen: entry.turnSeen,
    lastAssistantText: settled ? lastAssistantText(entry) : null,
  };
}

/**
 * The rich {@link AgentStatus} for a conversation (by stable id). Subscribes to
 * both stores; `useShallow` keeps the inner slice stable across unrelated changes
 * so the memoized status is referentially stable until a real signal moves.
 */
export function useAgentStatus(convId: string): AgentStatus {
  const handle = useConversationsStore(
    (s) => s.conversations.find((c) => c.id === convId)?.handle ?? null,
  );
  const inner = useConversationStore(useShallow((s) => gather(s.sessions[convId])));
  return useMemo(() => deriveAgentStatus({ handle, ...inner }), [handle, inner]);
}

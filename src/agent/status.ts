// The agent/conversation STATUS model — a rich, UI-agnostic discriminated union
// derived from the raw session signals. This is the SINGLE source of truth for
// "what is this agent doing right now", shared by:
//   - the sidebar status dot + row highlight (this task), and
//   - the upcoming fleet / agent-management view, which renders the SAME status
//     differently and needs the carried context (the pending question, the
//     blocking tool, the error message) — not just a colour.
//
// Keep this module PURE: no React, no store imports beyond the `StreamState`
// colour type. Everything here is unit-testable in isolation (see status.test.ts).
//
// On the hard case — "open question" vs "ready for review": the protocol gives NO
// native signal for "Claude asked a question in plain text and is waiting". An
// open question and a finished statement BOTH end a turn with stop_reason
// "end_turn"/subtype "success" — they are indistinguishable on the wire. The only
// 100%-native question signal is the `AskUserQuestion` tool (a questionnaire). For
// everything else we fall back to a heuristic (`looksLikeQuestion`), and let the
// user dismiss a false positive with the "Vu" button.
import type { StreamState } from "../ui/kit";

export type AgentStatus =
  | { kind: "off" } // no live `claude` process (never started / stopped / exited)
  | { kind: "idle" } // live, nothing pending, last result already consumed
  | { kind: "running"; activity: string | null } // a turn is in flight
  | { kind: "needInput"; via: "questionnaire" | "openQuestion"; prompt: string | null }
  | { kind: "needIntervention"; tool: string } // a permission prompt is blocking
  | { kind: "error"; message: string } // last finished turn ended in error
  | { kind: "review" }; // turn finished cleanly, not yet seen by the user

/**
 * The minimal raw signals needed to derive an {@link AgentStatus}. All primitives
 * so a store selector can produce them shallow-stably (no nested objects).
 */
export interface AgentSignals {
  /** Live Rust session handle, or null when no `claude` process is running. */
  handle: string | null;
  /** True while a turn is in flight. */
  busy: boolean;
  /** True while a permission prompt is awaiting the user's answer. */
  awaitingPermission: boolean;
  /** tool_name of the first pending permission (null when none). */
  pendingToolName: string | null;
  /** A human prompt for the pending permission (title/description), for the fleet view. */
  pendingPrompt: string | null;
  /** Fine-grained activity hint from system/status (e.g. "requesting"). */
  activity: string | null;
  /** subtype of the last finished turn's turn_result (e.g. "success", "error_*"). */
  lastTurnSubtype: string | null;
  /** is_error flag of the last finished turn. */
  lastTurnIsError: boolean;
  /** Whether the user has consumed (replied to / dismissed) the last finished turn. */
  turnSeen: boolean;
  /** Text of the last assistant turn, for the open-question heuristic. */
  lastAssistantText: string | null;
}

/** The native questionnaire tool — the only 100%-reliable "Claude asks a question". */
export const QUESTIONNAIRE_TOOL = "AskUserQuestion";

/**
 * Heuristic: does this assistant text read as a question awaiting a reply? Used
 * only as a fallback because the protocol exposes no native "waiting on an open
 * question" signal (see the module header). Peels trailing whitespace / markdown
 * emphasis / closers so "**…?**", "(… ?)" and "…?\n```" still count as ending on
 * a "?". Imperfect by design — a rhetorical "?" trips it, a question phrased
 * without "?" misses it — but a false positive is one "Vu" click away.
 */
export function looksLikeQuestion(text: string | null): boolean {
  if (!text) return false;
  const stripped = text.replace(/[\s*_)\]"'`~>]+$/u, "");
  return stripped.endsWith("?");
}

/** Human label for an error turn_result subtype. */
function errorMessage(subtype: string | null): string {
  switch (subtype) {
    case "error_max_turns":
      return "Limite de tours atteinte";
    case "error_during_execution":
      return "Erreur pendant l'exécution";
    default:
      return "La dernière réponse s'est terminée en erreur";
  }
}

/**
 * Derive the rich status from the raw signals. Order encodes priority:
 * off → blocking permission → running → (settled: error / open-question / review)
 * → idle. The "settled" branch only fires when the session is live, not busy, not
 * awaiting, and the last finished turn has NOT been consumed (`!turnSeen`).
 */
export function deriveAgentStatus(s: AgentSignals): AgentStatus {
  // A null handle subsumes "never started", "stopped", and "exited" — the
  // protocol does not distinguish them, and none has a live state to report.
  if (!s.handle) return { kind: "off" };

  // A pending permission genuinely BLOCKS the agent — it cannot proceed until the
  // user answers. The questionnaire is a need-input; any other tool is a blocking
  // intervention (Bash/Edit/Write/…).
  if (s.awaitingPermission) {
    if (s.pendingToolName === QUESTIONNAIRE_TOOL)
      return { kind: "needInput", via: "questionnaire", prompt: s.pendingPrompt };
    return { kind: "needIntervention", tool: s.pendingToolName ?? "outil" };
  }

  if (s.busy) return { kind: "running", activity: s.activity };

  // Live and idle. If the last turn just finished and the user hasn't acted on it,
  // surface it (error / open-question / review). Otherwise there's nothing to show.
  if (!s.turnSeen) {
    if (s.lastTurnIsError || (s.lastTurnSubtype?.startsWith("error") ?? false))
      return { kind: "error", message: errorMessage(s.lastTurnSubtype) };
    if (looksLikeQuestion(s.lastAssistantText))
      return { kind: "needInput", via: "openQuestion", prompt: s.lastAssistantText };
    return { kind: "review" };
  }

  return { kind: "idle" };
}

/**
 * Map a status onto the design's status-dot colour token (the 4-colour grouping:
 * green run / orange attention / blue review / grey idle-off, plus red error).
 * The fleet view can choose a finer rendering — this is the compact dot.
 */
export function agentStatusToDot(s: AgentStatus): StreamState {
  switch (s.kind) {
    case "off":
      return "off"; // grey outline
    case "idle":
      return "done"; // grey
    case "running":
      return "work"; // green
    case "needInput":
    case "needIntervention":
      return "ask"; // orange
    case "review":
      return "review"; // blue
    case "error":
      return "err"; // red
  }
}

/**
 * Whole-row emphasis bucket for the sidebar (tints the entire conversation case),
 * or null for no emphasis. `running` stays quiet — only its dot pulses — so a
 * normally-working agent doesn't "shout"; off/idle are neutral.
 */
export function rowAttention(s: AgentStatus): "input" | "review" | "error" | null {
  switch (s.kind) {
    case "needInput":
    case "needIntervention":
      return "input";
    case "review":
      return "review";
    case "error":
      return "error";
    default:
      return null;
  }
}

/**
 * Whether the user can acknowledge ("Vu") this status to clear it back to idle.
 * Only the non-blocking REMINDERS qualify: a finished turn awaiting review, an
 * error to acknowledge, or an open question the heuristic flagged (possibly a
 * false positive). A real block — questionnaire or permission — must be ANSWERED
 * in the thread, not dismissed, so it is NOT dismissable.
 */
export function isDismissable(s: AgentStatus): boolean {
  return (
    s.kind === "review" ||
    s.kind === "error" ||
    (s.kind === "needInput" && s.via === "openQuestion")
  );
}

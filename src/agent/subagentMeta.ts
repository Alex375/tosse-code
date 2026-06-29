// Shared, React-free helpers for displaying a sub-agent (the `Agent`/`Task` tool):
// the friendly model label, the background detection, the status-dot mapping, and —
// crucially — resolving the sub-agent's `agent_id` (the key for its on-disk
// transcript) even while it runs in the background.
//
// Used by the inline card (ConductorThread), the conversation AgentBar, and the
// FlightDeck badge so they never drift.

import type { BackgroundTask, BackgroundTaskStatus, JsonValue } from "../ipc/client";
import type { StreamState } from "../ui/kit";

/** "claude-haiku-4-5-20251001" → "haiku-4-5" — the friendly bit of a model id. */
export function shortModel(m: string): string {
  return m.replace(/^claude-/, "").replace(/-\d{8}$/, "").replace(/\[.*\]$/, "");
}

/** Canonical display labels for the reasoning-effort levels, folding the
 *  ultracode tier in. The CLI's effort enum is EXACTLY low/medium/high/xhigh;
 *  "Ultra code" is xhigh + a separate `ultracode` flag (see EffortGauge, which
 *  reuses this map so the gauge and every read-only surface never drift). */
export const EFFORT_LABELS = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra",
  ultracode: "Ultra code",
} as const;

/** Friendly label for a conversation's live reasoning effort, or null when
 *  unknown (no `get_settings` read-back yet). `ultracode` outranks the raw
 *  effort. An unrecognised effort string falls through to itself (forward-compat). */
export function effortLabel(effort: string | null | undefined, ultracode?: boolean): string | null {
  if (ultracode) return EFFORT_LABELS.ultracode;
  if (!effort) return null;
  return (EFFORT_LABELS as Record<string, string>)[effort] ?? effort;
}

/** ms → "0.8s" / "1m 04s" — compact wall-clock for a finished sub-agent. */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s % 1 === 0 ? s.toFixed(0) : s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem.toString().padStart(2, "0")}s`;
}

/** True when a tool_use was launched detached (`run_in_background: true`) — generic
 *  over the producer (Bash / Agent / …). The shared primitive behind the per-tool
 *  helpers below. */
export function isRunInBackground(input: JsonValue): boolean {
  return (
    !!input &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    (input as Record<string, unknown>).run_in_background === true
  );
}

/** True when an `Agent` tool_use was launched detached (`run_in_background: true`). */
export function isBackgroundAgentInput(input: JsonValue): boolean {
  return isRunInBackground(input);
}

/** A background task's coarse lifecycle → the design's status-dot colour token. */
export function taskStatusDot(s: BackgroundTaskStatus): StreamState {
  switch (s) {
    case "running":
      return "work";
    case "failed":
      return "err";
    case "stopped":
      return "off";
    default:
      return "done";
  }
}

/** Flatten a tool_result's content (string | array of {text} | …) to plain text.
 *  Shared with the worktree-path parser so both stay in sync on content shapes. */
export function resultText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
      .join(" ");
  }
  return "";
}

/**
 * Parse a sub-agent's id out of its `Agent` tool_result. A detached (background)
 * Agent returns an immediate ack containing `agentId: <id>` (and an
 * `…/agent-<id>.jsonl` / `…/<id>.output` path) — the id we need to read its
 * transcript BEFORE the terminal `task_notification` (which is the only thing that
 * back-fills `BackgroundTask.agent_id`). Returns null when nothing matches.
 */
export function agentIdFromResult(content: JsonValue | undefined): string | null {
  const text = resultText(content);
  if (!text) return null;
  const byLabel = text.match(/agent[_ ]?id["\s:]+([A-Za-z0-9_-]+)/i);
  if (byLabel) return byLabel[1];
  const byFile = text.match(/agent-([A-Za-z0-9_-]+)\.jsonl/);
  if (byFile) return byFile[1];
  return null;
}

/**
 * Parse a dynamic-workflow run's id out of its `Workflow` tool_result. A workflow ALWAYS
 * runs in the background — the tool returns an immediate ack whose text carries the run id
 * verbatim ("Run ID: wf_cb719d53-406", plus a "Transcript dir: …/wf_<id>" path). That id
 * is the key for [`super::subagents::load_workflow_run`] (which accepts the `wf_`-prefixed
 * form). The wire's `task_*` lifecycle events do NOT carry it, so this ack is the only live
 * source — exactly the role {@link agentIdFromResult} plays for sub-agents. Null when
 * nothing matches (e.g. resumed conversation: the result lives only in the transcript).
 */
export function runIdFromResult(content: JsonValue | undefined): string | null {
  const text = resultText(content);
  if (!text) return null;
  const byLabel = text.match(/run[_ ]?id["\s:]+(?:wf_)?([A-Za-z0-9-]+)/i);
  if (byLabel) return byLabel[1].startsWith("wf_") ? byLabel[1] : `wf_${byLabel[1]}`;
  // Fallback: any `wf_<id>` token (Transcript dir / Script file paths in the ack).
  const byToken = text.match(/\bwf_[A-Za-z0-9-]+/);
  return byToken ? byToken[0] : null;
}

/**
 * Best available `agent_id` for drilling into a sub-agent's transcript:
 *  1. the BackgroundTask's own `agent_id` (set at task_notification, foreground), else
 *  2. parsed from the immediate tool_result ack (background, available during the run), else
 *  3. derived from the task's `output_file` basename (`…/<id>.output` for an Agent).
 */
export function resolveAgentId(
  task: BackgroundTask | undefined,
  resultContent: JsonValue | undefined,
): string | null {
  if (task?.agent_id) return task.agent_id;
  const fromResult = agentIdFromResult(resultContent);
  if (fromResult) return fromResult;
  if (task?.kind === "agent" && task.output_file) {
    const m = task.output_file.match(/([A-Za-z0-9_-]+)\.(?:jsonl|output)$/);
    if (m) return m[1].replace(/^agent-/, "");
  }
  return null;
}

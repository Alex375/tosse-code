// Grouping layer for the conversation transcript: turns a turn's flat block list
// into SEGMENTS, where every run of consecutive tool_use blocks becomes ONE
// collapsible "Exécuté N étapes" section (the claude.ai/code shape — see memory
// `claude-app-transcript-grouped-steps`). Assistant prose / thinking break a run,
// so a turn that writes → runs 4 tools → writes → runs 2 tools yields two sections,
// exactly like the reference. Pure + framework-free so it is unit-testable and
// shared verbatim by the live thread (ConductorThread) and the off-thread
// transcript (SubAgentTranscript).

import type { JsonValue, NormalizedBlock } from "../../ipc/client";
import { field } from "../../agent/ask";
import { toolActivityLabel } from "../../store/activity";
import { isRunInBackground } from "../../agent/subagentMeta";
import { basename, toolMeta } from "./toolMeta";
import { diffCounts, lineDiff } from "./lineDiff";

/** Lucide-ish icon token per tool, resolved by the UI's <Ico>. Shared so the live
 *  step rows and the static transcript pick the same glyph for a given tool. */
export const TOOL_ICON: Record<string, string> = {
  Read: "file",
  Edit: "diff",
  MultiEdit: "diff",
  Write: "file",
  Bash: "term",
  Grep: "search",
  Glob: "search",
  WebFetch: "layers",
  WebSearch: "search",
  // The sub-agent tool is `Agent` on the wire (was `Task`); keep `Task` as an alias.
  Agent: "spark",
  Task: "spark",
  TodoWrite: "list",
  NotebookEdit: "diff",
  AskUserQuestion: "form",
};

export interface ToolStep {
  /** tool_use id — joins to its result. */
  id: string;
  name: string;
  input: JsonValue;
}

export type Segment =
  | { kind: "text"; key: string; text: string }
  | { kind: "thinking"; key: string; text: string }
  | { kind: "run"; key: string; steps: ToolStep[] }
  // A sub-agent (Agent/Task) renders as its OWN inline card (rich live lifecycle +
  // drill-in transcript), NEVER grouped into a run nor hidden by the live-trailing
  // suppression — so it gets a dedicated segment that breaks the surrounding run.
  | { kind: "agent"; key: string; step: ToolStep };

/**
 * A tool_use that is NEVER shown inline in the thread — it lives in a pinned bar or
 * elsewhere — so it must not appear as a step NOR break a run (it's invisible):
 *  - any detached `run_in_background` tool (Bash → BashBar, Agent → AgentBar),
 *  - `Monitor` (always a background watch → MonitorBar),
 *  - anything `toolMeta` marks suppressed (TodoWrite → TodoBar, ide_ RPC).
 */
export function isHiddenInline(name: string, input: JsonValue): boolean {
  if (name === "Monitor") return true;
  if (isRunInBackground(input)) return true;
  return toolMeta(name, input).suppressed;
}

/**
 * Walk a turn's blocks, coalescing consecutive (non-hidden) tool_use blocks into
 * `run` segments. Text / thinking flush the current run and render as separators;
 * hidden tools are skipped without breaking the surrounding run. Empty text/thinking
 * blocks are dropped (a streamed turn can hold empty placeholders).
 */
export function groupBlocks(blocks: NormalizedBlock[]): Segment[] {
  const out: Segment[] = [];
  let run: ToolStep[] | null = null;

  blocks.forEach((b, i) => {
    if (b.type === "tool_use") {
      if (isHiddenInline(b.name, b.input)) return; // invisible: no step, no break
      // A sub-agent is its own inline card, not a grouped step — it breaks the run.
      if (b.name === "Agent" || b.name === "Task") {
        run = null;
        out.push({ kind: "agent", key: `a-${i}`, step: { id: b.id, name: b.name, input: b.input } });
        return;
      }
      if (!run) {
        run = [];
        out.push({ kind: "run", key: `run-${i}`, steps: run });
      }
      run.push({ id: b.id, name: b.name, input: b.input });
      return;
    }
    run = null; // any non-tool block ends the run
    if (b.type === "text") {
      if (b.text) out.push({ kind: "text", key: `t-${i}`, text: b.text });
    } else if (b.type === "thinking") {
      if (b.text) out.push({ kind: "thinking", key: `th-${i}`, text: b.text });
    }
    // `other` blocks (images/documents) are not rendered here.
  });

  return out;
}

/** Short English verb per tool, for a run section's action summary. */
export function toolVerb(name: string): string {
  switch (name) {
    case "Read":
      return "Read";
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return "Edit";
    case "Write":
      return "Write";
    case "Bash":
      return "Run";
    case "Grep":
    case "WebSearch":
      return "Search";
    case "Glob":
      return "Find";
    case "WebFetch":
      return "Fetch";
    case "Agent":
    case "Task":
      return "Agent";
    case "AskUserQuestion":
      return "Question";
    case "TodoWrite":
      return "Update";
    default:
      return name;
  }
}

/**
 * A clear, DETERMINISTIC header for a run section (no LLM call): for a single step,
 * its full label ("Read App.tsx"); otherwise the distinct action verbs in order,
 * with a ×N when a verb repeats — "Read · Search · Find", "Run ×3", "Edit ×2 · Run".
 * Capped so it stays one line.
 */
export function runHeader(steps: ToolStep[]): string {
  if (steps.length === 1) return stepLabel(steps[0].name, steps[0].input);
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const s of steps) {
    const v = toolVerb(s.name);
    if (!counts.has(v)) order.push(v);
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const MAX = 4;
  const parts = order.slice(0, MAX).map((v) => {
    const n = counts.get(v) ?? 1;
    return n > 1 ? `${v} ×${n}` : v;
  });
  if (order.length > MAX) parts.push(`+${order.length - MAX}`);
  return parts.join(" · ");
}

/**
 * The one-line label for a settled step. Prefers the agent-written `description`
 * for Bash/Agent (what the reference shows — "Explored backend structure"), else
 * the same English name+arg phrasing as the live activity indicator ("Edit foo.ts"),
 * so the in-flight line and the settled step read identically.
 */
export function stepLabel(name: string, input: JsonValue): string {
  if (name === "Bash" || name === "Agent" || name === "Task") {
    const desc = field(input, "description");
    if (desc && desc.trim()) return desc.trim();
  }
  return toolActivityLabel(name, input);
}

export type StepSummary =
  | { kind: "diff"; added: number; removed: number }
  | { kind: "text"; text: string }
  | null;

function countNonEmptyLines(s: string): number {
  let n = 0;
  for (const line of s.split("\n")) if (line.trim()) n++;
  return n;
}

/** Pull the `edits[]` hunks out of a MultiEdit input. */
export function multiEdits(input: JsonValue): { old: string; next: string }[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const edits = (input as Record<string, JsonValue>).edits;
  if (!Array.isArray(edits)) return [];
  return edits.map((e) => ({
    old: field(e, "old_string") ?? "",
    next: field(e, "new_string") ?? "",
  }));
}

/**
 * A compact result summary shown on the step's collapsed row, à la the reference
 * ("+5 −2", "12 résultats"). Edits/Write derive from the INPUT alone (no result
 * needed); Grep/Glob count lines of their result text. `resultText` is the joined
 * tool_result rendered as text, or null while still running / unavailable.
 */
export function stepSummary(
  name: string,
  input: JsonValue,
  resultText: string | null,
): StepSummary {
  switch (name) {
    case "Edit": {
      const c = diffCounts(
        lineDiff(field(input, "old_string") ?? "", field(input, "new_string") ?? ""),
      );
      return { kind: "diff", added: c.added, removed: c.removed };
    }
    case "MultiEdit": {
      let added = 0;
      let removed = 0;
      for (const e of multiEdits(input)) {
        const c = diffCounts(lineDiff(e.old, e.next));
        added += c.added;
        removed += c.removed;
      }
      return { kind: "diff", added, removed };
    }
    case "Write": {
      const content = field(input, "content") ?? "";
      // Trim a single trailing newline so a file ending in "\n" (the common case)
      // isn't counted as one extra line.
      const n = content === "" ? 0 : content.replace(/\n$/, "").split("\n").length;
      return { kind: "text", text: `${n} line${n === 1 ? "" : "s"}` };
    }
    case "Grep":
    case "Glob": {
      if (!resultText) return null;
      const n = countNonEmptyLines(resultText);
      return { kind: "text", text: `${n} result${n === 1 ? "" : "s"}` };
    }
    default:
      return null;
  }
}

/** Basename of the step's primary file argument (for the clickable file chip), if any. */
export function stepFilePath(input: JsonValue): string | null {
  return field(input, "file_path") ?? null;
}

export { basename };

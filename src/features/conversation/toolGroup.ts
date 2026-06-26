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
 *
 * `includeBackground` keeps the normally-hidden background tools (Monitor, detached
 * `run_in_background` Bash) as inline steps. The LIVE main thread leaves it false —
 * those tools live in pinned bars (MonitorBar / BashBar). The off-thread disk
 * transcript (SubAgentTranscript) sets it true: it has NO live bar to compensate, so
 * hiding them there would silently drop the only record of those calls.
 */
export function groupBlocks(
  blocks: NormalizedBlock[],
  includeBackground = false,
): Segment[] {
  const out: Segment[] = [];
  let run: ToolStep[] | null = null;

  blocks.forEach((b, i) => {
    if (b.type === "tool_use") {
      // Live thread: hide everything `isHiddenInline` covers (a pinned bar shows the
      // background ones). Disk transcript (includeBackground): keep background tools as
      // steps — no bar compensates there — but `toolMeta`-suppressed tools (TodoWrite,
      // ide_ RPC) are noise everywhere and stay hidden.
      if (includeBackground) {
        if (toolMeta(b.name, b.input).suppressed) return;
      } else if (isHiddenInline(b.name, b.input)) {
        return; // invisible: no step, no break
      }
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

/**
 * Split a round's segments into the intermediate WORK and the FINAL message, for the
 * "collapse work" display mode. The final message = the trailing run of `text` segments
 * (the agent's closing prose); everything before it is work to fold. An intermediate
 * `text` separated from the end by a tool run stays in `work`.
 *
 *  - work + final  → fold `work` behind one block, show `final` in clear.
 *  - only final (no work)        → `work` empty: render the message bare, no block.
 *  - only work (no trailing text) → `final` empty: the caller decides (e.g. don't fold
 *    a settled round that ends on tools — see AssistantBlocks).
 */
export function splitFinalMessage(segments: Segment[]): {
  work: Segment[];
  final: Segment[];
} {
  let i = segments.length;
  while (i > 0 && segments[i - 1].kind === "text") i--;
  return { work: segments.slice(0, i), final: segments.slice(i) };
}

// ---- Clean-output folding (live, running-aware) ----------------------------
// A round's work flattens to ATOMS (one per tool step / thinking / prose / sub-agent) so
// the live fold can be decided per item: settled work folds into the block, while the
// sliding window AND any still-running tool stay visible. The kept atoms reconstruct back
// into segments for rendering.

export type WorkAtom =
  | { kind: "step"; key: string; step: ToolStep }
  | { kind: "agent"; key: string; step: ToolStep }
  | { kind: "thinking"; key: string; text: string }
  | { kind: "text"; key: string; text: string };

/** Flatten work segments into per-item atoms (a run → one atom per step). */
export function flattenWork(segs: Segment[]): WorkAtom[] {
  const out: WorkAtom[] = [];
  for (const seg of segs) {
    if (seg.kind === "run") {
      for (const step of seg.steps) out.push({ kind: "step", key: `${seg.key}-${step.id}`, step });
    } else if (seg.kind === "agent") {
      out.push({ kind: "agent", key: seg.key, step: seg.step });
    } else if (seg.kind === "thinking") {
      out.push({ kind: "thinking", key: seg.key, text: seg.text });
    } else {
      out.push({ kind: "text", key: seg.key, text: seg.text });
    }
  }
  return out;
}

/** Reconstruct segments from atoms, re-coalescing consecutive steps into runs. `keyPrefix`
 *  keeps reconstructed run keys stable per call-site (the visible vs the folded side), so a
 *  run section isn't remounted as the fold boundary slides. */
export function atomsToSegments(atoms: WorkAtom[], keyPrefix: string): Segment[] {
  const out: Segment[] = [];
  let run: ToolStep[] | null = null;
  let runOrd = 0;
  for (const a of atoms) {
    if (a.kind === "step") {
      if (!run) {
        run = [];
        out.push({ kind: "run", key: `${keyPrefix}-run-${runOrd++}`, steps: run });
      }
      run.push(a.step);
      continue;
    }
    run = null;
    if (a.kind === "agent") out.push({ kind: "agent", key: a.key, step: a.step });
    else if (a.kind === "thinking") out.push({ kind: "thinking", key: a.key, text: a.text });
    else out.push({ kind: "text", key: a.key, text: a.text });
  }
  return out;
}

/**
 * The atom index from which work stays VISIBLE in clean-output LIVE mode; everything before
 * folds into the block. The visible (trailing) region covers BOTH:
 *  - the sliding window: the last `window` tool steps, and
 *  - every still-running tool — a running command / sub-agent stays live even past the
 *    window, and only folds once it finishes.
 * Running tools sit at the trailing edge (nothing settles after an unsettled call), so the
 * visible region is always a trailing slice — `min(firstRunning, windowStart)`.
 */
export function liveVisibleStart(
  atoms: WorkAtom[],
  isRunning: (id: string) => boolean,
  window: number,
): number {
  let runningStart = atoms.length;
  for (let i = 0; i < atoms.length; i++) {
    const a = atoms[i];
    if ((a.kind === "step" || a.kind === "agent") && isRunning(a.step.id)) {
      runningStart = i;
      break;
    }
  }
  let windowStart = atoms.length;
  let steps = 0;
  for (let i = atoms.length - 1; i >= 0; i--) {
    windowStart = i;
    if (atoms[i].kind === "step") {
      steps++;
      if (steps >= window) break;
    }
  }
  return Math.min(runningStart, windowStart);
}

/** How many "étapes" a stretch of work represents, for the "Travail de Claude — N
 *  étapes" header: every tool step across its runs. Prose and thinking are not counted as
 *  steps (and sub-agents render inline, not inside a block). */
export function countWorkSteps(segments: Segment[]): number {
  let n = 0;
  for (const s of segments) {
    if (s.kind === "run") n += s.steps.length;
  }
  return n;
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

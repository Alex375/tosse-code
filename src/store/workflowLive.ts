// Live, per-phase agent activity for a running workflow, ACCUMULATED from the wire.
//
// Why this exists: the rich manifest (per-phase agents + metrics) is written by the CLI only
// when the run ENDS. During the run the ONLY structured signal is the wire's `task_progress`
// ("<phase>: <label>", emitted once per agent SPAWN). The background-task snapshot keeps just
// the LATEST progress (replace-by-id), so to know how many agents started in EACH phase we
// must accumulate every progress tick here, as it arrives. Combined with the journal's global
// done count (and sequential phases), this drives the per-phase "done/total" the overview shows.
//
// Keyed by a conversation's STABLE id then `task_id` (like backgroundTasksStore). Live-only:
// not persisted, dropped with its conversation.

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { BackgroundTask } from "../ipc/client";

/** One phase's accumulated agent labels (in first-seen order, deduped). */
export interface WfLivePhase {
  title: string;
  labels: string[];
}

export interface WfLive {
  /** Phases in the order they were first seen on the wire, each with its started agents. */
  phases: WfLivePhase[];
}

const EMPTY: WfLive = { phases: [] };

/** Split a `task_progress` description ("<phase>: <label>") into phase + optional label. */
export function parseWfProgress(progress: string): { phase: string; label: string | null } | null {
  const s = progress.trim();
  if (!s) return null;
  const i = s.indexOf(":");
  if (i < 0) return { phase: s, label: null };
  return { phase: s.slice(0, i).trim(), label: s.slice(i + 1).trim() || null };
}

/** Fold one progress tick into a run's accumulated phases. Returns the SAME object when nothing
 *  changed (idempotent re-delivery) so subscribers don't re-render needlessly. */
export function foldProgress(prev: WfLive, progress: string): WfLive {
  const parsed = parseWfProgress(progress);
  if (!parsed) return prev;
  const { phase, label } = parsed;
  const idx = prev.phases.findIndex((p) => p.title === phase);
  if (idx < 0) {
    return { phases: [...prev.phases, { title: phase, labels: label ? [label] : [] }] };
  }
  const cur = prev.phases[idx];
  if (!label || cur.labels.includes(label)) return prev; // no new info
  const phases = prev.phases.slice();
  phases[idx] = { title: cur.title, labels: [...cur.labels, label] };
  return { phases };
}

interface State {
  runs: Record<string, Record<string, WfLive>>;
  /** Record a workflow task's latest `progress` into its accumulated per-phase activity. */
  record: (session: string, task: BackgroundTask) => void;
  /** Forget a conversation's runs (its conversation was deleted). */
  drop: (session: string) => void;
  /** Forget everything (wipe-all). */
  clear: () => void;
}

export const useWorkflowLiveStore = create<State>((set) => ({
  runs: {},
  record: (session, task) =>
    set((s) => {
      if (task.kind !== "workflow") return s;
      const cur = s.runs[session];
      // A finished run no longer needs its live accumulation — the modal reads the manifest
      // from disk once it's done, and the bar drops it. Purge to bound memory (a long
      // conversation chains many runs). Done BEFORE the progress fold so we never re-add it.
      if (task.status !== "running") {
        if (!cur || !(task.task_id in cur)) return s;
        const next = { ...cur };
        delete next[task.task_id];
        return { runs: { ...s.runs, [session]: next } };
      }
      if (!task.progress) return s;
      const map = cur ?? {};
      const prev = map[task.task_id] ?? EMPTY;
      const next = foldProgress(prev, task.progress);
      if (next === prev) return s; // idempotent
      return { runs: { ...s.runs, [session]: { ...map, [task.task_id]: next } } };
    }),
  drop: (session) =>
    set((s) => {
      if (!s.runs[session]) return s;
      const runs = { ...s.runs };
      delete runs[session];
      return { runs };
    }),
  clear: () => set({ runs: {} }),
}));

/** The accumulated live activity for one workflow run (stable empty fallback). */
export const useWorkflowLive = (session: string, taskId: string): WfLive =>
  useWorkflowLiveStore(useShallow((s) => s.runs[session]?.[taskId] ?? EMPTY));

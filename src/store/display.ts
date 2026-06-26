// User preferences for how the conversation transcript is displayed. Pure UI prefs,
// persisted to localStorage (same lightweight pattern as notifications.ts) rather
// than the Rust core — they are not domain data, so they don't belong in the SQLite
// metadata store.
import { create } from "zustand";

const STORAGE_KEY = "tosse:display";

export interface DisplayPrefs {
  /** "Clean output": fold an assistant response's intermediate work (tool runs, thinking,
   *  in-between narration, sub-agents) into ONE collapsible "Travail de Claude — N étapes"
   *  block, so only the response's CONCLUDING message stays in clear. Per response, not
   *  globally — each response keeps its own block + concluding message. When a response spans
   *  several turns (the agent narrates between tool batches), only its LAST message stays in
   *  clear; the in-between narration folds with the work — that's the point of the condensed
   *  view. See ConductorThread/CleanBlocks. */
  cleanOutput: boolean;
}

// Off by default: the transcript shows everything inline as before. The user opts in
// (Settings → Général, or the composer chip) when they want the condensed reading view.
const DEFAULTS: DisplayPrefs = {
  cleanOutput: false,
};

function load(): DisplayPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    // Merge over defaults so a newly-added pref defaults sanely for users who already
    // have a stored (older, smaller) prefs object.
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<DisplayPrefs>) };
  } catch {
    return DEFAULTS;
  }
}

function save(prefs: DisplayPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* quota / disabled storage — best-effort, ignore */
  }
}

interface DisplayState extends DisplayPrefs {
  /** Patch one or more prefs and persist. */
  set: (patch: Partial<DisplayPrefs>) => void;
}

export const useDisplay = create<DisplayState>((set) => ({
  ...load(),
  set: (patch) =>
    set((s) => {
      const next: DisplayPrefs = {
        cleanOutput: patch.cleanOutput ?? s.cleanOutput,
      };
      save(next);
      return next;
    }),
}));

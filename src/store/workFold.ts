// Open/collapsed state of the "Travail de Claude" fold blocks (clean-output mode),
// keyed by conversation id → round key → open. Persisted to localStorage with the
// same lightweight pattern as display.ts / notifications.ts (not the SQLite metadata
// store — this is pure UI state, so it stays out of the Rust core, no schema migration).
//
// Why a store and not a plain React useState in ClaudeWorkBlock: the conversation pane
// is remounted per conversation (`key={conv.id}` in ConductorConversation), so any local
// component state resets when you switch away and come back — the fold you opened would
// snap shut. A Zustand store is global and survives that remount, so the fold state
// persists across a conversation switch; localStorage additionally carries it across app
// restarts. Round keys are the assistant round's stable turn id (from the transcript,
// stable across reloads), so a persisted entry re-associates with the right block on
// return; an orphaned key just falls back to collapsed (the default), which is harmless.
import { create } from "zustand";

const STORAGE_KEY = "tosse:workfold";

// convId → roundKey → open. Absent = collapsed (the default), so we only ever store
// entries the user actually touched.
type FoldMap = Record<string, Record<string, boolean>>;

function load(): FoldMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as FoldMap) : {};
  } catch {
    return {};
  }
}

function save(map: FoldMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* quota / disabled storage — best-effort, ignore */
  }
}

interface WorkFoldState {
  open: FoldMap;
  /** Flip one block's open state (per conversation + round). Persisted. */
  toggle: (conv: string, key: string) => void;
  /** Forget one conversation's fold state — wired into removeConversation/removeRepo,
   *  same as the other per-conversation UI caches (composer draft, todo bar). */
  clearConversation: (conv: string) => void;
  /** Drop every remembered fold state — wired into "Tout supprimer" (wipeAllData). */
  clearAll: () => void;
}

export const useWorkFold = create<WorkFoldState>((set) => ({
  open: load(),
  toggle: (conv, key) =>
    set((s) => {
      const convMap = s.open[conv] ?? {};
      const next: FoldMap = { ...s.open, [conv]: { ...convMap, [key]: !convMap[key] } };
      save(next);
      return { open: next };
    }),
  clearConversation: (conv) =>
    set((s) => {
      if (!(conv in s.open)) return s;
      const next = { ...s.open };
      delete next[conv];
      save(next);
      return { open: next };
    }),
  clearAll: () =>
    set(() => {
      save({});
      return { open: {} };
    }),
}));

/** Subscribe to one fold block's open state (default collapsed). */
export const useWorkFoldOpen = (conv: string, key: string): boolean =>
  useWorkFold((s) => s.open[conv]?.[key] ?? false);

/** Imperative clears for non-React callers (conversationsStore removal / wipe). */
export function clearWorkFold(conv: string): void {
  useWorkFold.getState().clearConversation(conv);
}
export function clearAllWorkFold(): void {
  useWorkFold.getState().clearAll();
}

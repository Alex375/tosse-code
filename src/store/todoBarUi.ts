// Per-conversation open/collapsed state of the agent to-do panel (<TodoBar>).
// A pure UI preference keyed by the conversation's STABLE id (conv.id) — never the
// live session handle (`session-N`, remapped on every resume) — so closing the
// panel on one conversation and coming back later keeps it closed, and reopening
// it sticks too.
//
// Persisted to localStorage (same lightweight pattern as notifications/
// commandsStore) rather than the Rust core: it's a UI pref, not domain data, so it
// stays out of the SQLite metadata store and survives an app restart for free.
import { create } from "zustand";

const STORAGE_KEY = "tosse:todobar-open";

/** convId → is the panel open? An absent entry means "never toggled". */
type OpenMap = Record<string, boolean>;

function load(): OpenMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    // Keep only boolean entries — defends against a malformed/older payload.
    const out: OpenMap = {};
    for (const [convId, open] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof open === "boolean") out[convId] = open;
    }
    return out;
  } catch {
    return {};
  }
}

function save(map: OpenMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* quota / disabled storage — best-effort, ignore */
  }
}

interface TodoBarUiState {
  /** convId → panel open? An absent entry defaults to open (see useTodoBarOpen). */
  open: OpenMap;
  /** Persist the open/collapsed state for one conversation. */
  setOpen: (convId: string, open: boolean) => void;
}

export const useTodoBarUi = create<TodoBarUiState>((set) => ({
  open: load(),
  setOpen: (convId, open) =>
    set((s) => {
      const next: OpenMap = { ...s.open, [convId]: open };
      save(next);
      return { open: next };
    }),
}));

/**
 * Is the to-do panel open for this conversation? Defaults to open (true) when the
 * user has never toggled it — matching the panel's original always-open behaviour.
 */
export function useTodoBarOpen(convId: string): boolean {
  return useTodoBarUi((s) => s.open[convId] ?? true);
}

/** Forget one conversation's stored open/collapsed state — call when it's deleted so
 *  neither localStorage nor the in-memory map accumulates orphan entries. No-op if
 *  nothing was stored for it. Mirrors contextWindowCache.clearCachedWindow. */
export function clearTodoBarOpen(convId: string): void {
  const cur = useTodoBarUi.getState().open;
  if (!(convId in cur)) return;
  const next: OpenMap = { ...cur };
  delete next[convId];
  save(next);
  useTodoBarUi.setState({ open: next });
}

/** Drop every stored open/collapsed state — call on a full data wipe ("Tout
 *  supprimer"). Mirrors contextWindowCache.clearAllCachedWindows. */
export function clearAllTodoBarOpen(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* disabled storage — best-effort, ignore */
  }
  useTodoBarUi.setState({ open: {} });
}

// Collapsed state of the sidebar's per-repo conversation groups, keyed by repo id.
// Persisted to localStorage with the same lightweight pattern as workFold.ts /
// display.ts / notifications.ts (not the SQLite metadata store — this is pure UI
// state, so it stays out of the Rust core, no schema migration).
//
// Default = expanded, so we only ever store the repos the user actually collapsed.
// An orphaned id (repo removed elsewhere) just sits harmlessly in the set until
// removeRepo purges it (clearSidebarFold), mirroring the other per-repo UI caches.
import { create } from "zustand";

const STORAGE_KEY = "tosse:sidebarfold";

function load(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? new Set(parsed.filter((x): x is string => typeof x === "string")) : new Set();
  } catch {
    return new Set();
  }
}

function save(collapsed: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...collapsed]));
  } catch {
    /* quota / disabled storage — best-effort, ignore */
  }
}

interface SidebarFoldState {
  /** Repo ids whose conversation group is collapsed. Absent = expanded (default). */
  collapsed: Set<string>;
  /** Flip one repo's collapsed state. Persisted. */
  toggle: (repoId: string) => void;
  /** Forget one repo's collapsed state — wired into removeRepo, like the other caches. */
  clearRepo: (repoId: string) => void;
  /** Drop every remembered collapse — wired into "Tout supprimer" (wipeAllData). */
  clearAll: () => void;
}

export const useSidebarFold = create<SidebarFoldState>((set) => ({
  collapsed: load(),
  toggle: (repoId) =>
    set((s) => {
      // New Set each time so Zustand's `has`-based selectors re-render.
      const next = new Set(s.collapsed);
      if (next.has(repoId)) next.delete(repoId);
      else next.add(repoId);
      save(next);
      return { collapsed: next };
    }),
  clearRepo: (repoId) =>
    set((s) => {
      if (!s.collapsed.has(repoId)) return s;
      const next = new Set(s.collapsed);
      next.delete(repoId);
      save(next);
      return { collapsed: next };
    }),
  clearAll: () =>
    set(() => {
      save(new Set());
      return { collapsed: new Set() };
    }),
}));

/** Subscribe to one repo's collapsed state (default expanded → false). */
export const useRepoCollapsed = (repoId: string): boolean =>
  useSidebarFold((s) => s.collapsed.has(repoId));

/** Imperative clears for non-React callers (conversationsStore removal / wipe). */
export function clearSidebarFold(repoId: string): void {
  useSidebarFold.getState().clearRepo(repoId);
}
export function clearAllSidebarFold(): void {
  useSidebarFold.getState().clearAll();
}

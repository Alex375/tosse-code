// Shared selection state for the Git workspace, per conversation. In the 2x2
// layout the commit list (bottom-left), the changed-files list (bottom-right)
// and the diff (top-right) live in separate corners of the window, so their
// shared selection (active tab, selected commit, selected file) can't sit in one
// component's useState anymore — it lives here. In-memory only (like the editor's
// per-conversation slice); selection resets on reload, which is fine.

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

export type GitTab = "history" | "changes";

export interface ConvGitView {
  /** Active tab of the Git strip. History is the default (a history browser). */
  tab: GitTab;
  /** Selected commit oid (history tab) → drives the changed-files list. */
  selectedOid: string | null;
  /** Selected file within the selected commit (history tab) → drives the diff. */
  selectedHistoryFile: string | null;
  /** Selected working-tree file (changes tab) → drives the diff. */
  selectedChangePath: string | null;
}

const EMPTY: ConvGitView = {
  tab: "history",
  selectedOid: null,
  selectedHistoryFile: null,
  selectedChangePath: null,
};

interface GitViewState {
  byConv: Record<string, ConvGitView>;
  setTab: (convId: string, tab: GitTab) => void;
  /** Pick a commit (history tab); resets the per-commit file selection. */
  selectCommit: (convId: string, oid: string | null) => void;
  selectHistoryFile: (convId: string, path: string | null) => void;
  selectChangePath: (convId: string, path: string | null) => void;
  /** Drop a conversation's slice (on conversation/repo removal). */
  clear: (convId: string) => void;
  /** Drop every slice (on full data wipe). */
  clearAll: () => void;
}

export const useGitViewStore = create<GitViewState>((set) => {
  const patch = (convId: string, fn: (v: ConvGitView) => ConvGitView) =>
    set((s) => ({ byConv: { ...s.byConv, [convId]: fn(s.byConv[convId] ?? EMPTY) } }));

  return {
    byConv: {},
    setTab: (convId, tab) => patch(convId, (v) => ({ ...v, tab })),
    // Re-selecting the SAME commit is a no-op, so re-clicking the current row
    // never discards the user's chosen file (the reset only fires on a change).
    selectCommit: (convId, oid) =>
      patch(convId, (v) =>
        v.selectedOid === oid ? v : { ...v, selectedOid: oid, selectedHistoryFile: null },
      ),
    selectHistoryFile: (convId, path) => patch(convId, (v) => ({ ...v, selectedHistoryFile: path })),
    selectChangePath: (convId, path) => patch(convId, (v) => ({ ...v, selectedChangePath: path })),
    clear: (convId) =>
      set((s) => {
        if (!s.byConv[convId]) return s;
        const next = { ...s.byConv };
        delete next[convId];
        return { byConv: next };
      }),
    clearAll: () => set({ byConv: {} }),
  };
});

/** A conversation's Git-view slice (defaulted), re-rendering only on its changes. */
export const useConvGitView = (convId: string): ConvGitView =>
  useGitViewStore(useShallow((s) => s.byConv[convId] ?? EMPTY));

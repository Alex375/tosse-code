// Which repo's worktree manager is open, if any. A tiny shared slice so both the
// top-right indicator (in the conversation header) and the per-conversation
// sidebar badge can open the same manager for a given repo.
import { create } from "zustand";

interface WorktreeUiState {
  /** Repo id whose worktree manager is open, or null when closed. */
  managerRepoId: string | null;
  openManager: (repoId: string) => void;
  closeManager: () => void;
}

export const useWorktreeUi = create<WorktreeUiState>((set) => ({
  managerRepoId: null,
  openManager: (repoId) => set({ managerRepoId: repoId }),
  closeManager: () => set({ managerRepoId: null }),
}));

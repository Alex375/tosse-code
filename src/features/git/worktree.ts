// Pure helpers for mapping a conversation to its worktree and labelling it.
// No React, no IPC — just logic over a WorktreeInfo[] and a cwd, so it is easy
// to reason about and reuse (indicator, sidebar badge, manager all share it).

import type { SessionStatePayload, WorktreeInfo } from "../../ipc/client";

const stripSlash = (p: string) => p.replace(/\/+$/, "");

/**
 * The directory a conversation is in RIGHT NOW, most specific first:
 *  - `liveCwd`: a worktree the agent moved into via EnterWorktree (parsed from
 *    its result) — overrides everything until ExitWorktree;
 *  - the live session's reported cwd (system/init);
 *  - the spawn cwd (when nothing live is known).
 */
export function effectiveCwd(
  conv: { cwd: string; liveCwd: string | null },
  state: SessionStatePayload | undefined,
): string {
  return conv.liveCwd ?? state?.cwd ?? conv.cwd;
}

/**
 * The worktree a conversation works in, resolved from its `cwd`. A conversation's
 * `claude` process is spawned with a fixed cwd, so that cwd's worktree IS the one
 * it lives in for its whole life. We match by longest path prefix: the worktree
 * whose path equals the cwd, or contains it (cwd is inside that working tree).
 * Returns null when nothing matches (e.g. a relative "." cwd, or a path outside
 * every listed worktree).
 */
export function resolveWorktree(
  cwd: string,
  worktrees: WorktreeInfo[],
): WorktreeInfo | null {
  const c = stripSlash(cwd);
  let best: WorktreeInfo | null = null;
  let bestLen = -1;
  for (const w of worktrees) {
    if (w.is_bare) continue;
    const wp = stripSlash(w.path);
    if (c === wp || c.startsWith(wp + "/")) {
      if (wp.length > bestLen) {
        best = w;
        bestLen = wp.length;
      }
    }
  }
  return best;
}

/** The repository's main worktree, if present. */
export function mainWorktree(worktrees: WorktreeInfo[]): WorktreeInfo | null {
  return worktrees.find((w) => w.is_main) ?? null;
}

/** Short display label for a worktree: its branch, else a short detached HEAD. */
export function worktreeLabel(w: WorktreeInfo): string {
  if (w.branch) return w.branch;
  if (w.is_detached && w.head) return w.head.slice(0, 7);
  return "détaché";
}

/** The worktree's own name = the basename of its directory (not the full path). */
export function worktreeName(w: WorktreeInfo): string {
  const parts = w.path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || w.path;
}

/** A linked (non-main) worktree — the case that earns a sidebar badge. */
export function isLinked(w: WorktreeInfo): boolean {
  return !w.is_main && !w.is_bare;
}

// TanStack Query wrappers around the git history / source-control IPC commands.
// Everything is keyed by the conversation's LIVE cwd (the worktree the user is
// looking at), under a shared ["git", cwd] prefix so a single call invalidates
// the whole panel after a write.
//
// Reads are queries (status / log / branches / diffs); commit + push/pull/fetch
// are mutations that invalidate the prefix. `useGitAutoRefresh` additionally
// re-pulls status + diffs whenever the fs watcher reports a working-tree change,
// so editing a file is reflected without a manual refresh.

import { useEffect } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { commands, events } from "./client";
import type {
  BranchInfo,
  CommitFile,
  CommitInfo,
  GitDiff,
  GitFileEntry,
  GitStatus,
  Result,
} from "./client";

/** Throw on the Result.error branch so query/mutation error state is populated. */
async function unwrap<T>(p: Promise<Result<T, string>>): Promise<T> {
  const res = await p;
  if (res.status === "error") throw new Error(res.error);
  return res.data;
}

/** Shared key prefix — invalidating it refreshes the whole panel for a cwd. */
export const gitKey = (cwd: string | null) => ["git", cwd] as const;

/** How many commits one history page loads. */
export const LOG_PAGE_SIZE = 200;

/** Working-tree status (branch, ahead/behind, changed files). */
export function useGitStatus(cwd: string | null) {
  return useQuery({
    queryKey: ["git", cwd, "status"] as const,
    enabled: !!cwd,
    queryFn: () => unwrap(commands.gitStatus(cwd!)),
    staleTime: 2_000,
  });
}

/** Local + remote-tracking branches. */
export function useGitBranches(cwd: string | null) {
  return useQuery({
    queryKey: ["git", cwd, "branches"] as const,
    enabled: !!cwd,
    queryFn: () => unwrap(commands.gitBranches(cwd!)),
    staleTime: 5_000,
  });
}

/**
 * Paginated commit history across all refs. Pages of [`LOG_PAGE_SIZE`]; the next
 * page loads only when the user scrolls to the end (`fetchNextPage`). Flatten
 * `data.pages` for the full ordered list.
 */
export function useGitLog(cwd: string | null) {
  return useInfiniteQuery({
    queryKey: ["git", cwd, "log"] as const,
    enabled: !!cwd,
    queryFn: ({ pageParam }) => unwrap(commands.gitLog(cwd!, LOG_PAGE_SIZE, pageParam)),
    initialPageParam: 0,
    // Next skip = commits loaded so far; stop once a short page comes back.
    getNextPageParam: (last, all) =>
      last.length < LOG_PAGE_SIZE ? undefined : all.reduce((n, p) => n + p.length, 0),
    staleTime: 5_000,
  });
}

/**
 * Diff of one working-tree file vs HEAD (for the changes view). `origPath` is the
 * rename source (when the file was renamed), so the "before" side reads from the
 * old path instead of rendering as fully added.
 */
export function useGitDiff(
  cwd: string | null,
  path: string | null,
  origPath: string | null = null,
) {
  return useQuery({
    queryKey: ["git", cwd, "diff", path, origPath] as const,
    enabled: !!cwd && !!path,
    queryFn: () => unwrap(commands.gitDiff(cwd!, path!, origPath)),
    staleTime: 2_000,
  });
}

/** Files changed by a commit (for the history detail pane). */
export function useCommitFiles(cwd: string | null, oid: string | null) {
  return useQuery({
    queryKey: ["git", cwd, "commit-files", oid] as const,
    enabled: !!cwd && !!oid,
    queryFn: () => unwrap(commands.gitCommitFiles(cwd!, oid!)),
    staleTime: 60_000, // a commit's contents never change
  });
}

/**
 * Diff of one file introduced by a commit (old = parent, new = commit). `origPath`
 * is the rename source so the "before" side reads the old path at the parent.
 */
export function useCommitFileDiff(
  cwd: string | null,
  oid: string | null,
  path: string | null,
  origPath: string | null = null,
) {
  return useQuery({
    queryKey: ["git", cwd, "commit-diff", oid, path, origPath] as const,
    enabled: !!cwd && !!oid && !!path,
    queryFn: () => unwrap(commands.gitCommitFileDiff(cwd!, oid!, path!, origPath)),
    staleTime: 60_000,
  });
}

/** Stage all + commit; refreshes the whole panel on success. */
export function useGitCommit(cwd: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (message: string): Promise<string> => unwrap(commands.gitCommit(cwd!, message)),
    onSuccess: () => qc.invalidateQueries({ queryKey: gitKey(cwd) }),
  });
}

/** Run a remote-sync action (push/pull/fetch); refreshes the panel on success. */
export function useGitSync(cwd: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: "push" | "pull" | "fetch"): Promise<null> =>
      unwrap(
        action === "push"
          ? commands.gitPush(cwd!)
          : action === "pull"
            ? commands.gitPull(cwd!)
            : commands.gitFetch(cwd!),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: gitKey(cwd) }),
  });
}

/**
 * Re-pull status + open diffs whenever the fs watcher reports a working-tree
 * change (the watcher already debounces and ignores `.git`/`node_modules`).
 * Commit history and branches don't change on a file save, so they're left to
 * window-focus refetch + the write mutations — keeping a save cheap.
 */
export function useGitAutoRefresh(cwd: string | null) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!cwd) return;
    let off: (() => void) | undefined;
    let disposed = false;
    void events.fsChangeEvent
      .listen(() => {
        qc.invalidateQueries({ queryKey: ["git", cwd, "status"] });
        qc.invalidateQueries({ queryKey: ["git", cwd, "diff"] });
      })
      .then((unlisten) => {
        if (disposed) unlisten();
        else off = unlisten;
      });
    return () => {
      disposed = true;
      off?.();
    };
  }, [cwd, qc]);
}

export type { BranchInfo, CommitFile, CommitInfo, GitDiff, GitFileEntry, GitStatus };

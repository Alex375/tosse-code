// The diff area (top/middle of the Git workspace). Reads the shared selection and
// shows the right diff: a commit-file diff (history tab) or a working-tree diff
// (changes tab). Both query hooks are always called (rules of hooks); the
// inactive one is disabled by passing null, so only one ever runs.
//
// For a renamed file the "before" side must come from the OLD path — we look the
// rename source up from the already-loaded file lists (deduped by React Query)
// and thread it through so a rename doesn't render as fully added.

import { useCommitFileDiff, useCommitFiles, useGitDiff, useGitStatus } from "../../ipc/useGit";
import { useConvGitView } from "./gitViewStore";
import { DiffSlot } from "./DiffSlot";

export function DiffPane({ cwd, convId }: { cwd: string; convId: string }) {
  const { tab, selectedOid, selectedHistoryFile, selectedChangePath } = useConvGitView(convId);
  const isHistory = tab === "history";

  // Rename source for the selected file, from the lists the strip already loaded.
  const status = useGitStatus(cwd);
  const commitFiles = useCommitFiles(cwd, isHistory ? selectedOid : null);
  const origForHistory =
    isHistory && selectedHistoryFile
      ? (commitFiles.data?.find((f) => f.path === selectedHistoryFile)?.orig_path ?? null)
      : null;
  const origForChange =
    !isHistory && selectedChangePath
      ? (status.data?.files.find((f) => f.path === selectedChangePath)?.orig_path ?? null)
      : null;

  const commitDiff = useCommitFileDiff(
    cwd,
    isHistory ? selectedOid : null,
    isHistory ? selectedHistoryFile : null,
    origForHistory,
  );
  const worktreeDiff = useGitDiff(cwd, isHistory ? null : selectedChangePath, origForChange);

  const path = isHistory ? selectedHistoryFile : selectedChangePath;
  const q = isHistory ? commitDiff : worktreeDiff;

  return (
    <DiffSlot
      path={path}
      diff={q.data}
      loading={q.isLoading}
      error={q.error ? (q.error as Error).message : null}
      emptyHint={isHistory ? "Select a commit file" : "Select a changed file"}
    />
  );
}

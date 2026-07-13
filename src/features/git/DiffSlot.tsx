// The shared diff region of the Git panel. Both the changes view and the history
// view hand it a `GitDiff` (or loading/empty state) and it owns the placeholder
// logic + the lazy Monaco diff editor. Only one DiffSlot is mounted at a time
// (one tab shows), so there is at most one diff-editor instance live.

import { lazy, Suspense } from "react";
import type { GitDiff } from "../../ipc/useGit";
import styles from "./git.module.css";

// Heavy (Monaco) — its own chunk, off the startup bundle, like MonacoView.
const RibbonDiff = lazy(() => import("./RibbonDiff"));

interface Props {
  /** Selected path, or null when nothing is picked yet. */
  path: string | null;
  diff: GitDiff | undefined;
  loading: boolean;
  error?: string | null;
  /** Hint shown when no path is selected. */
  emptyHint?: string;
}

export function DiffSlot({ path, diff, loading, error, emptyHint }: Props) {
  let body: React.ReactNode;
  if (!path) {
    body = (
      <div className={styles.diffPlaceholder}>{emptyHint ?? "Select a file"}</div>
    );
  } else if (error) {
    body = <div className={styles.error}>{error}</div>;
  } else if (loading || !diff) {
    body = <div className={styles.diffPlaceholder}>Loading diff…</div>;
  } else if (diff.is_binary) {
    body = <div className={styles.diffPlaceholder}>Binary file — diff not shown</div>;
  } else {
    body = (
      <Suspense fallback={<div className={styles.diffPlaceholder}>Loading editor…</div>}>
        <RibbonDiff path={path} oldText={diff.old_text ?? ""} newText={diff.new_text ?? ""} />
      </Suspense>
    );
  }

  return (
    <div className={styles.diffSlot}>
      {path ? (
        <div className={styles.diffBar}>
          <span className={styles.diffBarPath}>{path}</span>
          {diff ? (
            <span className={styles.diffBarLabels}>
              {diff.old_label} → {diff.new_label}
            </span>
          ) : null}
        </div>
      ) : null}
      {body}
    </div>
  );
}

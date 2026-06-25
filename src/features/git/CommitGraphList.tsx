// The commit history + graph (bottom-left of the Git workspace, history tab).
// Scrolls VERTICALLY; ref badges are capped and the row clips so a HEAD decorated
// with many worktree branches never forces a horizontal scrollbar. Selection is
// shared via gitViewStore so the file list + diff (elsewhere on screen) follow.

import { useMemo } from "react";
import { useGitLog } from "../../ipc/useGit";
import type { CommitInfo } from "../../ipc/useGit";
import { useConvGitView, useGitViewStore } from "./gitViewStore";
import { computeGraph } from "./graph";
import { GitGraph, GRAPH_COL, GRAPH_ROW_H } from "./GitGraph";
import styles from "./git.module.css";

// How many ref badges to show before collapsing the rest into a "+N" chip.
const MAX_REFS = 2;

function fmtDate(tsSeconds: number): string {
  return new Date(tsSeconds * 1000).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function RefBadge({ name }: { name: string }) {
  if (name.startsWith("tag: ")) {
    return <span className={`${styles.refBadge} ${styles.refTag}`}>{name.slice(5)}</span>;
  }
  const isHead = name === "HEAD";
  return <span className={`${styles.refBadge} ${isHead ? styles.refHead : ""}`}>{name}</span>;
}

export function CommitGraphList({ cwd, convId }: { cwd: string; convId: string }) {
  const log = useGitLog(cwd);
  const { selectedOid } = useConvGitView(convId);
  const selectCommit = useGitViewStore((s) => s.selectCommit);

  const commits: CommitInfo[] = useMemo(() => log.data?.pages.flat() ?? [], [log.data]);
  const graph = useMemo(() => computeGraph(commits), [commits]);
  const gutterWidth = graph.width * GRAPH_COL;

  if (log.error) {
    return <div className={styles.error}>{(log.error as Error).message}</div>;
  }
  if (commits.length === 0) {
    return (
      <div className={styles.empty}>
        {log.isLoading ? "Lecture de l'historique…" : "Aucun commit."}
      </div>
    );
  }

  return (
    <div className={styles.commitList}>
      {commits.map((c, i) => {
        const shown = c.refs.slice(0, MAX_REFS);
        const extra = c.refs.length - shown.length;
        return (
          <button
            key={c.oid}
            type="button"
            className={`${styles.commitRow} ${selectedOid === c.oid ? styles.commitRowSel : ""}`}
            onClick={() => selectCommit(convId, c.oid)}
            title={c.oid}
          >
            <span className={styles.graphGutter} style={{ width: gutterWidth }}>
              <GitGraph row={graph.rows[i]} width={graph.width} />
            </span>
            <span className={styles.commitText} style={{ height: GRAPH_ROW_H }}>
              <span className={styles.commitSubjectLine}>
                {shown.map((r) => (
                  <RefBadge key={r} name={r} />
                ))}
                {extra > 0 ? <span className={styles.refBadge}>+{extra}</span> : null}
                <span className={styles.commitSubject}>{c.subject}</span>
              </span>
              <span className={styles.commitSub}>
                <span className={styles.commitOid}>{c.short_oid}</span>
                <span className={styles.commitAuthor}>{c.author_name}</span>
                <span>{fmtDate(c.timestamp)}</span>
              </span>
            </span>
          </button>
        );
      })}
      {log.hasNextPage ? (
        <button
          type="button"
          className={styles.loadMore}
          disabled={log.isFetchingNextPage}
          onClick={() => log.fetchNextPage()}
        >
          {log.isFetchingNextPage ? "Chargement…" : "Charger plus de commits"}
        </button>
      ) : null}
    </div>
  );
}

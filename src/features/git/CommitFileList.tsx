// Files changed by the selected commit (bottom-right of the Git workspace,
// history tab). Picking a commit (in the graph list) fills this; picking a FILE
// here opens its diff (top-right) — all via gitViewStore. No auto-selection: the
// diff stays closed until the user clicks a file.

import { useCommitFiles, useGitLog } from "../../ipc/useGit";
import { useConvGitView, useGitViewStore } from "./gitViewStore";
import { badgeClass, splitPath } from "./fileMeta";
import styles from "./git.module.css";

function fmtDate(tsSeconds: number): string {
  return new Date(tsSeconds * 1000).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function CommitFileList({ cwd, convId }: { cwd: string; convId: string }) {
  const { selectedOid, selectedHistoryFile } = useConvGitView(convId);
  const selectHistoryFile = useGitViewStore((s) => s.selectHistoryFile);
  const files = useCommitFiles(cwd, selectedOid);
  // The commit's metadata is already loaded by the log; find it for the header.
  const log = useGitLog(cwd);
  const commit = log.data?.pages.flat().find((c) => c.oid === selectedOid) ?? null;

  if (!selectedOid) {
    return <div className={styles.empty}>Sélectionne un commit à gauche.</div>;
  }

  return (
    <div className={styles.detail}>
      {commit ? (
        <div className={styles.detailHead}>
          <div className={styles.detailSubject}>{commit.subject}</div>
          <div className={styles.detailMeta}>
            <span className={styles.commitOid}>{commit.short_oid}</span>
            <span>{commit.author_name}</span>
            <span>{fmtDate(commit.timestamp)}</span>
            {commit.parents.length > 1 ? <span>merge</span> : null}
          </div>
        </div>
      ) : null}

      {files.error ? (
        <div className={styles.error}>{(files.error as Error).message}</div>
      ) : files.data && files.data.length > 0 ? (
        <div className={styles.fileListFull}>
          {files.data.map((f) => {
            const { name, dir } = splitPath(f.path);
            return (
              <button
                key={f.path}
                type="button"
                className={`${styles.fileRow} ${selectedHistoryFile === f.path ? styles.fileRowSel : ""}`}
                style={{ position: "relative" }}
                onClick={() => selectHistoryFile(convId, f.path)}
                title={f.path}
              >
                <span className={`${styles.badge} ${badgeClass(f.status)}`}>
                  {f.status.charAt(0)}
                </span>
                <span className={styles.fileName}>{name}</span>
                <span className={styles.fileDir}>{dir}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className={styles.empty}>{files.isLoading ? "Lecture…" : "Aucun fichier."}</div>
      )}
    </div>
  );
}

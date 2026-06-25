// Working-tree changed files (bottom-left of the Git workspace, changes tab).
// Picking a file opens its diff vs HEAD (top-right) via gitViewStore. Selection
// stays valid as the set changes (e.g. after a commit).

import { useEffect } from "react";
import { useGitStatus } from "../../ipc/useGit";
import { useConvGitView, useGitViewStore } from "./gitViewStore";
import { badgeClass, splitPath, statusLetter } from "./fileMeta";
import styles from "./git.module.css";

export function ChangesList({ cwd, convId }: { cwd: string; convId: string }) {
  const status = useGitStatus(cwd);
  const { selectedChangePath } = useConvGitView(convId);
  const selectChangePath = useGitViewStore((s) => s.selectChangePath);
  const files = status.data?.files ?? [];

  // Reconcile the selection only once status has actually loaded — otherwise the
  // `?? []` fallback (during first load, a status error, or a cwd switch) looks
  // like an empty tree and would wrongly drop a still-valid selection.
  useEffect(() => {
    if (!status.isSuccess) return;
    if (selectedChangePath && !status.data.files.some((f) => f.path === selectedChangePath)) {
      selectChangePath(convId, null);
    }
  }, [status.isSuccess, status.data, selectedChangePath, convId, selectChangePath]);

  if (status.error) {
    return <div className={styles.error}>{(status.error as Error).message}</div>;
  }
  if (files.length === 0) {
    return (
      <div className={styles.empty}>
        {status.isLoading ? "Lecture du statut…" : "Aucune modification — l'arbre est propre."}
      </div>
    );
  }

  return (
    <div className={styles.commitList}>
      {files.map((f) => {
        const { name, dir } = splitPath(f.path);
        const letter = statusLetter(f);
        return (
          <button
            key={f.path}
            type="button"
            className={`${styles.fileRow} ${selectedChangePath === f.path ? styles.fileRowSel : ""}`}
            style={{ position: "relative" }}
            onClick={() => selectChangePath(convId, f.path)}
            title={f.path}
          >
            <span className={`${styles.badge} ${badgeClass(letter)}`}>{letter}</span>
            <span className={styles.fileName}>{name}</span>
            <span className={styles.fileDir}>{dir}</span>
          </button>
        );
      })}
    </div>
  );
}

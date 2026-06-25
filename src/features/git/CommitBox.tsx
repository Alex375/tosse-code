// Commit + remote sync (bottom-right of the Git workspace, changes tab). A commit
// captures the whole working tree (v1 has no per-file staging). Push/pull/fetch
// surface their errors inline. Branch + ahead/behind shown for context.

import { ArrowDown, ArrowUp, Download, RefreshCw, Upload } from "lucide-react";
import { useState } from "react";
import { useGitCommit, useGitStatus, useGitSync } from "../../ipc/useGit";
import styles from "./git.module.css";

export function CommitBox({ cwd }: { cwd: string }) {
  const status = useGitStatus(cwd);
  const commit = useGitCommit(cwd);
  const sync = useGitSync(cwd);
  const [message, setMessage] = useState("");

  const fileCount = status.data?.files.length ?? 0;
  const branch = status.data?.branch ?? (status.data?.head ? status.data.head.slice(0, 7) : "—");
  const ahead = status.data?.ahead ?? 0;
  const behind = status.data?.behind ?? 0;
  const spinning = (a: "push" | "pull" | "fetch") => sync.isPending && sync.variables === a;

  const canCommit = message.trim().length > 0 && fileCount > 0 && !commit.isPending;
  const doCommit = () => {
    if (!canCommit) return;
    commit.mutate(message.trim(), { onSuccess: () => setMessage("") });
  };

  return (
    <div className={styles.commitColumn}>
      <div className={styles.commitBranchRow}>
        <span className={styles.branchName} title={status.data?.upstream ?? undefined}>
          {branch}
        </span>
        {ahead > 0 ? (
          <span className={styles.ab}>
            <ArrowUp size={11} />
            {ahead}
          </span>
        ) : null}
        {behind > 0 ? (
          <span className={styles.ab}>
            <ArrowDown size={11} />
            {behind}
          </span>
        ) : null}
        <span className={styles.spacer} />
        <button
          type="button"
          className={styles.iconBtn}
          title="Pull (--ff-only)"
          disabled={sync.isPending}
          onClick={() => sync.mutate("pull")}
        >
          <Download size={14} className={spinning("pull") ? styles.spin : ""} />
        </button>
        <button
          type="button"
          className={styles.iconBtn}
          title="Push"
          disabled={sync.isPending}
          onClick={() => sync.mutate("push")}
        >
          <Upload size={14} className={spinning("push") ? styles.spin : ""} />
        </button>
        <button
          type="button"
          className={styles.iconBtn}
          title="Fetch --all --prune"
          disabled={sync.isPending}
          onClick={() => sync.mutate("fetch")}
        >
          <RefreshCw size={14} className={spinning("fetch") ? styles.spin : ""} />
        </button>
      </div>

      <textarea
        className={styles.commitInput}
        placeholder="Message de commit…"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            doCommit();
          }
        }}
      />
      <button type="button" className={styles.commitBtn} disabled={!canCommit} onClick={doCommit}>
        {commit.isPending ? "Commit…" : `Commit (${fileCount})`}
      </button>
      {commit.error ? <div className={styles.error}>{(commit.error as Error).message}</div> : null}
      {sync.error ? <div className={styles.error}>{(sync.error as Error).message}</div> : null}
    </div>
  );
}

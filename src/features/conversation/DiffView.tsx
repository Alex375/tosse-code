import { clsx } from "clsx";
import { useMemo } from "react";
import { diffCounts, lineDiff } from "./lineDiff";
import { MentionPathChip } from "./FileMention";
import { basename } from "./toolMeta";
import styles from "./DiffView.module.css";

interface DiffViewProps {
  path?: string;
  /** Absent => a Write (new file): the content is shown as a plain block. */
  oldText?: string;
  newText?: string;
}

/**
 * Phase-1 unified line diff for Edit/MultiEdit (LCS-based, no dependency). Write
 * (no "before") renders the new content as a plain block. Phase 2 swaps in the
 * Monaco diff editor once the editor pane ships it.
 */
export function DiffView({ path, oldText, newText = "" }: DiffViewProps) {
  const lines = useMemo(
    () => (oldText == null ? [] : lineDiff(oldText, newText)),
    [oldText, newText],
  );
  const counts = useMemo(() => diffCounts(lines), [lines]);

  return (
    <div className={styles.diff}>
      {path && (
        <div className={styles.header}>
          <MentionPathChip path={path} className={styles.path} display={basename(path)} />
          {oldText != null ? (
            <span className={styles.summary}>
              <span className={styles.added}>+{counts.added}</span>{" "}
              <span className={styles.removed}>−{counts.removed}</span>
            </span>
          ) : (
            <span className={styles.summary}>new file</span>
          )}
        </div>
      )}

      {oldText == null ? (
        <pre className={styles.writePre}>{newText}</pre>
      ) : (
        <div className={styles.lines}>
          <div className={styles.linesInner}>
            {lines.map((l, idx) => (
              <div key={idx} className={clsx(styles.line, styles[l.type])}>
                <span className={styles.gutter}>{l.oldNo ?? l.newNo ?? ""}</span>
                <span className={styles.sign}>
                  {l.type === "add" ? "+" : l.type === "del" ? "−" : " "}
                </span>
                <span className={styles.text}>{l.text || " "}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

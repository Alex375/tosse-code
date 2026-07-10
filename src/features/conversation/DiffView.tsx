import { clsx } from "clsx";
import { useMemo } from "react";
import { diffCounts, lineDiff, type DiffLine } from "./lineDiff";
import { MentionPathChip } from "./FileMention";
import { basename } from "./toolMeta";
import styles from "./DiffView.module.css";

interface DiffViewProps {
  path?: string;
  /** Absent => a Write (new file): the content is shown as a plain block. */
  oldText?: string;
  newText?: string;
  /** Pre-parsed diff lines (e.g. a Codex ApplyPatch unified diff). When provided, rendered
   *  directly instead of computing an LCS line diff from old/new text — the diff is already
   *  authoritative, so this is the path for a backend that ships a unified diff string. */
  lines?: DiffLine[];
}

/**
 * Phase-1 unified line diff for Edit/MultiEdit (LCS-based, no dependency). Write
 * (no "before") renders the new content as a plain block. A caller can instead hand in
 * pre-parsed `lines` (Codex ships a unified diff). Phase 2 swaps in the Monaco diff editor
 * once the editor pane ships it.
 */
export function DiffView({ path, oldText, newText = "", lines: preParsed }: DiffViewProps) {
  const lines = useMemo(
    () => preParsed ?? (oldText == null ? [] : lineDiff(oldText, newText)),
    [preParsed, oldText, newText],
  );
  const counts = useMemo(() => diffCounts(lines), [lines]);
  // A diff is shown whenever there's a "before" (oldText) OR pre-parsed lines; only a bare
  // Write (new content, no diff) renders as a plain block.
  const hasDiff = preParsed != null || oldText != null;

  return (
    <div className={styles.diff}>
      {path && (
        <div className={styles.header}>
          <MentionPathChip path={path} className={styles.path} display={basename(path)} />
          {hasDiff ? (
            <span className={styles.summary}>
              <span className={styles.added}>+{counts.added}</span>{" "}
              <span className={styles.removed}>−{counts.removed}</span>
            </span>
          ) : (
            <span className={styles.summary}>new file</span>
          )}
        </div>
      )}

      {!hasDiff ? (
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

// Tiny presentation helpers shared by the changed-files list (changes view) and
// the commit-files list (history detail): split a repo path into name + dir, and
// map a git status letter to its badge CSS class.

import styles from "./git.module.css";
import type { GitFileEntry } from "../../ipc/useGit";

export function splitPath(p: string): { name: string; dir: string } {
  const i = p.lastIndexOf("/");
  return i === -1 ? { name: p, dir: "" } : { name: p.slice(i + 1), dir: p.slice(0, i) };
}

export function badgeClass(letter: string): string {
  switch (letter.toUpperCase()) {
    case "A":
      return styles.badgeA;
    case "D":
      return styles.badgeD;
    case "R":
    case "C":
      return styles.badgeR;
    case "U":
    case "?":
      return styles.badgeU;
    default:
      return styles.badgeM;
  }
}

/** The single most meaningful status letter for a working-tree entry. */
export function statusLetter(f: GitFileEntry): string {
  if (f.untracked) return "U";
  return f.index_status !== "." ? f.index_status : f.worktree_status;
}

/** Format a git author/commit unix timestamp (seconds) for the commit lists. */
export function fmtDate(tsSeconds: number): string {
  return new Date(tsSeconds * 1000).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

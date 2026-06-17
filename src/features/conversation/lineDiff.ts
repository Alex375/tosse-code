// Minimal LCS-based line diff (no dependency). Phase 1 renders Edit/MultiEdit
// before/after with this; Phase 2 will swap to Monaco's diff editor once the
// editor pane ships it.

export interface DiffLine {
  type: "add" | "del" | "context";
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;

  // dp[i][j] = LCS length of a[i:] and b[j:]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let oldNo = 1;
  let newNo = 1;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "context", text: a[i], oldNo: oldNo++, newNo: newNo++ });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", text: a[i], oldNo: oldNo++, newNo: null });
      i++;
    } else {
      out.push({ type: "add", text: b[j], oldNo: null, newNo: newNo++ });
      j++;
    }
  }
  while (i < n) out.push({ type: "del", text: a[i], oldNo: oldNo++, newNo: null }), i++;
  while (j < m) out.push({ type: "add", text: b[j], oldNo: null, newNo: newNo++ }), j++;
  return out;
}

export function diffCounts(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.type === "add") added++;
    else if (l.type === "del") removed++;
  }
  return { added, removed };
}

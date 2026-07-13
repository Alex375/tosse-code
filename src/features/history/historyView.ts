// Pure view logic for the conversation-history panel: time-window + repo filtering,
// repo grouping, and applying a search ranking. Kept side-effect-free so the panel
// stays dumb and these rules are unit-tested in isolation (historyView.test.ts).
import type { DiskConversation, SearchHit } from "../../ipc/client";

/** Coarse recency buckets the period filter offers (predefined, not a date picker). */
export type Period = "all" | "today" | "7d" | "30d";

const DAY_MS = 86_400_000;

/** The oldest mtime (Unix ms) a conversation may have to pass `period`, given `now`.
 *  `all` → 0 (everything passes). `today` is the last 24h (a rolling window, not the
 *  calendar day — good enough and simpler). */
export function periodCutoff(period: Period, now: number): number {
  switch (period) {
    case "today":
      return now - DAY_MS;
    case "7d":
      return now - 7 * DAY_MS;
    case "30d":
      return now - 30 * DAY_MS;
    case "all":
    default:
      return 0;
  }
}

/** Keep only conversations matching the active repo (by derived repo root) and the
 *  recency window. Input order (most-recent-first from the core) is preserved. */
export function filterConversations(
  convs: DiskConversation[],
  opts: { repoRoot: string | null; period: Period; now: number },
): DiskConversation[] {
  const cutoff = periodCutoff(opts.period, opts.now);
  return convs.filter(
    (c) =>
      (opts.repoRoot === null || c.repo_root === opts.repoRoot) && c.mtime_ms >= cutoff,
  );
}

export interface HistoryRepoGroup {
  repoRoot: string;
  conversations: DiskConversation[];
}

/** Group conversations under their derived repo root. Within a group, the most recent
 *  comes first; groups are ordered by their most recent conversation. Assumes the
 *  input is already most-recent-first (so the first seen per root is its newest). */
export function groupByRepoRoot(convs: DiskConversation[]): HistoryRepoGroup[] {
  const byRoot = new Map<string, DiskConversation[]>();
  for (const c of convs) {
    const arr = byRoot.get(c.repo_root) ?? [];
    arr.push(c);
    byRoot.set(c.repo_root, arr);
  }
  return [...byRoot.entries()]
    .map(([repoRoot, conversations]) => ({ repoRoot, conversations }))
    .sort((a, b) => (b.conversations[0]?.mtime_ms ?? 0) - (a.conversations[0]?.mtime_ms ?? 0));
}

export interface RankedRow {
  conv: DiskConversation;
  /** Snippet from the search hit (context around the match), empty when none. */
  snippet: string;
}

/** Order conversations by their search hit (best score first, recency tiebreak) and
 *  attach each hit's snippet, dropping conversations the search didn't match. Used
 *  when a query is active (the grouped/recency view is replaced by this flat ranking). */
export function applySearch(convs: DiskConversation[], hits: SearchHit[]): RankedRow[] {
  const byId = new Map(convs.map((c) => [c.session_id, c]));
  const score = new Map(hits.map((h) => [h.session_id, h]));
  return hits
    .map((h) => {
      const conv = byId.get(h.session_id);
      return conv ? { conv, snippet: h.snippet } : null;
    })
    .filter((r): r is RankedRow => r !== null)
    .sort((a, b) => {
      const sa = score.get(a.conv.session_id)!;
      const sb = score.get(b.conv.session_id)!;
      return sb.score - sa.score || b.conv.mtime_ms - a.conv.mtime_ms;
    });
}

/** Relative "time ago" for a Unix-ms timestamp (compact list label). */
export function timeAgo(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo} mo ago`;
  return `${Math.floor(mo / 12)} yr ago`;
}

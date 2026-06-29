import { describe, it, expect } from "vitest";
import type { DiskConversation, SearchHit } from "../../ipc/client";
import {
  applySearch,
  filterConversations,
  groupByRepoRoot,
  periodCutoff,
  timeAgo,
} from "./historyView";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function conv(over: Partial<DiskConversation> & { session_id: string }): DiskConversation {
  return {
    session_id: over.session_id,
    cwd: over.cwd ?? "/repo",
    repo_root: over.repo_root ?? "/repo",
    git_branch: over.git_branch ?? null,
    title: over.title ?? null,
    excerpt: over.excerpt ?? "",
    mtime_ms: over.mtime_ms ?? NOW,
  };
}

describe("periodCutoff", () => {
  it("maps buckets to the right cutoff", () => {
    expect(periodCutoff("all", NOW)).toBe(0);
    expect(periodCutoff("today", NOW)).toBe(NOW - DAY);
    expect(periodCutoff("7d", NOW)).toBe(NOW - 7 * DAY);
    expect(periodCutoff("30d", NOW)).toBe(NOW - 30 * DAY);
  });
});

describe("filterConversations", () => {
  const convs = [
    conv({ session_id: "recent", repo_root: "/a", mtime_ms: NOW - DAY / 2 }),
    conv({ session_id: "old", repo_root: "/a", mtime_ms: NOW - 10 * DAY }),
    conv({ session_id: "other-repo", repo_root: "/b", mtime_ms: NOW }),
  ];

  it("filters by recency window", () => {
    const got = filterConversations(convs, { repoRoot: null, period: "today", now: NOW });
    expect(got.map((c) => c.session_id)).toEqual(["recent", "other-repo"]);
  });

  it("filters by repo root", () => {
    const got = filterConversations(convs, { repoRoot: "/a", period: "all", now: NOW });
    expect(got.map((c) => c.session_id)).toEqual(["recent", "old"]);
  });

  it("with no repo + all period keeps everything", () => {
    expect(filterConversations(convs, { repoRoot: null, period: "all", now: NOW })).toHaveLength(3);
  });
});

describe("groupByRepoRoot", () => {
  it("groups and orders groups + members by recency", () => {
    // Input is most-recent-first (as the core returns it).
    const convs = [
      conv({ session_id: "b-new", repo_root: "/b", mtime_ms: NOW }),
      conv({ session_id: "a-new", repo_root: "/a", mtime_ms: NOW - DAY }),
      conv({ session_id: "a-old", repo_root: "/a", mtime_ms: NOW - 5 * DAY }),
    ];
    const groups = groupByRepoRoot(convs);
    // /b has the most-recent conversation → first group.
    expect(groups.map((g) => g.repoRoot)).toEqual(["/b", "/a"]);
    expect(groups[1].conversations.map((c) => c.session_id)).toEqual(["a-new", "a-old"]);
  });
});

describe("applySearch", () => {
  const convs = [
    conv({ session_id: "x", mtime_ms: NOW - DAY }),
    conv({ session_id: "y", mtime_ms: NOW }),
    conv({ session_id: "z", mtime_ms: NOW }),
  ];

  it("orders by score, attaches snippets, drops non-matches", () => {
    const hits: SearchHit[] = [
      { session_id: "y", score: 40, snippet: "snip-y" },
      { session_id: "x", score: 100, snippet: "snip-x" },
    ];
    const rows = applySearch(convs, hits);
    expect(rows.map((r) => r.conv.session_id)).toEqual(["x", "y"]); // x scores higher
    expect(rows[0].snippet).toBe("snip-x");
    // z had no hit → absent.
    expect(rows.find((r) => r.conv.session_id === "z")).toBeUndefined();
  });

  it("breaks score ties by recency", () => {
    const hits: SearchHit[] = [
      { session_id: "x", score: 50, snippet: "" },
      { session_id: "y", score: 50, snippet: "" },
    ];
    const rows = applySearch(convs, hits);
    // y is newer → first on a score tie.
    expect(rows.map((r) => r.conv.session_id)).toEqual(["y", "x"]);
  });
});

describe("timeAgo", () => {
  it("renders coarse French buckets", () => {
    expect(timeAgo(NOW, NOW)).toBe("à l'instant");
    expect(timeAgo(NOW - 5 * 60_000, NOW)).toBe("il y a 5 min");
    expect(timeAgo(NOW - 3 * 3_600_000, NOW)).toBe("il y a 3 h");
    expect(timeAgo(NOW - 4 * DAY, NOW)).toBe("il y a 4 j");
  });
});

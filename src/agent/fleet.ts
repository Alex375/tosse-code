// Fleet-level aggregation of agent statuses — the counts behind the FlightDeck
// AttentionBar and the "Agents" nav badge. Each conversation's status is derived
// from the SAME pure model the per-card hook uses (agentStatusForEntry), so the bar
// and the cards never disagree.
//
// Perf note: this recomputes over all sessions on every message-store delta. Fine
// at the handful-of-agents scale we target; if the fleet grows large, promote a
// standing per-conversation attention flag into the store instead of re-deriving.
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useConversationStore } from "../store/conversationStore";
import {
  groupByRepo,
  useConversations,
  useRepos,
  type Conversation,
  type Repo,
  type RepoGroup,
} from "../store/conversationsStore";
import { rowAttention, statusRank, type AgentStatus } from "./status";
import { agentStatusForEntry } from "./useAgentStatus";

export interface FleetAttention {
  /** Streams blocked on the user (permission / questionnaire / open question). */
  needsInput: number;
  /** Streams that finished cleanly and await a look. */
  review: number;
  /** Streams whose last turn errored. */
  error: number;
  /** needsInput + review + error — the total demanding attention. */
  total: number;
}

const EMPTY: FleetAttention = { needsInput: 0, review: 0, error: 0, total: 0 };

/** Tally a list of statuses into the attention buckets. Pure + testable. */
export function tallyAttention(statuses: AgentStatus[]): FleetAttention {
  const t: FleetAttention = { needsInput: 0, review: 0, error: 0, total: 0 };
  for (const s of statuses) {
    switch (rowAttention(s)) {
      case "input":
        t.needsInput++;
        t.total++;
        break;
      case "review":
        t.review++;
        t.total++;
        break;
      case "error":
        t.error++;
        t.total++;
        break;
    }
  }
  return t;
}

/**
 * Live attention tally across every conversation. `useShallow` over the computed
 * counts means the bar/badge only re-render when a count actually moves, not on
 * every streaming delta.
 */
export function useFleetAttention(): FleetAttention {
  const convs = useConversations();
  return useConversationStore(
    useShallow((s) =>
      convs.length === 0
        ? EMPTY
        : tallyAttention(convs.map((c) => agentStatusForEntry(c.handle, s.sessions[c.id]))),
    ),
  );
}

// ---- FlightDeck lanes (one horizontal lane per repo, status-ordered) -----------

// A lane is exactly a repo group; the FlightDeck just orders it status-first. Kept
// as an alias so the two grids share one type (and one grouping skeleton).
export type FleetLane = RepoGroup;

/**
 * Order the fleet for the swimlane layout (PURE, testable): group by repo, sort
 * each repo's conversations by status (action-required/error → review → running →
 * idle → off, recency as tiebreak), then order the repos by their most urgent
 * conversation (recency as tiebreak; empty repos last). `rank` is injected so the
 * status source stays out of this pure function. Shares the grouping skeleton with
 * the sidebar's `groupConversationsByRepo` (`groupByRepo`); only the comparators
 * differ (status-first here vs recency there).
 */
export function orderLanes(
  repos: Repo[],
  conversations: Conversation[],
  rank: (c: Conversation) => number,
): FleetLane[] {
  // Derive each conversation's status rank ONCE. `rank` runs a real status
  // derivation (not a cheap field read), so calling it inside the O(n log n) sort
  // comparators below would re-derive the same conversation on every compare —
  // O(n log n) derivations per recompute, replayed on every streaming delta. Cache
  // it to one derivation per conversation; the comparators read the cached value.
  const rankById = new Map<string, number>();
  for (const c of conversations) rankById.set(c.id, rank(c));
  const r = (c: Conversation) => rankById.get(c.id) ?? 99;
  // After the status sort, a group's first conversation holds its lowest (most
  // urgent) rank; the lane's recency tiebreak is the max activity across it.
  const repoRank = (g: FleetLane) => (g.conversations.length ? r(g.conversations[0]) : 99);
  const repoAt = (g: FleetLane) =>
    g.conversations.length
      ? Math.max(...g.conversations.map((c) => c.lastActivityAt))
      : g.repo.addedAt;
  return groupByRepo(
    repos,
    conversations,
    (a, b) => r(a) - r(b) || b.lastActivityAt - a.lastActivityAt,
    (a, b) => repoRank(a) - repoRank(b) || repoAt(b) - repoAt(a),
  );
}

/** Project lanes to a flat, shallow-stable order-token list, so `useShallow` can
 *  gate re-renders on order changes alone. Inverse of {@link rebuildLanes}. */
export function lanesToTokens(lanes: FleetLane[]): string[] {
  return lanes.flatMap((l) => ["r:" + l.repo.id, ...l.conversations.map((c) => "c:" + c.id)]);
}

/** Rebuild the lane objects from a flat order-token list (inverse of
 *  {@link lanesToTokens}). Tokens for a repo/conversation no longer present — a
 *  stale order list racing a removal — are skipped. */
export function rebuildLanes(tokens: string[], repos: Repo[], conversations: Conversation[]): FleetLane[] {
  const repoById = new Map(repos.map((r) => [r.id, r] as const));
  const convById = new Map(conversations.map((c) => [c.id, c] as const));
  const lanes: FleetLane[] = [];
  let cur: FleetLane | null = null;
  for (const t of tokens) {
    if (t[0] === "r") {
      const repo = repoById.get(t.slice(2));
      if (repo) {
        cur = { repo, conversations: [] };
        lanes.push(cur);
      } else {
        cur = null;
      }
    } else if (cur) {
      const c = convById.get(t.slice(2));
      if (c) cur.conversations.push(c);
    }
  }
  return lanes;
}

/**
 * The status-ordered repo lanes for the FlightDeck. Recomputes the order on session
 * changes but, via `useShallow` over a flat order-token list, only RE-RENDERS when
 * the order actually moves — not on every streaming delta.
 */
export function useFleetLanes(): FleetLane[] {
  const repos = useRepos();
  const conversations = useConversations();
  const tokens = useConversationStore(
    useShallow((s) => {
      const rank = (c: Conversation) => statusRank(agentStatusForEntry(c.handle, s.sessions[c.id]));
      return lanesToTokens(orderLanes(repos, conversations, rank));
    }),
  );
  return useMemo(() => rebuildLanes(tokens, repos, conversations), [tokens, repos, conversations]);
}

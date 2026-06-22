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
  useConversations,
  useRepos,
  type Conversation,
  type Repo,
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

export interface FleetLane {
  repo: Repo;
  conversations: Conversation[];
}

/**
 * Order the fleet for the swimlane layout (PURE, testable): group by repo, sort
 * each repo's conversations by status (action-required/error → review → running →
 * idle → off, recency as tiebreak), then order the repos by their most urgent
 * conversation (recency as tiebreak; empty repos last). `rank` is injected so the
 * status source stays out of this pure function.
 */
export function orderLanes(
  repos: Repo[],
  conversations: Conversation[],
  rank: (c: Conversation) => number,
): FleetLane[] {
  const byRepo = new Map<string, Conversation[]>();
  for (const c of conversations) {
    const arr = byRepo.get(c.repoId) ?? [];
    arr.push(c);
    byRepo.set(c.repoId, arr);
  }
  for (const arr of byRepo.values()) {
    arr.sort((a, b) => rank(a) - rank(b) || b.lastActivityAt - a.lastActivityAt);
  }
  const repoRank = (r: Repo) => {
    const arr = byRepo.get(r.id);
    return arr && arr.length ? Math.min(...arr.map(rank)) : 99;
  };
  const repoAt = (r: Repo) => {
    const arr = byRepo.get(r.id);
    return arr && arr.length ? Math.max(...arr.map((c) => c.lastActivityAt)) : r.addedAt;
  };
  return [...repos]
    .sort((a, b) => repoRank(a) - repoRank(b) || repoAt(b) - repoAt(a))
    .map((repo) => ({ repo, conversations: byRepo.get(repo.id) ?? [] }));
}

/** Rebuild the lane objects from a flat, shallow-stable order token list. */
function rebuildLanes(tokens: string[], repos: Repo[], conversations: Conversation[]): FleetLane[] {
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
      return orderLanes(repos, conversations, rank).flatMap((l) => [
        "r:" + l.repo.id,
        ...l.conversations.map((c) => "c:" + c.id),
      ]);
    }),
  );
  return useMemo(() => rebuildLanes(tokens, repos, conversations), [tokens, repos, conversations]);
}

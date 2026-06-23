import { describe, it, expect } from "vitest";
import { lanesToTokens, orderLanes, rebuildLanes, tallyAttention } from "./fleet";
import { statusRank, type AgentStatus } from "./status";
import type { Conversation, Repo } from "../store/conversationsStore";

function repo(id: string, addedAt: number): Repo {
  return { id, path: "/r/" + id, addedAt };
}
function conv(id: string, repoId: string, lastActivityAt: number): Conversation {
  return { id, repoId, lastActivityAt } as unknown as Conversation;
}

describe("tallyAttention", () => {
  it("buckets the attention states and ignores quiet ones (running/idle/off)", () => {
    const statuses: AgentStatus[] = [
      { kind: "needIntervention", tool: "Bash" }, // input
      { kind: "needInput", via: "questionnaire", prompt: "?" }, // input
      { kind: "needInput", via: "openQuestion", prompt: "?" }, // input
      { kind: "review" }, // review
      { kind: "error", message: "boom" }, // error
      { kind: "running", activity: null }, // ignored
      { kind: "idle" }, // ignored
      { kind: "off" }, // ignored
    ];
    expect(tallyAttention(statuses)).toEqual({
      needsInput: 3,
      review: 1,
      error: 1,
      total: 5,
    });
  });

  it("is all-zero for an empty fleet", () => {
    expect(tallyAttention([])).toEqual({ needsInput: 0, review: 0, error: 0, total: 0 });
  });
});

describe("statusRank", () => {
  it("ranks action-required/error first, then review, running, and the idle/off history", () => {
    expect(statusRank({ kind: "needIntervention", tool: "Bash" })).toBe(0);
    expect(statusRank({ kind: "needInput", via: "questionnaire", prompt: null })).toBe(0);
    expect(statusRank({ kind: "error", message: "x" })).toBe(0);
    expect(statusRank({ kind: "review" })).toBe(1);
    expect(statusRank({ kind: "running", activity: null })).toBe(2);
    expect(statusRank({ kind: "idle" })).toBe(3);
    expect(statusRank({ kind: "off" })).toBe(4);
  });
});

describe("orderLanes", () => {
  it("sorts cards active-first within a repo and floats repos with activity to the top", () => {
    const repos = [repo("a", 1), repo("b", 2)];
    const conversations = [
      conv("a-idle", "a", 100),
      conv("a-run", "a", 50),
      conv("b-ask", "b", 10),
    ];
    const rank = (c: Conversation) => (c.id === "a-idle" ? 3 : c.id === "a-run" ? 2 : 0);

    const lanes = orderLanes(repos, conversations, rank);

    // repo b holds the only action-required agent (rank 0) → floats above repo a.
    expect(lanes.map((l) => l.repo.id)).toEqual(["b", "a"]);
    // within repo a, the running agent (rank 2) precedes the idle one (rank 3).
    expect(lanes[1].conversations.map((c) => c.id)).toEqual(["a-run", "a-idle"]);
  });

  it("breaks rank ties by recency and sinks empty repos to the bottom", () => {
    const repos = [repo("a", 1), repo("empty", 999)];
    const conversations = [conv("c1", "a", 50), conv("c2", "a", 300)];
    const rank = () => 3; // everything idle

    const lanes = orderLanes(repos, conversations, rank);

    // a (has conversations, rank 3) outranks the empty repo (rank 99).
    expect(lanes.map((l) => l.repo.id)).toEqual(["a", "empty"]);
    expect(lanes[0].conversations.map((c) => c.id)).toEqual(["c2", "c1"]);
    expect(lanes.find((l) => l.repo.id === "empty")!.conversations).toEqual([]);
  });

  it("orders two conversation-less repos by addedAt (most recent first)", () => {
    // Both repos are empty → equal rank (99); the only signal left is the addedAt
    // tiebreak. The dedicated case for the otherwise-unexercised `repoAt` branch.
    const repos = [repo("old", 100), repo("new", 200)];

    const lanes = orderLanes(repos, [], () => 0);

    expect(lanes.map((l) => l.repo.id)).toEqual(["new", "old"]);
    expect(lanes.every((l) => l.conversations.length === 0)).toBe(true);
  });

  it("derives each conversation's rank exactly once, regardless of fleet size", () => {
    // Guards the perf contract: `rank` (a real status derivation) is cached, so the
    // O(n log n) sort can't re-derive a conversation on every comparison.
    const repos = [repo("a", 1), repo("b", 2)];
    const conversations = [
      conv("a1", "a", 10),
      conv("a2", "a", 20),
      conv("a3", "a", 30),
      conv("b1", "b", 40),
      conv("b2", "b", 50),
    ];
    const seen = new Map<string, number>();
    const rank = (c: Conversation) => {
      seen.set(c.id, (seen.get(c.id) ?? 0) + 1);
      return 3;
    };

    orderLanes(repos, conversations, rank);

    expect([...seen.values()].every((n) => n === 1)).toBe(true);
    expect(seen.size).toBe(conversations.length);
  });
});

describe("rebuildLanes ↔ lanesToTokens round-trip", () => {
  it("reconstructs the exact lane structure from its order tokens", () => {
    const repos = [repo("a", 1), repo("b", 2)];
    const conversations = [conv("a1", "a", 100), conv("a2", "a", 50), conv("b1", "b", 10)];
    const lanes = orderLanes(repos, conversations, (c) => (c.id === "a2" ? 0 : 3));

    const rebuilt = rebuildLanes(lanesToTokens(lanes), repos, conversations);

    expect(rebuilt.map((l) => l.repo.id)).toEqual(lanes.map((l) => l.repo.id));
    expect(rebuilt.map((l) => l.conversations.map((c) => c.id))).toEqual(
      lanes.map((l) => l.conversations.map((c) => c.id)),
    );
  });

  it("skips tokens for repos/conversations no longer present (stale order list)", () => {
    const repos = [repo("a", 1)];
    const conversations = [conv("a1", "a", 100)];

    // Order list references a removed repo ("ghost"), a conv under it ("x"), and a
    // missing conv under a live repo ("missing") — all must be dropped cleanly.
    const rebuilt = rebuildLanes(
      ["r:ghost", "c:x", "r:a", "c:a1", "c:missing"],
      repos,
      conversations,
    );

    expect(rebuilt.map((l) => l.repo.id)).toEqual(["a"]);
    expect(rebuilt[0].conversations.map((c) => c.id)).toEqual(["a1"]);
  });
});

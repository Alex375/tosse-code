import { describe, it, expect } from "vitest";
import { selectUserMessageHistory, memoizedUserMessageHistory } from "./conversationStore";
import type { SessionEntry, Turn, TimelineEntry } from "./types";

function userTurn(id: string, text: string, parentToolUseId: string | null = null): Turn {
  return {
    id,
    role: "user",
    status: "final",
    streamingText: text,
    streamingThinking: "",
    blocks: [],
    parentToolUseId,
    hasThinking: false,
  } as unknown as Turn;
}

function asstTurn(id: string, text = ""): Turn {
  return {
    id,
    role: "assistant",
    status: text ? "streaming" : "final",
    streamingText: text,
    streamingThinking: "",
    blocks: [],
    parentToolUseId: null,
    hasThinking: false,
  } as unknown as Turn;
}

function entry(timeline: TimelineEntry[], turns: Record<string, Turn>): SessionEntry {
  return { session: "s", timeline, turns } as unknown as SessionEntry;
}

const turnLine = (id: string): TimelineEntry => ({ kind: "turn", id }) as TimelineEntry;

describe("selectUserMessageHistory", () => {
  it("collects the user's root messages in timeline order", () => {
    const e = entry([turnLine("u1"), turnLine("a1"), turnLine("u2")], {
      u1: userTurn("u1", "first"),
      a1: asstTurn("a1", "reply"),
      u2: userTurn("u2", "second"),
    });
    expect(selectUserMessageHistory(e)).toEqual(["first", "second"]);
  });

  it("drops blank / whitespace-only messages", () => {
    const e = entry([turnLine("u1"), turnLine("u2"), turnLine("u3")], {
      u1: userTurn("u1", "keep"),
      u2: userTurn("u2", "   "),
      u3: userTurn("u3", ""),
    });
    expect(selectUserMessageHistory(e)).toEqual(["keep"]);
  });

  it("collapses CONSECUTIVE duplicates but keeps non-consecutive ones", () => {
    const e = entry([turnLine("u1"), turnLine("u2"), turnLine("u3"), turnLine("u4")], {
      u1: userTurn("u1", "ls"),
      u2: userTurn("u2", "ls"), // consecutive dup → collapsed
      u3: userTurn("u3", "build"),
      u4: userTurn("u4", "ls"), // same as u1 but not consecutive → kept
    });
    expect(selectUserMessageHistory(e)).toEqual(["ls", "build", "ls"]);
  });

  it("excludes sub-agent (Task) user turns", () => {
    const e = entry([turnLine("u1"), turnLine("sub")], {
      u1: userTurn("u1", "real"),
      sub: userTurn("sub", "tool injected", "toolu_123"),
    });
    expect(selectUserMessageHistory(e)).toEqual(["real"]);
  });

  it("ignores non-turn timeline entries and assistant turns", () => {
    const e = entry(
      [turnLine("u1"), { kind: "notice", id: "n1" } as TimelineEntry, turnLine("a1")],
      { u1: userTurn("u1", "hi"), a1: asstTurn("a1", "yo") },
    );
    expect(selectUserMessageHistory(e)).toEqual(["hi"]);
  });

  it("returns a shared empty array for no entry / no user messages", () => {
    expect(selectUserMessageHistory(undefined)).toEqual([]);
    const e = entry([turnLine("a1")], { a1: asstTurn("a1", "only assistant") });
    expect(selectUserMessageHistory(e)).toEqual([]);
    // Same reference for the empty case (stable → no needless re-render).
    expect(selectUserMessageHistory(undefined)).toBe(selectUserMessageHistory(e));
  });
});

describe("memoizedUserMessageHistory (timeline-identity memo)", () => {
  it("returns the SAME array reference while the timeline reference is unchanged", () => {
    const timeline = [turnLine("u1")];
    const e1 = entry(timeline, { u1: userTurn("u1", "hello") });
    const r1 = memoizedUserMessageHistory("s-memo-1", e1);

    // Simulate a streamed assistant token: a NEW entry object, NEW turns map, but the
    // SAME timeline reference (the per-token path never replaces timeline). The history
    // must be the cached array — no O(n) re-walk per token.
    const e2 = entry(timeline, { ...e1.turns, a1: asstTurn("a1", "streaming…") });
    const r2 = memoizedUserMessageHistory("s-memo-1", e2);

    expect(r2).toBe(r1);
  });

  it("recomputes when a new timeline entry is pushed (a real new message)", () => {
    const t1 = [turnLine("u1")];
    const e1 = entry(t1, { u1: userTurn("u1", "hello") });
    const r1 = memoizedUserMessageHistory("s-memo-2", e1);

    const t2 = [...t1, turnLine("u2")];
    const e2 = entry(t2, { u1: userTurn("u1", "hello"), u2: userTurn("u2", "world") });
    const r2 = memoizedUserMessageHistory("s-memo-2", e2);

    expect(r2).not.toBe(r1);
    expect(r2).toEqual(["hello", "world"]);
  });

  it("keys the cache per session (no cross-talk)", () => {
    const ea = entry([turnLine("u1")], { u1: userTurn("u1", "A") });
    const eb = entry([turnLine("u1")], { u1: userTurn("u1", "B") });
    expect(memoizedUserMessageHistory("s-A", ea)).toEqual(["A"]);
    expect(memoizedUserMessageHistory("s-B", eb)).toEqual(["B"]);
  });

  it("returns empty for an undefined entry", () => {
    expect(memoizedUserMessageHistory("s-none", undefined)).toEqual([]);
  });
});

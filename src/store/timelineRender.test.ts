import { describe, it, expect } from "vitest";
import { planTimelineRender } from "./conversationStore";
import type { SessionEntry, TimelineEntry, Turn } from "./types";

function turn(id: string, role: "user" | "assistant"): Turn {
  return {
    id,
    role,
    status: "streaming",
    streamingText: "",
    streamingThinking: "",
    blocks: [],
    parentToolUseId: null,
    hasThinking: false,
  } as Turn;
}

function entry(timeline: TimelineEntry[], turns: Record<string, Turn>): SessionEntry {
  return { timeline, turns } as unknown as SessionEntry;
}

describe("planTimelineRender", () => {
  it("coalesces consecutive assistant turns into one ai group", () => {
    const plan = planTimelineRender(
      entry(
        [
          { kind: "turn", id: "u1" },
          { kind: "turn", id: "a1" },
          { kind: "turn", id: "a2" },
          { kind: "turn", id: "a3" },
        ],
        {
          u1: turn("u1", "user"),
          a1: turn("a1", "assistant"),
          a2: turn("a2", "assistant"),
          a3: turn("a3", "assistant"),
        },
      ),
    );
    expect(plan.map((p) => p.kind)).toEqual(["user", "ai"]);
    expect(plan[1]).toEqual({ kind: "ai", ids: ["a1", "a2", "a3"] });
  });

  it("a user message breaks the group (the only thing that splits a tool run)", () => {
    const plan = planTimelineRender(
      entry(
        [
          { kind: "turn", id: "a1" },
          { kind: "turn", id: "u1" },
          { kind: "turn", id: "a2" },
        ],
        { a1: turn("a1", "assistant"), u1: turn("u1", "user"), a2: turn("a2", "assistant") },
      ),
    );
    expect(plan).toEqual([
      { kind: "ai", ids: ["a1"] },
      { kind: "user", id: "u1" },
      { kind: "ai", ids: ["a2"] },
    ]);
  });

  it("non-turn entries (turn_result / error) break the group and pass through", () => {
    const plan = planTimelineRender(
      entry(
        [
          { kind: "turn", id: "a1" },
          { kind: "turn_result", id: "tr" },
          { kind: "turn", id: "a2" },
          { kind: "error", id: "er" },
        ],
        { a1: turn("a1", "assistant"), a2: turn("a2", "assistant") },
      ),
    );
    expect(plan.map((p) => p.kind)).toEqual(["ai", "turn_result", "ai", "error"]);
  });

  it("returns empty for no entry / empty timeline", () => {
    expect(planTimelineRender(undefined)).toEqual([]);
    expect(planTimelineRender(entry([], {}))).toEqual([]);
  });
});

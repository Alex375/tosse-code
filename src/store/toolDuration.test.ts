import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useConversationStore } from "./conversationStore";
import type { ConversationItem } from "../ipc/client";

// Per-tool timing: `toolStartedAt[id]` is stamped when a tool_use block appears
// (assistant_message) and consumed into `toolDurations[id]` when its tool_result lands.
// Front-measured (≈ execution time), keyed by tool_use_id.

const store = () => useConversationStore.getState();
const startedAt = (s: string) => store().sessions[s]?.toolStartedAt ?? {};
const durations = (s: string) => store().sessions[s]?.toolDurations ?? {};

function toolUse(session: string, msgId: string, toolUseId: string, name = "Bash") {
  store().applyItem(session, {
    kind: "assistant_message",
    id: msgId,
    parent_tool_use_id: null,
    blocks: [{ type: "tool_use", id: toolUseId, name, input: {} }],
  } as ConversationItem);
}

function toolResult(session: string, toolUseId: string) {
  store().applyItem(session, {
    kind: "tool_result",
    tool_use_id: toolUseId,
    content: "ok",
    is_error: false,
    parent_tool_use_id: null,
  } as ConversationItem);
}

describe("per-tool duration", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stamps the start when a tool_use appears", () => {
    const s = "tool-start";
    store().ensureSession(s);
    vi.setSystemTime(new Date(1_000_000));
    toolUse(s, "m1", "toolu_a");
    expect(startedAt(s)["toolu_a"]).toBe(1_000_000);
    expect(durations(s)["toolu_a"]).toBeUndefined();
  });

  it("freezes the duration when the tool_result lands", () => {
    const s = "tool-freeze";
    store().ensureSession(s);
    vi.setSystemTime(new Date(1_000_000));
    toolUse(s, "m1", "toolu_a");
    vi.setSystemTime(new Date(1_002_300));
    toolResult(s, "toolu_a");
    expect(durations(s)["toolu_a"]).toBe(2_300);
  });

  it("times several tools independently by id", () => {
    const s = "tool-multi";
    store().ensureSession(s);
    vi.setSystemTime(new Date(1_000_000));
    toolUse(s, "m1", "toolu_read");
    vi.setSystemTime(new Date(1_000_100));
    toolResult(s, "toolu_read"); // fast: 0.1s
    vi.setSystemTime(new Date(1_000_500));
    toolUse(s, "m2", "toolu_bash");
    vi.setSystemTime(new Date(1_003_500));
    toolResult(s, "toolu_bash"); // slow: 3s
    expect(durations(s)["toolu_read"]).toBe(100);
    expect(durations(s)["toolu_bash"]).toBe(3_000);
  });

  it("ignores a tool_result with no recorded start (hydrated from disk)", () => {
    const s = "tool-nostart";
    store().ensureSession(s);
    vi.setSystemTime(new Date(1_000_000));
    toolResult(s, "toolu_orphan");
    expect(durations(s)["toolu_orphan"]).toBeUndefined();
  });

  it("records NO stamp or duration for a full pair REPLAYED from disk (hydrating)", () => {
    // Regression: the tool start is stamped inside the `assistant_message` reducer,
    // which also runs when `loadConversationHistory`/`reloadConversationHistory` replay
    // the transcript. Its tool_result then lands in the SAME synchronous loop, freezing
    // ~0ms → every reloaded tool showed a bogus "0ms" chip. Passing `hydrating: true`
    // suppresses both the stamp and the freeze.
    const s = "tool-hydrate";
    store().ensureSession(s);
    vi.setSystemTime(new Date(1_000_000));
    store().applyItem(
      s,
      {
        kind: "assistant_message",
        id: "m1",
        parent_tool_use_id: null,
        blocks: [{ type: "tool_use", id: "toolu_a", name: "Bash", input: {} }],
      } as ConversationItem,
      true, // hydrating
    );
    // No live start recorded during replay.
    expect(startedAt(s)["toolu_a"]).toBeUndefined();
    store().applyItem(
      s,
      {
        kind: "tool_result",
        tool_use_id: "toolu_a",
        content: "ok",
        is_error: false,
        parent_tool_use_id: null,
      } as ConversationItem,
      true, // hydrating
    );
    // …so no bogus duration is frozen either.
    expect(durations(s)["toolu_a"]).toBeUndefined();
  });
});

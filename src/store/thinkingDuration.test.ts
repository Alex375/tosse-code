import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useConversationStore } from "./conversationStore";
import type { ConversationItem } from "../ipc/client";

// Reflection-time tracking: `thinkingStartedAt` is stamped on the streamingThinking
// empty→non-empty edge (a new thinking block) and frozen into `thinkingDurations`
// (keyed by the block's text) when that block finalizes via `assistant_message`. It must
// handle several thinking blocks per turn (interleaved thinking between tool calls).

const store = () => useConversationStore.getState();
const startedAt = (s: string) => store().sessions[s]?.thinkingStartedAt ?? null;
const durations = (s: string) => store().sessions[s]?.thinkingDurations ?? {};

function assistantThinking(session: string, id: string, text: string) {
  store().applyItem(session, {
    kind: "assistant_message",
    id,
    parent_tool_use_id: null,
    blocks: [{ type: "thinking", text }],
  } as ConversationItem);
}

describe("thinking reflection time", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stamps thinkingStartedAt on the first thinking delta of a block", () => {
    const s = "think-start";
    store().ensureSession(s);
    expect(startedAt(s)).toBeNull();
    vi.setSystemTime(new Date(1_000_000));
    store().appendThinking(s, "m1", "let me think");
    expect(startedAt(s)).toBe(1_000_000);
  });

  it("does NOT re-stamp on later deltas of the same block", () => {
    const s = "think-noreset";
    store().ensureSession(s);
    vi.setSystemTime(new Date(1_000_000));
    store().appendThinking(s, "m1", "step one ");
    vi.setSystemTime(new Date(1_003_000));
    store().appendThinking(s, "m1", "step two");
    expect(startedAt(s)).toBe(1_000_000);
  });

  it("freezes the block's duration (keyed by text) and clears the start on finalize", () => {
    const s = "think-freeze";
    store().ensureSession(s);
    vi.setSystemTime(new Date(1_000_000));
    store().appendThinking(s, "m1", "deep thought");
    vi.setSystemTime(new Date(1_008_000));
    assistantThinking(s, "m1", "deep thought");
    expect(durations(s)["deep thought"]).toBe(8_000);
    expect(startedAt(s)).toBeNull();
  });

  it("tracks two interleaved thinking blocks independently", () => {
    const s = "think-interleaved";
    store().ensureSession(s);
    // First block: 5s.
    vi.setSystemTime(new Date(1_000_000));
    store().appendThinking(s, "m1", "first block");
    vi.setSystemTime(new Date(1_005_000));
    assistantThinking(s, "m1", "first block");
    // ...tool call happens... then a second thinking block on a new message: 3s.
    vi.setSystemTime(new Date(1_010_000));
    store().appendThinking(s, "m2", "second block");
    vi.setSystemTime(new Date(1_013_000));
    assistantThinking(s, "m2", "second block");
    expect(durations(s)["first block"]).toBe(5_000);
    expect(durations(s)["second block"]).toBe(3_000);
    expect(startedAt(s)).toBeNull();
  });

  it("clears thinkingStartedAt when the turn ends (busy true→false)", () => {
    const s = "think-turnend";
    store().ensureSession(s);
    vi.setSystemTime(new Date(1_000_000));
    // Turn goes busy, thinking starts, then the turn ends WITHOUT finalizing the block
    // (e.g. interrupted) — the stamp must not leak into the next turn.
    store().applyState(s, baseState(true));
    store().appendThinking(s, "m1", "interrupted mid-thought");
    expect(startedAt(s)).toBe(1_000_000);
    store().applyState(s, baseState(false));
    expect(startedAt(s)).toBeNull();
  });
});

function baseState(busy: boolean) {
  return {
    busy,
    session_id: null,
    cwd: null,
    model: null,
    permission_mode: null,
    effort: null,
    ultracode: false,
    activity: null,
    awaiting_permission: false,
    ended: false,
    context_tokens: null,
    context_window: null,
    rate_limit: null,
  };
}

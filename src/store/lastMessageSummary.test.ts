import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub the IPC surface — we assert whether/how the summary command is fired.
vi.mock("../ipc/client", () => {
  const ok = (data: unknown = null) => Promise.resolve({ status: "ok", data });
  return { commands: { generateMessageSummary: vi.fn(() => ok()) } };
});

import { commands } from "../ipc/client";
import {
  summaryPreview,
  cleanSummary,
  isTrivialToSummarize,
  triggerLastMessageSummary,
  useLastMessageSummaryStore,
} from "./lastMessageSummary";

const genMock = commands.generateMessageSummary as unknown as ReturnType<typeof vi.fn>;
const valueOf = (id: string) => useLastMessageSummaryStore.getState().byConv[id];

beforeEach(() => {
  genMock.mockClear();
  useLastMessageSummaryStore.getState().clearAll();
});

describe("summaryPreview", () => {
  it("takes the first line, collapses whitespace, truncates with ellipsis", () => {
    expect(summaryPreview("Fix   the  bug")).toBe("Fix the bug");
    expect(summaryPreview("first line\nsecond line")).toBe("first line");
    expect(summaryPreview("x".repeat(80), 10)).toBe("xxxxxxxxxx…");
  });
});

describe("cleanSummary", () => {
  it("trims and peels wrapping quotes, WITHOUT ever truncating (no ellipsis on the summary)", () => {
    expect(cleanSummary('"Fix the login crash"')).toBe("Fix the login crash");
    expect(cleanSummary("  «  Refactor  »  ")).toBe("Refactor");
    // A longer-than-a-line summary is returned in full — the card wraps it, never clips it.
    const long = "Implement live syncing of remote conversations";
    expect(cleanSummary(long)).toBe(long);
    expect(cleanSummary(long)).not.toContain("…");
  });
});

describe("isTrivialToSummarize", () => {
  it("is trivial for slash commands and short single-line messages", () => {
    expect(isTrivialToSummarize("/build-app")).toBe(true);
    expect(isTrivialToSummarize("thanks")).toBe(true);
    expect(isTrivialToSummarize("")).toBe(true);
  });
  it("is NOT trivial for long or multi-line messages (Haiku earns its keep)", () => {
    expect(isTrivialToSummarize("a".repeat(60))).toBe(false);
    expect(isTrivialToSummarize("line 1\nline 2")).toBe(false);
  });
});

describe("triggerLastMessageSummary", () => {
  it("shows the truncation instantly and fires Haiku for a long message with a handle", () => {
    const msg = "x".repeat(80);
    triggerLastMessageSummary("c1", "session-1", msg);
    expect(valueOf("c1")).toBe(summaryPreview(msg)); // instant preview
    expect(genMock).toHaveBeenCalledTimes(1);
    expect(genMock).toHaveBeenCalledWith("session-1", msg, 1);
  });

  it("skips the Haiku call for a trivial message (preview is the summary)", () => {
    triggerLastMessageSummary("c1", "session-1", "/land");
    expect(valueOf("c1")).toBe("/land");
    expect(genMock).not.toHaveBeenCalled();
  });

  it("skips the Haiku call when there is no live session (only the preview shows)", () => {
    const msg = "a message long enough for a real Haiku summary";
    triggerLastMessageSummary("c1", null, msg);
    expect(valueOf("c1")).toBe(summaryPreview(msg));
    expect(genMock).not.toHaveBeenCalled();
  });

  it("bumps the seq on each send so a superseded response can be dropped", () => {
    triggerLastMessageSummary("c1", "session-1", "first long message to summarize via the small model");
    triggerLastMessageSummary("c1", "session-1", "second long message to summarize via the small model");
    expect(genMock).toHaveBeenLastCalledWith("session-1", expect.stringContaining("second"), 2);
  });
});

describe("apply (seq gate)", () => {
  it("applies a summary whose seq matches the conversation's latest message", () => {
    triggerLastMessageSummary("c1", "session-1", "long message to trigger a Haiku generation");
    useLastMessageSummaryStore.getState().apply("c1", "Fresh summary", 1);
    expect(valueOf("c1")).toBe("Fresh summary");
  });

  it("drops a stale (superseded) response — a newer message advanced the seq", () => {
    const msg2 = "second long message to summarize via the small model";
    triggerLastMessageSummary("c1", "session-1", "first long message to summarize via the small model");
    triggerLastMessageSummary("c1", "session-1", msg2);
    // The Haiku for message #1 (seq 1) lands late — it must NOT clobber #2's preview.
    useLastMessageSummaryStore.getState().apply("c1", "Stale summary of #1", 1);
    expect(valueOf("c1")).toBe(summaryPreview(msg2));
    // The Haiku for #2 (seq 2) applies.
    useLastMessageSummaryStore.getState().apply("c1", "Summary of #2", 2);
    expect(valueOf("c1")).toBe("Summary of #2");
  });

  it("clear() forgets the conversation and resets its seq", () => {
    triggerLastMessageSummary("c1", "session-1", "long message to summarize");
    useLastMessageSummaryStore.getState().clear("c1");
    expect(valueOf("c1")).toBeUndefined();
    // After clear, the next send starts a fresh seq at 1 (a late seq-2 from before is dropped).
    useLastMessageSummaryStore.getState().apply("c1", "ghost", 2);
    expect(valueOf("c1")).toBeUndefined();
  });
});

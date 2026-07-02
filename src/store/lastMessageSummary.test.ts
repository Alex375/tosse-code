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
    expect(summaryPreview("Corriger   le  bug")).toBe("Corriger le bug");
    expect(summaryPreview("première ligne\nseconde ligne")).toBe("première ligne");
    expect(summaryPreview("x".repeat(80), 10)).toBe("xxxxxxxxxx…");
  });
});

describe("cleanSummary", () => {
  it("trims and peels wrapping quotes, WITHOUT ever truncating (no ellipsis on the summary)", () => {
    expect(cleanSummary('"Corriger le crash au login"')).toBe("Corriger le crash au login");
    expect(cleanSummary("  «  Refactor  »  ")).toBe("Refactor");
    // A longer-than-a-line summary is returned in full — the card wraps it, never clips it.
    const long = "Implémenter la synchronisation des conversations distantes en direct";
    expect(cleanSummary(long)).toBe(long);
    expect(cleanSummary(long)).not.toContain("…");
  });
});

describe("isTrivialToSummarize", () => {
  it("is trivial for slash commands and short single-line messages", () => {
    expect(isTrivialToSummarize("/build-app")).toBe(true);
    expect(isTrivialToSummarize("merci")).toBe(true);
    expect(isTrivialToSummarize("")).toBe(true);
  });
  it("is NOT trivial for long or multi-line messages (Haiku earns its keep)", () => {
    expect(isTrivialToSummarize("a".repeat(60))).toBe(false);
    expect(isTrivialToSummarize("ligne 1\nligne 2")).toBe(false);
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
    const msg = "un message assez long pour un vrai résumé Haiku";
    triggerLastMessageSummary("c1", null, msg);
    expect(valueOf("c1")).toBe(summaryPreview(msg));
    expect(genMock).not.toHaveBeenCalled();
  });

  it("bumps the seq on each send so a superseded response can be dropped", () => {
    triggerLastMessageSummary("c1", "session-1", "premier message long à résumer via le petit modèle");
    triggerLastMessageSummary("c1", "session-1", "deuxième message long à résumer via le petit modèle");
    expect(genMock).toHaveBeenLastCalledWith("session-1", expect.stringContaining("deuxième"), 2);
  });
});

describe("apply (seq gate)", () => {
  it("applies a summary whose seq matches the conversation's latest message", () => {
    triggerLastMessageSummary("c1", "session-1", "message long pour déclencher une génération Haiku");
    useLastMessageSummaryStore.getState().apply("c1", "Résumé frais", 1);
    expect(valueOf("c1")).toBe("Résumé frais");
  });

  it("drops a stale (superseded) response — a newer message advanced the seq", () => {
    const msg2 = "deuxième message long à résumer via le petit modèle";
    triggerLastMessageSummary("c1", "session-1", "premier message long à résumer via le petit modèle");
    triggerLastMessageSummary("c1", "session-1", msg2);
    // The Haiku for message #1 (seq 1) lands late — it must NOT clobber #2's preview.
    useLastMessageSummaryStore.getState().apply("c1", "Résumé périmé du 1er", 1);
    expect(valueOf("c1")).toBe(summaryPreview(msg2));
    // The Haiku for #2 (seq 2) applies.
    useLastMessageSummaryStore.getState().apply("c1", "Résumé du 2e", 2);
    expect(valueOf("c1")).toBe("Résumé du 2e");
  });

  it("clear() forgets the conversation and resets its seq", () => {
    triggerLastMessageSummary("c1", "session-1", "message long à résumer");
    useLastMessageSummaryStore.getState().clear("c1");
    expect(valueOf("c1")).toBeUndefined();
    // After clear, the next send starts a fresh seq at 1 (a late seq-2 from before is dropped).
    useLastMessageSummaryStore.getState().apply("c1", "fantôme", 2);
    expect(valueOf("c1")).toBeUndefined();
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";

const KEY = "tosse:composer-drafts";

// The store reads localStorage at module-eval time, so each load-behaviour test
// sets localStorage then imports a FRESH module instance.
async function freshStore() {
  vi.resetModules();
  return await import("./composerDrafts");
}

describe("composerDrafts store", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to an empty draft for an unknown conversation", async () => {
    const { useComposerDrafts } = await freshStore();
    expect(useComposerDrafts.getState().drafts["conv-x"] ?? "").toBe("");
  });

  it("loads a stored map and keeps each conversation's draft", async () => {
    localStorage.setItem(KEY, JSON.stringify({ "conv-a": "hello", "conv-b": "wip" }));
    const { useComposerDrafts } = await freshStore();
    const { drafts } = useComposerDrafts.getState();
    expect(drafts["conv-a"]).toBe("hello");
    expect(drafts["conv-b"]).toBe("wip");
  });

  it("falls back to an empty map on malformed JSON", async () => {
    localStorage.setItem(KEY, "{ not valid json");
    const { useComposerDrafts } = await freshStore();
    expect(useComposerDrafts.getState().drafts).toEqual({});
  });

  it("ignores non-string entries from an older/corrupt payload", async () => {
    localStorage.setItem(KEY, JSON.stringify({ "conv-a": "ok", "conv-b": 42, "conv-c": true }));
    const { useComposerDrafts } = await freshStore();
    expect(useComposerDrafts.getState().drafts).toEqual({ "conv-a": "ok" });
  });

  it("setDraft() persists per conversation without touching the others", async () => {
    localStorage.setItem(KEY, JSON.stringify({ "conv-a": "keep" }));
    const { useComposerDrafts } = await freshStore();
    useComposerDrafts.getState().setDraft("conv-b", "typing…");

    const st = useComposerDrafts.getState();
    expect(st.drafts["conv-b"]).toBe("typing…");
    expect(st.drafts["conv-a"]).toBe("keep"); // untouched

    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({
      "conv-a": "keep",
      "conv-b": "typing…",
    });
  });

  it("setDraft('') drops the key (empty == no draft) instead of storing an empty string", async () => {
    localStorage.setItem(KEY, JSON.stringify({ "conv-a": "draft", "conv-b": "other" }));
    const { useComposerDrafts } = await freshStore();
    useComposerDrafts.getState().setDraft("conv-a", "");

    expect(useComposerDrafts.getState().drafts).toEqual({ "conv-b": "other" });
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ "conv-b": "other" });
  });

  it("useComposerDraft survives a remount (re-read from localStorage)", async () => {
    const first = await freshStore();
    first.useComposerDrafts.getState().setDraft("conv-a", "unsent");
    // Simulate an app restart / fresh module load — the draft must come back.
    const second = await freshStore();
    expect(second.useComposerDrafts.getState().drafts["conv-a"]).toBe("unsent");
  });

  it("clearComposerDraft() forgets one conversation only", async () => {
    localStorage.setItem(KEY, JSON.stringify({ "conv-a": "a", "conv-b": "b" }));
    const { useComposerDrafts, clearComposerDraft } = await freshStore();
    clearComposerDraft("conv-a");
    expect(useComposerDrafts.getState().drafts).toEqual({ "conv-b": "b" });
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ "conv-b": "b" });
  });

  it("clearAllComposerDrafts() wipes everything", async () => {
    localStorage.setItem(KEY, JSON.stringify({ "conv-a": "a", "conv-b": "b" }));
    const { useComposerDrafts, clearAllComposerDrafts } = await freshStore();
    clearAllComposerDrafts();
    expect(useComposerDrafts.getState().drafts).toEqual({});
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});

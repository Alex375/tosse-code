import { describe, it, expect, beforeEach, vi } from "vitest";

const KEY = "tosse:workfold";

// The store reads localStorage at module-eval time, so each load-behaviour test sets
// localStorage then imports a FRESH module instance.
async function freshStore() {
  vi.resetModules();
  return await import("./workFold");
}

describe("workFold store", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to collapsed (false) for an unknown conversation/round", async () => {
    const { useWorkFold } = await freshStore();
    const open = useWorkFold.getState().open["conv-x"]?.["round-1"] ?? false;
    expect(open).toBe(false);
  });

  it("loads a stored map, keeping each conversation's rounds", async () => {
    localStorage.setItem(KEY, JSON.stringify({ "conv-a": { r1: true }, "conv-b": { r2: true } }));
    const { useWorkFold } = await freshStore();
    const { open } = useWorkFold.getState();
    expect(open["conv-a"].r1).toBe(true);
    expect(open["conv-b"].r2).toBe(true);
  });

  it("falls back to an empty map on malformed JSON", async () => {
    localStorage.setItem(KEY, "{ not valid json");
    const { useWorkFold } = await freshStore();
    expect(useWorkFold.getState().open).toEqual({});
  });

  it("toggle() flips one round without touching sibling rounds or conversations", async () => {
    localStorage.setItem(KEY, JSON.stringify({ "conv-a": { r1: true } }));
    const { useWorkFold } = await freshStore();
    useWorkFold.getState().toggle("conv-a", "r2"); // r2 was absent (collapsed) → opens
    useWorkFold.getState().toggle("conv-b", "r9"); // brand-new conversation

    const { open } = useWorkFold.getState();
    expect(open["conv-a"].r1).toBe(true); // untouched
    expect(open["conv-a"].r2).toBe(true); // newly opened
    expect(open["conv-b"].r9).toBe(true);

    // Toggling again collapses it back.
    useWorkFold.getState().toggle("conv-a", "r2");
    expect(useWorkFold.getState().open["conv-a"].r2).toBe(false);
  });

  it("persists toggles to localStorage", async () => {
    const { useWorkFold } = await freshStore();
    useWorkFold.getState().toggle("conv-a", "r1");
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ "conv-a": { r1: true } });
  });

  it("a toggle survives a remount (re-read from localStorage), the core switch-survival case", async () => {
    const first = await freshStore();
    first.useWorkFold.getState().toggle("conv-a", "r1");
    // Simulate switching conversation & coming back / app restart — a fresh module load.
    const second = await freshStore();
    expect(second.useWorkFold.getState().open["conv-a"]?.r1).toBe(true);
  });

  it("clearWorkFold() forgets one conversation only", async () => {
    localStorage.setItem(KEY, JSON.stringify({ "conv-a": { r1: true }, "conv-b": { r2: true } }));
    const { useWorkFold, clearWorkFold } = await freshStore();
    clearWorkFold("conv-a");
    expect(useWorkFold.getState().open).toEqual({ "conv-b": { r2: true } });
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ "conv-b": { r2: true } });
  });

  it("clearAllWorkFold() wipes everything", async () => {
    localStorage.setItem(KEY, JSON.stringify({ "conv-a": { r1: true } }));
    const { useWorkFold, clearAllWorkFold } = await freshStore();
    clearAllWorkFold();
    expect(useWorkFold.getState().open).toEqual({});
  });
});

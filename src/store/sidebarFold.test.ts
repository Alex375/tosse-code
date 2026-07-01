import { describe, it, expect, beforeEach, vi } from "vitest";

const KEY = "tosse:sidebarfold";

// The store reads localStorage at module-eval time, so each load-behaviour test sets
// localStorage then imports a FRESH module instance.
async function freshStore() {
  vi.resetModules();
  return await import("./sidebarFold");
}

describe("sidebarFold store", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to expanded (not collapsed) for an unknown repo", async () => {
    const { useSidebarFold } = await freshStore();
    expect(useSidebarFold.getState().collapsed.has("repo-x")).toBe(false);
  });

  it("loads a stored array of collapsed repo ids", async () => {
    localStorage.setItem(KEY, JSON.stringify(["repo-a", "repo-b"]));
    const { useSidebarFold } = await freshStore();
    const { collapsed } = useSidebarFold.getState();
    expect(collapsed.has("repo-a")).toBe(true);
    expect(collapsed.has("repo-b")).toBe(true);
    expect(collapsed.has("repo-c")).toBe(false);
  });

  it("falls back to an empty set on malformed JSON", async () => {
    localStorage.setItem(KEY, "{ not valid json");
    const { useSidebarFold } = await freshStore();
    expect(useSidebarFold.getState().collapsed.size).toBe(0);
  });

  it("falls back to an empty set when the stored value is not an array", async () => {
    localStorage.setItem(KEY, JSON.stringify({ repo: true }));
    const { useSidebarFold } = await freshStore();
    expect(useSidebarFold.getState().collapsed.size).toBe(0);
  });

  it("toggle() collapses then expands one repo without touching siblings", async () => {
    localStorage.setItem(KEY, JSON.stringify(["repo-a"]));
    const { useSidebarFold } = await freshStore();
    useSidebarFold.getState().toggle("repo-b"); // absent → collapse
    expect(useSidebarFold.getState().collapsed.has("repo-a")).toBe(true); // untouched
    expect(useSidebarFold.getState().collapsed.has("repo-b")).toBe(true);

    useSidebarFold.getState().toggle("repo-b"); // present → expand
    expect(useSidebarFold.getState().collapsed.has("repo-b")).toBe(false);
    expect(useSidebarFold.getState().collapsed.has("repo-a")).toBe(true);
  });

  it("toggle() produces a NEW Set reference (so has-based selectors re-render)", async () => {
    const { useSidebarFold } = await freshStore();
    const before = useSidebarFold.getState().collapsed;
    useSidebarFold.getState().toggle("repo-a");
    expect(useSidebarFold.getState().collapsed).not.toBe(before);
  });

  it("persists toggles to localStorage as an array", async () => {
    const { useSidebarFold } = await freshStore();
    useSidebarFold.getState().toggle("repo-a");
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["repo-a"]);
  });

  it("a collapse survives a fresh module load (app restart)", async () => {
    const first = await freshStore();
    first.useSidebarFold.getState().toggle("repo-a");
    const second = await freshStore();
    expect(second.useSidebarFold.getState().collapsed.has("repo-a")).toBe(true);
  });

  it("clearSidebarFold() forgets one repo only", async () => {
    localStorage.setItem(KEY, JSON.stringify(["repo-a", "repo-b"]));
    const { useSidebarFold, clearSidebarFold } = await freshStore();
    clearSidebarFold("repo-a");
    expect(useSidebarFold.getState().collapsed.has("repo-a")).toBe(false);
    expect(useSidebarFold.getState().collapsed.has("repo-b")).toBe(true);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["repo-b"]);
  });

  it("clearAllSidebarFold() wipes everything", async () => {
    localStorage.setItem(KEY, JSON.stringify(["repo-a", "repo-b"]));
    const { useSidebarFold, clearAllSidebarFold } = await freshStore();
    clearAllSidebarFold();
    expect(useSidebarFold.getState().collapsed.size).toBe(0);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([]);
  });
});

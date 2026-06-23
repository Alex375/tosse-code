import { describe, it, expect, beforeEach, vi } from "vitest";

const KEY = "tosse:todobar-open";

// The store reads localStorage at module-eval time, so each load-behaviour test
// sets localStorage then imports a FRESH module instance.
async function freshStore() {
  vi.resetModules();
  return await import("./todoBarUi");
}

describe("todoBarUi store", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to open for an unknown conversation", async () => {
    const { useTodoBarUi } = await freshStore();
    expect(useTodoBarUi.getState().open["conv-x"] ?? true).toBe(true);
  });

  it("loads a stored map and keeps each conversation's state", async () => {
    localStorage.setItem(KEY, JSON.stringify({ "conv-a": false, "conv-b": true }));
    const { useTodoBarUi } = await freshStore();
    const { open } = useTodoBarUi.getState();
    expect(open["conv-a"]).toBe(false);
    expect(open["conv-b"]).toBe(true);
  });

  it("falls back to an empty map on malformed JSON", async () => {
    localStorage.setItem(KEY, "{ not valid json");
    const { useTodoBarUi } = await freshStore();
    expect(useTodoBarUi.getState().open).toEqual({});
  });

  it("ignores non-boolean entries from an older/corrupt payload", async () => {
    localStorage.setItem(KEY, JSON.stringify({ "conv-a": false, "conv-b": "nope", "conv-c": 1 }));
    const { useTodoBarUi } = await freshStore();
    const { open } = useTodoBarUi.getState();
    expect(open).toEqual({ "conv-a": false });
  });

  it("setOpen() persists per conversation without touching the others", async () => {
    localStorage.setItem(KEY, JSON.stringify({ "conv-a": true }));
    const { useTodoBarUi } = await freshStore();
    useTodoBarUi.getState().setOpen("conv-b", false);

    const st = useTodoBarUi.getState();
    expect(st.open["conv-b"]).toBe(false);
    expect(st.open["conv-a"]).toBe(true); // untouched

    const stored = JSON.parse(localStorage.getItem(KEY)!);
    expect(stored).toEqual({ "conv-a": true, "conv-b": false });
  });

  it("setOpen() flips an existing conversation back and forth", async () => {
    const { useTodoBarUi } = await freshStore();
    useTodoBarUi.getState().setOpen("conv-a", false);
    expect(useTodoBarUi.getState().open["conv-a"]).toBe(false);
    useTodoBarUi.getState().setOpen("conv-a", true);
    expect(useTodoBarUi.getState().open["conv-a"]).toBe(true);
    expect(JSON.parse(localStorage.getItem(KEY)!)["conv-a"]).toBe(true);
  });
});

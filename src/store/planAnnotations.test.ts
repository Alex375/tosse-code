import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PlanAnnotation } from "./planAnnotations";

const ANN_KEY = "tosse:planannotations";
const NOTE_KEY = "tosse:plannotes";

// The store reads localStorage at module-eval time, so each test imports a FRESH module.
async function freshStore() {
  vi.resetModules();
  return await import("./planAnnotations");
}

const ann = (id: string, comment: string): PlanAnnotation => ({
  id,
  start: 0,
  end: 5,
  quote: "hello",
  comment,
});

describe("planAnnotations store", () => {
  beforeEach(() => localStorage.clear());

  it("adds and removes an annotation, persisting to localStorage", async () => {
    const { usePlanAnnotationsStore } = await freshStore();
    usePlanAnnotationsStore.getState().add("conv", "tool", ann("a1", "risqué"));
    expect(usePlanAnnotationsStore.getState().byConv.conv.tool).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(ANN_KEY)!).conv.tool[0].comment).toBe("risqué");

    usePlanAnnotationsStore.getState().remove("conv", "tool", "a1");
    // Emptying a tool prunes the conversation entirely.
    expect(usePlanAnnotationsStore.getState().byConv.conv).toBeUndefined();
  });

  it("stores and clears the general note under a separate key", async () => {
    const { usePlanAnnotationsStore } = await freshStore();
    usePlanAnnotationsStore.getState().setNote("conv", "tool", "trop ambitieux");
    expect(usePlanAnnotationsStore.getState().notes.conv.tool).toBe("trop ambitieux");
    expect(JSON.parse(localStorage.getItem(NOTE_KEY)!).conv.tool).toBe("trop ambitieux");

    usePlanAnnotationsStore.getState().setNote("conv", "tool", "");
    expect(usePlanAnnotationsStore.getState().notes.conv).toBeUndefined();
  });

  it("survives a remount (re-read from localStorage) — the switch-survival case", async () => {
    const first = await freshStore();
    first.usePlanAnnotationsStore.getState().add("conv", "tool", ann("a1", "note"));
    first.usePlanAnnotationsStore.getState().setNote("conv", "tool", "général");
    const second = await freshStore();
    expect(second.usePlanAnnotationsStore.getState().byConv.conv.tool[0].comment).toBe("note");
    expect(second.usePlanAnnotationsStore.getState().notes.conv.tool).toBe("général");
  });

  it("clearConversation forgets both annotations and notes for one conversation only", async () => {
    const { usePlanAnnotationsStore, clearPlanAnnotations } = await freshStore();
    usePlanAnnotationsStore.getState().add("a", "t", ann("x", "c"));
    usePlanAnnotationsStore.getState().setNote("a", "t", "n");
    usePlanAnnotationsStore.getState().add("b", "t", ann("y", "c"));
    clearPlanAnnotations("a");
    expect(usePlanAnnotationsStore.getState().byConv.a).toBeUndefined();
    expect(usePlanAnnotationsStore.getState().notes.a).toBeUndefined();
    expect(usePlanAnnotationsStore.getState().byConv.b).toBeDefined();
  });

  it("snapshot → clear → restore round-trips a conversation's plan state (the undo case)", async () => {
    const { usePlanAnnotationsStore, snapshotPlanAnnotations, restorePlanAnnotations, clearPlanAnnotations } =
      await freshStore();
    usePlanAnnotationsStore.getState().add("conv", "tool", ann("a1", "revois ça"));
    usePlanAnnotationsStore.getState().setNote("conv", "tool", "note générale");

    const snap = snapshotPlanAnnotations("conv");
    expect(snap).not.toBeNull();

    clearPlanAnnotations("conv"); // the delete
    expect(usePlanAnnotationsStore.getState().byConv.conv).toBeUndefined();
    expect(usePlanAnnotationsStore.getState().notes.conv).toBeUndefined();

    restorePlanAnnotations("conv", snap); // the ⌘Z undo
    expect(usePlanAnnotationsStore.getState().byConv.conv.tool[0].comment).toBe("revois ça");
    expect(usePlanAnnotationsStore.getState().notes.conv.tool).toBe("note générale");
  });

  it("the snapshot is decoupled from later store mutations", async () => {
    const { usePlanAnnotationsStore, snapshotPlanAnnotations, restorePlanAnnotations, clearPlanAnnotations } =
      await freshStore();
    usePlanAnnotationsStore.getState().add("conv", "tool", ann("a1", "original"));
    const snap = snapshotPlanAnnotations("conv");
    // Mutate the live store AFTER snapshotting.
    usePlanAnnotationsStore.getState().add("conv", "tool", ann("a2", "later"));
    clearPlanAnnotations("conv");
    restorePlanAnnotations("conv", snap);
    // Only the snapshotted annotation comes back, not the post-snapshot one.
    const list = usePlanAnnotationsStore.getState().byConv.conv.tool;
    expect(list).toHaveLength(1);
    expect(list[0].comment).toBe("original");
  });

  it("snapshot of an empty conversation is null, and restoring null is a no-op", async () => {
    const { usePlanAnnotationsStore, snapshotPlanAnnotations, restorePlanAnnotations } = await freshStore();
    expect(snapshotPlanAnnotations("nope")).toBeNull();
    restorePlanAnnotations("nope", null);
    expect(usePlanAnnotationsStore.getState().byConv.nope).toBeUndefined();
  });
});

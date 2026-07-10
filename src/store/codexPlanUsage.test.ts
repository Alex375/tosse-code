import { describe, it, expect, beforeEach } from "vitest";
import { useCodexPlanUsageStore } from "./codexPlanUsage";
import type { PlanUsage } from "../ipc/client";

const win = (p: number) => ({ used_percentage: p, resets_at: null });

describe("codexPlanUsage store", () => {
  beforeEach(() => useCodexPlanUsageStore.getState().clear());

  it("stores a full snapshot", () => {
    const u: PlanUsage = { five_hour: win(10), seven_day: win(20) };
    useCodexPlanUsageStore.getState().set(u);
    const s = useCodexPlanUsageStore.getState();
    expect(s.usage?.five_hour?.used_percentage).toBe(10);
    expect(s.usage?.seven_day?.used_percentage).toBe(20);
    expect(s.updatedAt).not.toBeNull();
  });

  it("merges a sparse push, keeping the untouched window", () => {
    // Rate-limit pushes are sparse: a push may carry only the window that moved.
    useCodexPlanUsageStore.getState().set({ five_hour: win(10), seven_day: win(20) });
    useCodexPlanUsageStore.getState().set({ five_hour: win(15), seven_day: null });
    const s = useCodexPlanUsageStore.getState();
    // five_hour updated, seven_day preserved from the previous snapshot.
    expect(s.usage?.five_hour?.used_percentage).toBe(15);
    expect(s.usage?.seven_day?.used_percentage).toBe(20);
  });

  it("clear() forgets the snapshot", () => {
    useCodexPlanUsageStore.getState().set({ five_hour: win(10), seven_day: null });
    useCodexPlanUsageStore.getState().clear();
    const s = useCodexPlanUsageStore.getState();
    expect(s.usage).toBeNull();
    expect(s.updatedAt).toBeNull();
  });
});

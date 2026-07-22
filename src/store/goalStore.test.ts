import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GoalState } from "../ipc/client";

const ok = <T>(data: T) => ({ status: "ok" as const, data });
const err = (error: string) => ({ status: "error" as const, error });

vi.mock("../ipc/client", () => ({
  commands: {
    loadSessionGoal: vi.fn(),
  },
}));

import { commands } from "../ipc/client";
import {
  useGoalStore,
  refreshActiveGoal,
  seedActiveGoalOnce,
  beginGoalClearing,
  settleGoalClearing,
  endGoalClearing,
  markGoalSeen,
  hasSeenGoal,
  isGoalCommand,
} from "./goalStore";

const GOAL: GoalState = { condition: "all tests pass", reason: "2 failing" };

beforeEach(() => {
  // clearAll resets byConv AND the module-level goalSeen / clearing guards.
  useGoalStore.getState().clearAll();
  vi.mocked(commands.loadSessionGoal).mockReset();
});

describe("goalStore", () => {
  it("refreshActiveGoal loads the goal and marks the conversation goalSeen", async () => {
    vi.mocked(commands.loadSessionGoal).mockResolvedValue(ok(GOAL));
    await refreshActiveGoal("c1", "sess-1");
    expect(commands.loadSessionGoal).toHaveBeenCalledWith("sess-1");
    expect(useGoalStore.getState().byConv.c1).toEqual(GOAL);
    expect(hasSeenGoal("c1")).toBe(true); // now worth a per-turn refetch
  });

  it("a null read records the key and drops goalSeen (no more per-turn reads)", async () => {
    markGoalSeen("c1");
    vi.mocked(commands.loadSessionGoal).mockResolvedValue(ok(null));
    await refreshActiveGoal("c1", "sess-1");
    expect("c1" in useGoalStore.getState().byConv).toBe(true);
    expect(useGoalStore.getState().byConv.c1).toBeNull();
    expect(hasSeenGoal("c1")).toBe(false);
  });

  it("clears the goal (no IPC) when the conversation has no session id yet", async () => {
    useGoalStore.getState().set("c1", GOAL);
    markGoalSeen("c1");
    await refreshActiveGoal("c1", null);
    expect(commands.loadSessionGoal).not.toHaveBeenCalled();
    expect(useGoalStore.getState().byConv.c1).toBeNull();
    expect(hasSeenGoal("c1")).toBe(false);
  });

  it("leaves the last known goal untouched on an IPC error", async () => {
    useGoalStore.getState().set("c1", GOAL);
    vi.mocked(commands.loadSessionGoal).mockResolvedValue(err("boom"));
    await refreshActiveGoal("c1", "sess-1");
    expect(useGoalStore.getState().byConv.c1).toEqual(GOAL);
  });

  it("set short-circuits an equal update (same object reference kept)", () => {
    useGoalStore.getState().set("c1", { condition: "x", reason: null });
    const before = useGoalStore.getState().byConv;
    useGoalStore.getState().set("c1", { condition: "x", reason: null });
    expect(useGoalStore.getState().byConv).toBe(before);
  });

  it("clear guard: while the clear send is IN FLIGHT, a stale still-active read is frozen out", async () => {
    useGoalStore.getState().set("c1", GOAL);
    beginGoalClearing("c1"); // arm at click
    useGoalStore.getState().set("c1", null); // optimistic hide
    // A busy edge fires during the (possibly cold-spawn) send: the transcript still reads active.
    vi.mocked(commands.loadSessionGoal).mockResolvedValue(ok(GOAL));
    await refreshActiveGoal("c1", "sess-1");
    expect(useGoalStore.getState().byConv.c1).toBeNull(); // NOT flipped back on
  });

  it("clear guard: after settle (send accepted), a confirmed null read settles it; a new goal then shows", async () => {
    useGoalStore.getState().set("c1", GOAL);
    beginGoalClearing("c1");
    useGoalStore.getState().set("c1", null);
    settleGoalClearing("c1"); // send accepted → grace window
    // The clear landed: a null read releases the guard.
    vi.mocked(commands.loadSessionGoal).mockResolvedValue(ok(null));
    await refreshActiveGoal("c1", "sess-1");
    expect(useGoalStore.getState().byConv.c1).toBeNull();
    // A genuinely new goal set afterwards is shown normally.
    vi.mocked(commands.loadSessionGoal).mockResolvedValue(ok(GOAL));
    await refreshActiveGoal("c1", "sess-1");
    expect(useGoalStore.getState().byConv.c1).toEqual(GOAL);
  });

  it("clear ROLLBACK: on send failure, endGoalClearing releases so the still-active goal is restored", async () => {
    useGoalStore.getState().set("c1", GOAL);
    beginGoalClearing("c1");
    useGoalStore.getState().set("c1", null); // optimistic hide
    endGoalClearing("c1"); // send failed → release the guard
    // The rollback refetch reads the still-active goal and restores the chip.
    vi.mocked(commands.loadSessionGoal).mockResolvedValue(ok(GOAL));
    await refreshActiveGoal("c1", "sess-1");
    expect(useGoalStore.getState().byConv.c1).toEqual(GOAL);
  });

  it("seedActiveGoalOnce reads the transcript once, then skips (survives relaunch, no re-reads)", async () => {
    vi.mocked(commands.loadSessionGoal).mockResolvedValue(ok(GOAL));
    seedActiveGoalOnce("c1", "sess-1");
    await Promise.resolve();
    await Promise.resolve();
    expect(commands.loadSessionGoal).toHaveBeenCalledTimes(1);
    expect(useGoalStore.getState().byConv.c1).toEqual(GOAL);
    seedActiveGoalOnce("c1", "sess-1");
    expect(commands.loadSessionGoal).toHaveBeenCalledTimes(1);
  });

  it("isGoalCommand matches /goal invocations, not prose mentions", () => {
    expect(isGoalCommand("/goal all tests pass")).toBe(true);
    expect(isGoalCommand("/goal clear")).toBe(true);
    expect(isGoalCommand("/goal")).toBe(true);
    expect(isGoalCommand("  /goal x")).toBe(true); // leading whitespace ok
    expect(isGoalCommand("/goalie save")).toBe(false); // word-bounded
    expect(isGoalCommand("please run /goal")).toBe(false); // not at the start
    expect(isGoalCommand("set a goal")).toBe(false);
  });

  it("clear prunes byConv + goalSeen; clearAll wipes everything", () => {
    useGoalStore.getState().set("c1", GOAL);
    markGoalSeen("c1");
    useGoalStore.getState().set("c2", { condition: "y", reason: null });
    useGoalStore.getState().clear("c1");
    expect("c1" in useGoalStore.getState().byConv).toBe(false);
    expect(hasSeenGoal("c1")).toBe(false); // module-level slice pruned too
    expect(useGoalStore.getState().byConv.c2).toBeTruthy();
    markGoalSeen("c2");
    useGoalStore.getState().clearAll();
    expect(useGoalStore.getState().byConv).toEqual({});
    expect(hasSeenGoal("c2")).toBe(false);
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import type { BackgroundTask } from "../ipc/client";
import { orderBashTasks, useBackgroundTasksStore } from "./backgroundTasksStore";

function task(over: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    task_id: "tk1",
    kind: "agent",
    tool_use_id: "toolu_1",
    label: "do the thing",
    subagent_type: "Explore",
    model: "claude-haiku-4-5",
    agent_id: "aa11",
    status: "running",
    progress: null,
    tokens: null,
    tool_uses: null,
    duration_ms: null,
    summary: null,
    output_file: null,
    ...over,
  };
}

describe("backgroundTasksStore", () => {
  beforeEach(() => useBackgroundTasksStore.getState().clear());

  it("applyTask registers a task under its conversation, keyed by task_id", () => {
    useBackgroundTasksStore.getState().applyTask("conv-a", task());
    expect(useBackgroundTasksStore.getState().sessions["conv-a"]["tk1"].status).toBe("running");
  });

  it("applyTask replaces by task_id (snapshots are cumulative, not patches)", () => {
    const { applyTask } = useBackgroundTasksStore.getState();
    applyTask("conv-a", task());
    applyTask("conv-a", task({ status: "completed", tokens: 1200, duration_ms: 4321 }));
    const t = useBackgroundTasksStore.getState().sessions["conv-a"]["tk1"];
    expect(t.status).toBe("completed");
    expect(t.tokens).toBe(1200);
    expect(t.duration_ms).toBe(4321);
  });

  it("is idempotent on an identical re-delivery (no state churn)", () => {
    const { applyTask } = useBackgroundTasksStore.getState();
    applyTask("conv-a", task());
    const before = useBackgroundTasksStore.getState().sessions;
    applyTask("conv-a", task()); // same snapshot (Tauri delivers at-least-once)
    expect(useBackgroundTasksStore.getState().sessions).toBe(before); // same reference
  });

  it("a model change is NOT deduped (the sub-agent's model must reach the UI)", () => {
    const { applyTask } = useBackgroundTasksStore.getState();
    applyTask("conv-a", task({ model: null }));
    const before = useBackgroundTasksStore.getState().sessions;
    applyTask("conv-a", task({ model: "claude-haiku-4-5" }));
    expect(useBackgroundTasksStore.getState().sessions).not.toBe(before); // re-rendered
    expect(useBackgroundTasksStore.getState().sessions["conv-a"]["tk1"].model).toBe(
      "claude-haiku-4-5",
    );
  });

  it("keeps tasks of different conversations isolated", () => {
    const { applyTask } = useBackgroundTasksStore.getState();
    applyTask("conv-a", task({ task_id: "tk1" }));
    applyTask("conv-b", task({ task_id: "tk2" }));
    expect(Object.keys(useBackgroundTasksStore.getState().sessions["conv-a"])).toEqual(["tk1"]);
    expect(Object.keys(useBackgroundTasksStore.getState().sessions["conv-b"])).toEqual(["tk2"]);
  });

  it("dropSession forgets one conversation's tasks only", () => {
    const { applyTask, dropSession } = useBackgroundTasksStore.getState();
    applyTask("conv-a", task());
    applyTask("conv-b", task({ task_id: "tk2" }));
    dropSession("conv-a");
    expect(useBackgroundTasksStore.getState().sessions["conv-a"]).toBeUndefined();
    expect(useBackgroundTasksStore.getState().sessions["conv-b"]).toBeDefined();
  });

  it("endSession flips still-running tasks to stopped (leaves finished ones)", () => {
    const { applyTask, endSession } = useBackgroundTasksStore.getState();
    applyTask("conv-a", task({ task_id: "r", status: "running" }));
    applyTask("conv-a", task({ task_id: "d", status: "completed" }));
    endSession("conv-a");
    const tasks = useBackgroundTasksStore.getState().sessions["conv-a"];
    expect(tasks["r"].status).toBe("stopped");
    expect(tasks["d"].status).toBe("completed"); // untouched
  });

  it("clear wipes everything", () => {
    useBackgroundTasksStore.getState().applyTask("conv-a", task());
    useBackgroundTasksStore.getState().clear();
    expect(useBackgroundTasksStore.getState().sessions).toEqual({});
  });
});

describe("orderBashTasks", () => {
  const map = (...ts: BackgroundTask[]): Record<string, BackgroundTask> =>
    Object.fromEntries(ts.map((t) => [t.task_id, t]));

  it("keeps only RUNNING bash (drops agent/monitor/workflow AND finished bash)", () => {
    const got = orderBashTasks(
      map(
        task({ task_id: "a", kind: "agent", status: "running" }),
        task({ task_id: "b", kind: "bash", status: "running" }),
        task({ task_id: "m", kind: "monitor", status: "running" }),
        task({ task_id: "w", kind: "workflow", status: "running" }),
        task({ task_id: "done", kind: "bash", status: "completed" }),
        task({ task_id: "stopped", kind: "bash", status: "stopped" }),
        task({ task_id: "failed", kind: "bash", status: "failed" }),
      ),
    );
    expect(got.map((t) => t.task_id)).toEqual(["b"]);
  });

  it("orders running bash by task_id", () => {
    const got = orderBashTasks(
      map(
        task({ task_id: "tk_3", kind: "bash", status: "running" }),
        task({ task_id: "tk_1", kind: "bash", status: "running" }),
        task({ task_id: "tk_2", kind: "bash", status: "running" }),
      ),
    );
    expect(got.map((t) => t.task_id)).toEqual(["tk_1", "tk_2", "tk_3"]);
  });

  it("is empty when there is no RUNNING bash (none, or only finished)", () => {
    expect(orderBashTasks({})).toEqual([]);
    expect(
      orderBashTasks(
        map(
          task({ task_id: "a", kind: "agent", status: "running" }),
          task({ task_id: "d", kind: "bash", status: "completed" }),
        ),
      ),
    ).toEqual([]);
  });
});

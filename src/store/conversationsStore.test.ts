import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub the IPC surface: the store's setters persist via `upsertConversation` and
// push live changes via set*; both return an ok Result. We assert what gets called.
vi.mock("../ipc/client", () => {
  const ok = (data: unknown = null) => Promise.resolve({ status: "ok", data });
  return {
    commands: {
      upsertConversation: vi.fn(() => ok()),
      setActiveConversation: vi.fn(() => ok()),
      setModel: vi.fn(() => ok()),
      setEffortLevel: vi.fn(() => ok()),
      setUltracode: vi.fn(() => ok()),
      setPermissionMode: vi.fn(() => ok()),
      spawnSession: vi.fn(() => ok("session-1")),
      createWorktree: vi.fn(() => ok({ path: "/tmp/wt" })),
    },
  };
});

import { commands } from "../ipc/client";
import {
  ensureConversationSession,
  useConversationsStore,
  type Conversation,
} from "./conversationsStore";

const baseConv = (over: Partial<Conversation> = {}): Conversation => ({
  id: "c1",
  name: "x",
  repoId: "r1",
  cwd: "/tmp/r1",
  createdAt: 1,
  lastActivityAt: 1,
  sessionId: null,
  handle: null,
  liveCwd: null,
  model: "opus",
  effort: "xhigh",
  ultracode: false,
  permissionMode: "default",
  ...over,
});

function seed(conv: Conversation) {
  useConversationsStore.setState({
    repos: [{ id: "r1", path: "/tmp/r1", addedAt: 1 }],
    conversations: [conv],
    activeId: "c1",
  });
}

const conv0 = () => useConversationsStore.getState().conversations[0];

beforeEach(() => {
  vi.clearAllMocks();
  seed(baseConv());
});

describe("conversationsStore — per-conversation controls", () => {
  it("setConvEffort stores the level and clears ultracode", () => {
    useConversationsStore.getState().setConvUltracode("c1"); // turn it on first
    expect(conv0().ultracode).toBe(true);
    useConversationsStore.getState().setConvEffort("c1", "low");
    expect(conv0().effort).toBe("low");
    expect(conv0().ultracode).toBe(false);
  });

  it("setConvUltracode sets xhigh effort + the ultracode flag", () => {
    useConversationsStore.getState().setConvUltracode("c1");
    expect(conv0().effort).toBe("xhigh");
    expect(conv0().ultracode).toBe(true);
  });

  it("setConvModel stores the chosen alias", () => {
    useConversationsStore.getState().setConvModel("c1", "sonnet");
    expect(conv0().model).toBe("sonnet");
  });

  it("setConvPermission stores the mode", () => {
    useConversationsStore.getState().setConvPermission("c1", "plan");
    expect(conv0().permissionMode).toBe("plan");
  });

  it("persists but does NOT push to the CLI when there is no live session", () => {
    useConversationsStore.getState().setConvModel("c1", "sonnet");
    expect(commands.upsertConversation).toHaveBeenCalled(); // persisted
    expect(commands.setModel).not.toHaveBeenCalled(); // nothing live to push to
  });

  it("pushes to the live session when a handle is present", () => {
    seed(baseConv({ handle: "session-7" }));
    useConversationsStore.getState().setConvEffort("c1", "high");
    expect(commands.setEffortLevel).toHaveBeenCalledWith("session-7", "high");
    useConversationsStore.getState().setConvPermission("c1", "acceptEdits");
    expect(commands.setPermissionMode).toHaveBeenCalledWith("session-7", "acceptEdits");
  });
});

describe("conversationsStore — controls applied at spawn", () => {
  it("ensureConversationSession passes the persisted controls to spawn_session", async () => {
    seed(
      baseConv({ model: "sonnet", effort: "high", ultracode: false, permissionMode: "plan" }),
    );
    const handle = await ensureConversationSession("c1");
    expect(handle).toBe("session-1");
    // (cwd, resume, model, effort, permissionMode, ultracode) — the conversation's
    // own controls, NOT the old hardcoded opus/xhigh defaults.
    expect(commands.spawnSession).toHaveBeenCalledWith(
      "/tmp/r1",
      null,
      "sonnet",
      "high",
      "plan",
      false,
    );
  });
});

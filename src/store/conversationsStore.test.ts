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
      generateConversationTitle: vi.fn(() => ok()),
      spawnSession: vi.fn(() => ok("session-1")),
      createWorktree: vi.fn(() => ok({ path: "/tmp/wt" })),
      loadSessionHistory: vi.fn(() => ok([])),
      loadSessionContext: vi.fn(() => ok({ context_tokens: 0 })),
    },
  };
});

import { commands } from "../ipc/client";
import {
  acknowledgeConversation,
  DEFAULT_CONV_NAME,
  ensureConversationSession,
  loadConversationHistory,
  useConversationsStore,
  type Conversation,
} from "./conversationsStore";
import { useConversationStore } from "./conversationStore";

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
  pendingReminder: null,
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

describe("conversationsStore — auto title (VS Code style)", () => {
  const store = () => useConversationsStore.getState();
  // The auto-title state (autoTitlePending / titleContext / titleGenCount /
  // lastAppliedSeq) is module-level and NOT reset between tests, so each test uses a
  // DISTINCT conversation id — its behavior never depends on another test's leftovers.
  const convOf = (id: string) => store().conversations.find((c) => c.id === id)!;

  it("places an optimistic placeholder then applies the generated title", () => {
    seed(baseConv({ id: "t1", name: DEFAULT_CONV_NAME }));
    store().noteFirstMessage("t1", "Aide-moi à corriger le bug de login");
    // Optimistic placeholder (the truncated message) — no longer the default name.
    expect(convOf("t1").name).not.toBe(DEFAULT_CONV_NAME);
    store().applyAutoTitle("t1", "Correction du bug de login", 1);
    expect(convOf("t1").name).toBe("Correction du bug de login");
  });

  it("a manual rename protects against a late-arriving generated title", () => {
    seed(baseConv({ id: "t2", name: DEFAULT_CONV_NAME }));
    store().noteFirstMessage("t2", "première question");
    store().renameConversation("t2", "Mon titre à moi");
    // The generated title arrives AFTER the manual rename — it must be ignored.
    store().applyAutoTitle("t2", "Titre généré", 1);
    expect(convOf("t2").name).toBe("Mon titre à moi");
  });

  it("applyAutoTitle is a no-op on a conversation that never became eligible", () => {
    seed(baseConv({ id: "t3", name: "Titre existant" }));
    store().applyAutoTitle("t3", "Titre généré", 1);
    expect(convOf("t3").name).toBe("Titre existant");
  });

  it("ignores an out-of-order (stale) title response", () => {
    seed(baseConv({ id: "t4", name: DEFAULT_CONV_NAME }));
    store().noteFirstMessage("t4", "premier");
    // The richer (seq 3) response lands first…
    store().applyAutoTitle("t4", "Titre riche", 3);
    expect(convOf("t4").name).toBe("Titre riche");
    // …then the older (seq 1, poorer-context) response arrives late — it must be dropped.
    store().applyAutoTitle("t4", "Titre pauvre", 1);
    expect(convOf("t4").name).toBe("Titre riche");
  });

  it("triggerAutoTitle asks the binary (with its seq) only when eligible AND live", () => {
    seed(baseConv({ id: "t5", name: DEFAULT_CONV_NAME, handle: "session-7" }));
    store().noteFirstMessage("t5", "ma description");
    store().triggerAutoTitle("t5", "ma description");
    expect(commands.generateConversationTitle).toHaveBeenCalledWith("session-7", "ma description", 1);
  });

  it("triggerAutoTitle is a no-op without a live session", () => {
    seed(baseConv({ id: "t6", name: DEFAULT_CONV_NAME, handle: null }));
    store().noteFirstMessage("t6", "ma description");
    store().triggerAutoTitle("t6", "ma description");
    expect(commands.generateConversationTitle).not.toHaveBeenCalled();
  });

  it("regenerates from the accumulated user messages, capped, then freezes", () => {
    seed(baseConv({ id: "t7", name: DEFAULT_CONV_NAME, handle: "session-7" }));
    const s = store();
    s.noteFirstMessage("t7", "/list-tasks");
    s.triggerAutoTitle("t7", "/list-tasks");
    s.triggerAutoTitle("t7", "fais la tâche renommage");
    s.triggerAutoTitle("t7", "ajoute des tests");
    s.triggerAutoTitle("t7", "et un quatrième message"); // over the cap of 3
    // Capped at 3 regenerations.
    expect(commands.generateConversationTitle).toHaveBeenCalledTimes(3);
    // The 2nd generation titles from the ACCUMULATED intent (with its seq), not just
    // the latest msg — this is what unsticks "/list-tasks" → the actual task.
    expect(commands.generateConversationTitle).toHaveBeenNthCalledWith(
      2,
      "session-7",
      "/list-tasks\nfais la tâche renommage",
      2,
    );
  });
});

describe("conversationsStore — persisted reminder", () => {
  it("setReminder stores the kind and persists it", () => {
    useConversationsStore.getState().setReminder("c1", "review");
    expect(conv0().pendingReminder).toBe("review");
    expect(commands.upsertConversation).toHaveBeenCalled();
  });

  it("setReminder is idempotent — no write when unchanged", () => {
    useConversationsStore.getState().setReminder("c1", "error");
    vi.clearAllMocks();
    useConversationsStore.getState().setReminder("c1", "error");
    expect(commands.upsertConversation).not.toHaveBeenCalled();
  });

  it("loadConversationHistory marks the turn seen but PRESERVES the persisted reminder (opening ≠ acknowledging)", async () => {
    // Opening a conversation replays its on-disk transcript and marks it seen (so a
    // HISTORICAL completion doesn't read as a fresh "Claude just finished, go look") —
    // but it must NOT clear the persisted reminder. Only startConversationSession (going
    // live) clears it. This asymmetry is the survive-a-restart guarantee; lock it so a
    // future "unify the loaders" can't silently regress it.
    seed(baseConv({ id: "c-load", sessionId: "sess-load", pendingReminder: "review" }));
    const cs = useConversationStore.getState();
    const ensureSession = vi.spyOn(cs, "ensureSession").mockImplementation(() => {});
    const applyItem = vi.spyOn(cs, "applyItem").mockImplementation(() => {});
    const applyContextFill = vi.spyOn(cs, "applyContextFill").mockImplementation(() => {});
    const markSeen = vi.spyOn(cs, "markSeen").mockImplementation(() => {});
    // Non-empty history so the loader runs past its early return and reaches markSeen.
    vi.mocked(commands.loadSessionHistory).mockResolvedValueOnce({
      status: "ok",
      data: [{}],
    } as never);

    await loadConversationHistory("c-load");

    expect(markSeen).toHaveBeenCalledWith("c-load");
    expect(conv0().pendingReminder).toBe("review"); // NOT cleared
    expect(commands.setActiveConversation).not.toHaveBeenCalled();

    ensureSession.mockRestore();
    applyItem.mockRestore();
    applyContextFill.mockRestore();
    markSeen.mockRestore();
  });

  it("acknowledgeConversation clears the persisted reminder AND marks the live turn seen", () => {
    seed(baseConv({ pendingReminder: "review" }));
    // The helper exists to do BOTH halves; lock in the live one too, so a future
    // change dropping markSeen (which would leave an open conv stuck on "review")
    // fails here.
    const markSeen = vi.spyOn(useConversationStore.getState(), "markSeen");
    acknowledgeConversation("c1");
    expect(markSeen).toHaveBeenCalledWith("c1");
    expect(conv0().pendingReminder).toBeNull();
    expect(commands.upsertConversation).toHaveBeenCalled();
    markSeen.mockRestore();
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

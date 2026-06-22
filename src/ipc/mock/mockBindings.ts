// Browser / Playwright fallback that mirrors the tauri-specta { commands, events }
// surface exactly, but emits scripted fixtures instead of talking to a Rust core.
// Selected at runtime by provider.ts when window.__TAURI_INTERNALS__ is absent.

import type {
  ContextFill,
  ConversationItem,
  ConversationRecord,
  PermissionDecision,
  PermissionMode,
  PersistedState,
  Pong,
  RepoRecord,
  Result,
  SessionCommandsEvent,
  SessionMessageEvent,
  SessionPermissionEvent,
  SessionStatePayload,
  SessionStateEvent,
  SlashCommand,
  TickEvent,
  WorktreeInfo,
  WorktreeStatus,
} from "../bindings";
import { idleState, ScenarioDriver } from "./scenario";

// A small slash-command catalogue so the browser/Playwright build exercises the
// `/` autocomplete menu without a real `claude` process.
// Faithful to the real `initialize` shape: BARE names, plugin carried as a
// leading "(plugin)" in the description (built-ins have none).
const MOCK_COMMANDS: SlashCommand[] = [
  { name: "clear", description: "Start a new session with empty context", argument_hint: "[name]" },
  { name: "compact", description: "Free up context by summarizing the conversation so far", argument_hint: "" },
  { name: "init", description: "Initialize a new CLAUDE.md with codebase documentation", argument_hint: "" },
  { name: "review", description: "Review a pull request", argument_hint: "" },
  { name: "pickup", description: "(tosse-workflow) Start working on a TOSSE task", argument_hint: "<task_id>" },
  { name: "done", description: "(tosse-workflow) Finish a TOSSE task and move it to review", argument_hint: "" },
  { name: "list-tasks", description: "(tosse-workflow) List the tasks for the current project", argument_hint: "" },
  { name: "algorithmic-art", description: "(example-skills) Creating algorithmic art using p5.js with seeded randomness", argument_hint: "" },
  { name: "canvas-design", description: "(example-skills) Create beautiful visual art in .png and .pdf documents", argument_hint: "" },
];

// ---- Minimal Tauri-shaped event emitter -----------------------------------

type EventCb<T> = (e: { payload: T; event: string; id: number }) => void;

class MockEmitter<T> {
  private cbs = new Set<EventCb<T>>();

  listen(cb: EventCb<T>): Promise<() => void> {
    this.cbs.add(cb);
    return Promise.resolve(() => {
      this.cbs.delete(cb);
    });
  }

  once(cb: EventCb<T>): Promise<() => void> {
    const wrapped: EventCb<T> = (e) => {
      this.cbs.delete(wrapped);
      cb(e);
    };
    this.cbs.add(wrapped);
    return Promise.resolve(() => {
      this.cbs.delete(wrapped);
    });
  }

  emit(payload: T): void {
    this.cbs.forEach((cb) => cb({ payload, event: "mock", id: 0 }));
  }
}

const sessionMessageEvent = new MockEmitter<SessionMessageEvent>();
const sessionPermissionEvent = new MockEmitter<SessionPermissionEvent>();
const sessionStateEvent = new MockEmitter<SessionStateEvent>();
const sessionCommandsEvent = new MockEmitter<SessionCommandsEvent>();
const tickEvent = new MockEmitter<TickEvent>();

export const mockEvents = {
  sessionMessageEvent,
  sessionPermissionEvent,
  sessionStateEvent,
  sessionCommandsEvent,
  tickEvent,
};

// ---- Per-session scenario wiring -------------------------------------------

interface SessionRecord {
  driver: ScenarioDriver;
  lastState: SessionStatePayload;
}

const records = new Map<string, SessionRecord>();

function getRecord(session: string): SessionRecord {
  let rec = records.get(session);
  if (!rec) {
    let lastState = idleState();
    const driver = new ScenarioDriver({
      state: (s) => {
        rec!.lastState = s;
        sessionStateEvent.emit({ session, state: s });
      },
      item: (item) => sessionMessageEvent.emit({ session, item }),
      permission: (request) => sessionPermissionEvent.emit({ session, request }),
    });
    rec = { driver, lastState };
    records.set(session, rec);
  }
  return rec;
}

const ok = <T>(data: T): Result<T, string> => ({ status: "ok", data });

let mockCounter = 0;

// ---- Commands (same shape as the generated facade) -------------------------

export const mockCommands = {
  async ping(msg: string): Promise<Pong> {
    return { ok: true, echo: msg, at_ms: Date.now() };
  },

  async fetchSlashCommands(_cwd: string): Promise<Result<SlashCommand[], string>> {
    return ok(MOCK_COMMANDS);
  },

  async spawnSession(
    _repoPath: string,
    _resume: string | null,
    model: string | null,
    effort: string | null,
    permissionMode: string | null,
    ultracode: boolean,
  ): Promise<Result<string, string>> {
    // Unique id per spawn so multiple browser conversations don't collide.
    const session = `mock-session-${++mockCounter}`;
    const rec = getRecord(session);
    // Emit the initial idle state + the slash-command catalogue once listeners
    // have had a tick to subscribe (mirrors the core's initialize handshake).
    // Seed the controls from the spawn args (mirrors the real core's seeding +
    // get_settings read-back), so the indicator reflects the spawned state.
    setTimeout(() => {
      const base = idleState();
      rec.lastState = {
        ...base,
        model: model ?? base.model,
        effort: effort ?? base.effort,
        ultracode,
        permission_mode: permissionMode ?? base.permission_mode,
      };
      sessionStateEvent.emit({ session, state: rec.lastState });
      sessionCommandsEvent.emit({ session, commands: MOCK_COMMANDS });
    }, 30);
    return ok(session);
  },

  async sendMessage(session: string, _text: string): Promise<Result<null, string>> {
    const demo =
      typeof location !== "undefined"
        ? new URLSearchParams(location.search).get("demo")
        : null;
    const driver = getRecord(session).driver;
    if (demo === "question") driver.startQuestion();
    else driver.start();
    return ok(null);
  },

  async answerPermission(
    session: string,
    requestId: string,
    decision: PermissionDecision,
  ): Promise<Result<null, string>> {
    getRecord(session).driver.resolvePermission(requestId, decision);
    return ok(null);
  },

  async setPermissionMode(
    session: string,
    mode: PermissionMode,
  ): Promise<Result<null, string>> {
    const rec = getRecord(session);
    rec.lastState = { ...rec.lastState, permission_mode: mode };
    sessionStateEvent.emit({ session, state: rec.lastState });
    return ok(null);
  },

  async setModel(session: string, model: string): Promise<Result<null, string>> {
    const rec = getRecord(session);
    rec.lastState = { ...rec.lastState, model };
    sessionStateEvent.emit({ session, state: rec.lastState });
    return ok(null);
  },

  async setEffortLevel(
    session: string,
    level: string,
  ): Promise<Result<null, string>> {
    // Mirror the real core's read-back: a plain level clears ultracode, then the
    // state reflects the applied effort.
    const rec = getRecord(session);
    rec.lastState = { ...rec.lastState, effort: level, ultracode: false };
    sessionStateEvent.emit({ session, state: rec.lastState });
    return ok(null);
  },

  async setUltracode(session: string): Promise<Result<null, string>> {
    // Ultra code = xhigh effort + the separate flag (read-back equivalent).
    const rec = getRecord(session);
    rec.lastState = { ...rec.lastState, effort: "xhigh", ultracode: true };
    sessionStateEvent.emit({ session, state: rec.lastState });
    return ok(null);
  },

  async interruptSession(session: string): Promise<Result<null, string>> {
    getRecord(session).driver.interrupt();
    return ok(null);
  },

  async stopSession(session: string): Promise<Result<null, string>> {
    const rec = getRecord(session);
    rec.driver.reset();
    rec.lastState = { ...rec.lastState, busy: false, ended: true };
    sessionStateEvent.emit({ session, state: rec.lastState });
    return ok(null);
  },

  async openInTerminal(cwd: string, sessionId: string): Promise<Result<null, string>> {
    // No OS terminal in the browser mock — just log what the real command would run.
    console.info(`[mock] openInTerminal: cd ${cwd} && claude --resume ${sessionId}`);
    return ok(null);
  },

  async loadSessionHistory(_sessionId: string): Promise<Result<ConversationItem[], string>> {
    // No on-disk transcript in the browser mock — history lives only in the live
    // scenario stream. Empty means "nothing to replay", so reload is a no-op and
    // keeps whatever the scenario already rendered.
    return ok([]);
  },

  async loadSessionContext(_sessionId: string): Promise<Result<ContextFill, string>> {
    // No transcript in the browser mock; the scenario's baseState already carries a
    // context fill, so nothing to seed here.
    return ok({ context_tokens: null, context_window: null });
  },

  // ---- Persistence: in-memory only (no real db in the browser). The store
  // boots empty and persists are no-ops, which is the correct dev behaviour.
  async loadPersistedState(): Promise<Result<PersistedState, string>> {
    return ok({ repos: [], conversations: [], active_id: null });
  },

  async upsertRepo(_repo: RepoRecord): Promise<Result<null, string>> {
    return ok(null);
  },

  async deleteRepo(_id: string): Promise<Result<null, string>> {
    return ok(null);
  },

  async upsertConversation(_conversation: ConversationRecord): Promise<Result<null, string>> {
    return ok(null);
  },

  async deleteConversation(_id: string): Promise<Result<null, string>> {
    return ok(null);
  },

  async setActiveConversation(_id: string | null): Promise<Result<null, string>> {
    return ok(null);
  },

  async wipeAllData(): Promise<Result<null, string>> {
    return ok(null);
  },

  // ---- Git worktrees: in-memory, no real `git` in the browser. Seeds a single
  // main worktree per repo so the indicator/manager render, and reflects
  // create/remove so the UI can be exercised end to end in dev/Playwright.
  async listWorktrees(repoPath: string): Promise<Result<WorktreeInfo[], string>> {
    return ok(mockWorktreeList(repoPath));
  },

  async worktreeStatus(_worktreePath: string): Promise<Result<WorktreeStatus, string>> {
    return ok({ dirty: false, untracked: false, changed_files: 0, ahead: null, behind: null });
  },

  async createWorktree(
    repoPath: string,
    branch: string,
    _baseRef: string | null,
    _newBranch: boolean,
  ): Promise<Result<WorktreeInfo, string>> {
    const list = mockWorktreeList(repoPath);
    const wt: WorktreeInfo = {
      path: `${repoPath.replace(/\/+$/, "")}/.claude/worktrees/${branch.replace(/\//g, "-")}`,
      branch,
      head: "1".repeat(40),
      is_main: false,
      is_detached: false,
      is_locked: false,
      is_bare: false,
    };
    mockWorktrees.set(repoPath, [...list, wt]);
    return ok(wt);
  },

  async removeWorktree(
    repoPath: string,
    worktreePath: string,
    _force: boolean,
  ): Promise<Result<null, string>> {
    mockWorktrees.set(
      repoPath,
      mockWorktreeList(repoPath).filter((w) => w.path !== worktreePath),
    );
    return ok(null);
  },

  async pathExists(_path: string): Promise<boolean> {
    // No real filesystem in the browser mock — everything "exists" so the normal
    // spawn flow runs (the deleted-worktree recovery is exercised in the real app).
    return true;
  },
};

// Per-repo worktree set, seeded lazily with just the main worktree (== repoPath).
const mockWorktrees = new Map<string, WorktreeInfo[]>();
function mockWorktreeList(repoPath: string): WorktreeInfo[] {
  let list = mockWorktrees.get(repoPath);
  if (!list) {
    list = [
      {
        path: repoPath,
        branch: "main",
        head: "0".repeat(40),
        is_main: true,
        is_detached: false,
        is_locked: false,
        is_bare: false,
      },
    ];
    mockWorktrees.set(repoPath, list);
  }
  return list;
}

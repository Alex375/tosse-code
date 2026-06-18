// Browser / Playwright fallback that mirrors the tauri-specta { commands, events }
// surface exactly, but emits scripted fixtures instead of talking to a Rust core.
// Selected at runtime by provider.ts when window.__TAURI_INTERNALS__ is absent.

import type {
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
} from "../bindings";
import { idleState, ScenarioDriver } from "./scenario";

// A small slash-command catalogue so the browser/Playwright build exercises the
// `/` autocomplete menu without a real `claude` process.
const MOCK_COMMANDS: SlashCommand[] = [
  { name: "clear", description: "Clear the conversation history", argument_hint: "" },
  { name: "compact", description: "Compact the conversation to free up context", argument_hint: "" },
  { name: "init", description: "Initialize a new CLAUDE.md with codebase docs", argument_hint: "" },
  { name: "review", description: "Review a pull request", argument_hint: "[pr]" },
  { name: "tosse-workflow:pickup", description: "(tosse-workflow) Start working on a TOSSE task", argument_hint: "<task_id>" },
  { name: "tosse-workflow:done", description: "(tosse-workflow) Finish a task and move it to review", argument_hint: "" },
  { name: "tosse-workflow:list-tasks", description: "(tosse-workflow) List the project's tasks", argument_hint: "" },
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
  ): Promise<Result<string, string>> {
    // Unique id per spawn so multiple browser conversations don't collide.
    const session = `mock-session-${++mockCounter}`;
    const rec = getRecord(session);
    // Emit the initial idle state + the slash-command catalogue once listeners
    // have had a tick to subscribe (mirrors the core's initialize handshake).
    setTimeout(() => {
      rec.lastState = idleState();
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
    _session: string,
    _level: string,
  ): Promise<Result<null, string>> {
    // No server-side effort state; the UI owns the selected level locally.
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
};

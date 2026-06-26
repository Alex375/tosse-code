// Browser / Playwright fallback that mirrors the tauri-specta { commands, events }
// surface exactly, but emits scripted fixtures instead of talking to a Rust core.
// Selected at runtime by provider.ts when window.__TAURI_INTERNALS__ is absent.

import type {
  BranchInfo,
  CommitFile,
  CommitInfo,
  ContextFill,
  ConversationItem,
  ConversationRecord,
  ExtensionsSnapshot,
  FileContent,
  FsChangeEvent,
  FsWatchErrorEvent,
  FsEntry,
  GitDiff,
  GitFileEntry,
  GitStatus,
  ImageContent,
  McpAuthResult,
  McpServerLive,
  PluginContents,
  PermissionDecision,
  PermissionMode,
  PersistedState,
  PlanUsage,
  Pong,
  RepoRecord,
  Result,
  SessionCommandsEvent,
  SessionMessageEvent,
  SessionPermissionEvent,
  SessionStatePayload,
  SessionStateEvent,
  SessionTaskEvent,
  SessionTitleEvent,
  SlashCommand,
  TerminalExitEvent,
  TerminalOutputEvent,
  TickEvent,
  UsageError,
  WorktreeInfo,
  WorktreeStatus,
} from "../bindings";
import { DEMO_SUBAGENT_TRANSCRIPT, idleState, mockTaskOutput, MOCK_SESSION_ID, ScenarioDriver } from "./scenario";

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
const sessionTaskEvent = new MockEmitter<SessionTaskEvent>();
const sessionTitleEvent = new MockEmitter<SessionTitleEvent>();
const tickEvent = new MockEmitter<TickEvent>();
// No real filesystem in the browser mock — these never fire, but must exist so
// the editor's `useFsWatch` can subscribe without crashing.
const fsChangeEvent = new MockEmitter<FsChangeEvent>();
const fsWatchErrorEvent = new MockEmitter<FsWatchErrorEvent>();
// No real PTY in the browser mock — these never fire, but must exist so the
// integrated terminal can subscribe without crashing.
const terminalOutputEvent = new MockEmitter<TerminalOutputEvent>();
const terminalExitEvent = new MockEmitter<TerminalExitEvent>();

export const mockEvents = {
  sessionMessageEvent,
  sessionPermissionEvent,
  sessionStateEvent,
  sessionCommandsEvent,
  sessionTaskEvent,
  sessionTitleEvent,
  tickEvent,
  fsChangeEvent,
  fsWatchErrorEvent,
  terminalOutputEvent,
  terminalExitEvent,
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
      task: (task) => sessionTaskEvent.emit({ session, task }),
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
    else if (demo === "background") driver.startBackground();
    else if (demo === "shell") driver.startShell();
    else if (demo === "monitor") driver.startMonitor();
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

  async generateConversationTitle(
    session: string,
    description: string,
    seq: number,
  ): Promise<Result<null, string>> {
    // No real model in the browser mock — synthesize a plausible short title from
    // the description and emit it (echoing `seq`) like the core would, so the
    // auto-title behavior is exercised end to end in dev/Playwright.
    setTimeout(() => {
      const words = description.trim().replace(/\s+/g, " ").split(" ").slice(0, 6).join(" ");
      const title = words ? words.charAt(0).toUpperCase() + words.slice(1) : "Nouvelle conversation";
      sessionTitleEvent.emit({ session, title, seq });
    }, 40);
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

  async stopTask(session: string, taskId: string): Promise<Result<null, string>> {
    // Mirror the core: the CLI kills the task, which settles to `stopped` via its
    // `task_*` lifecycle. The driver re-emits the known bg task snapshot as stopped
    // (a background Bash command or a Monitor watch).
    getRecord(session).driver.stopTask(taskId);
    return ok(null);
  },

  async readTaskOutputFile(path: string): Promise<Result<string | null, string>> {
    // No on-disk output file in the browser mock — the mock derives the demo task id from
    // the file's basename (`…/tasks/<task_id>.output`) and serves canned logs so the
    // task-output popover (Bash command output AND Monitor event streams) renders
    // real-shaped content (and tails) in dev/Playwright.
    const taskId = path.split("/").pop()?.replace(/\.output$/, "") ?? "";
    return ok(mockTaskOutput(taskId));
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

  async loadSubagentTranscript(
    _sessionId: string,
    _agentId: string,
  ): Promise<Result<ConversationItem[], string>> {
    // No on-disk transcript in the browser mock — return a representative sample so
    // the transcript popover renders real-shaped content in dev/Playwright.
    return ok(DEMO_SUBAGENT_TRANSCRIPT);
  },

  async loadSessionContext(_sessionId: string): Promise<Result<ContextFill, string>> {
    // No transcript in the browser mock; the scenario's baseState already carries a
    // context fill, so nothing to seed here.
    return ok({ context_tokens: null, context_window: null });
  },

  async getPlanUsage(): Promise<Result<PlanUsage, UsageError>> {
    // No real OAuth endpoint in the browser; return plausible fills so the Forfait
    // section of the context popover renders in dev/Playwright. Reset ~2h / ~3d out,
    // as ISO 8601 strings (matching the live endpoint shape).
    const iso = (offsetSec: number) => new Date(Date.now() + offsetSec * 1000).toISOString();
    // Build the ok-arm directly: `ok()` fixes the error type to string, but this
    // command's Result error is UsageError. The mock never takes the error path.
    return {
      status: "ok",
      data: {
        five_hour: { used_percentage: 42, resets_at: iso(2 * 3600) },
        seven_day: { used_percentage: 67, resets_at: iso(3 * 86400) },
      },
    };
  },

  // ---- Persistence: in-memory only (no real db in the browser). The store
  // boots empty and persists are no-ops, which is the correct dev behaviour.
  async loadPersistedState(): Promise<Result<PersistedState, string>> {
    // Adding a repo needs the native folder picker (absent in the browser), so the
    // mock boots empty by default. With any `?demo` flag, seed one repo + conversation
    // so the dev/Playwright build has something to drive (e.g. `?demo=background`).
    const demo =
      typeof location !== "undefined" && new URLSearchParams(location.search).has("demo");
    if (!demo) return ok({ repos: [], conversations: [], active_id: null });
    const now = Date.now();
    return ok({
      repos: [{ id: "repo-demo", path: "/Users/dev/demo-repo", added_at: now }],
      conversations: [
        {
          id: "conv-demo",
          name: "Démo tâches de fond",
          repo_id: "repo-demo",
          cwd: "/Users/dev/demo-repo",
          created_at: now,
          last_activity_at: now,
          session_id: MOCK_SESSION_ID,
          model: "claude-opus-4-8",
          effort: "xhigh",
          ultracode: false,
          permission_mode: "auto",
          pending_reminder: null,
        },
      ],
      active_id: "conv-demo",
    });
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

  // ---- Git history / source control: synthetic data so the Git panel renders in
  // dev/Playwright (no real `git` in the browser). A small DAG with a merge lets
  // the graph layout be eyeballed; writes are accepted as no-ops.
  async gitStatus(_cwd: string): Promise<Result<GitStatus, string>> {
    return ok(MOCK_GIT_STATUS);
  },
  async gitDiff(_cwd: string, path: string): Promise<Result<GitDiff, string>> {
    return ok({
      path,
      old_text: "export function greet(name) {\n  return `Hi ${name}`;\n}\n",
      new_text: "export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n",
      is_binary: false,
      old_label: "HEAD",
      new_label: "Working tree",
    });
  },
  async gitLog(_cwd: string, limit: number, skip: number): Promise<Result<CommitInfo[], string>> {
    return ok(skip >= MOCK_GIT_LOG.length ? [] : MOCK_GIT_LOG.slice(skip, skip + limit));
  },
  async gitBranches(_cwd: string): Promise<Result<BranchInfo[], string>> {
    return ok(MOCK_GIT_BRANCHES);
  },
  async gitCommitFiles(_cwd: string, _oid: string): Promise<Result<CommitFile[], string>> {
    return ok([
      { path: "src/app.ts", orig_path: null, status: "M" },
      { path: "src/new.ts", orig_path: null, status: "A" },
    ]);
  },
  async gitCommitFileDiff(
    _cwd: string,
    oid: string,
    path: string,
  ): Promise<Result<GitDiff, string>> {
    const short = oid.slice(0, 7);
    // A hunk with internal modify + delete — the case the single-trapezoid ribbon
    // used to skew; lets the per-charChange sub-ribbons be eyeballed in dev.
    return ok({
      path,
      old_text:
        'import { foo } from "./foo";\n\nfunction greet(name) {\n  const msg = "hi " + name;\n  log(msg);\n  return msg;\n}\n',
      new_text:
        'import { foo } from "./foo";\n\nfunction greet(name: string): string {\n  const greeting = `Hi ${name}`;\n  return greeting;\n}\n',
      is_binary: false,
      old_label: `${short}^`,
      new_label: short,
    });
  },
  async gitCommit(_cwd: string, _message: string): Promise<Result<string, string>> {
    return ok("deadbee");
  },
  async gitPush(_cwd: string): Promise<Result<null, string>> {
    return ok(null);
  },
  async gitPull(_cwd: string): Promise<Result<null, string>> {
    return ok(null);
  },
  async gitFetch(_cwd: string): Promise<Result<null, string>> {
    return ok(null);
  },

  // ---- Editor filesystem: a tiny synthetic tree so the editor panel renders in
  // the browser/dev build (the real fs is only reachable in the Tauri app).
  // Sentinels `__fail__` (error Result) and `__throw__` (thrown rejection, like a
  // real transport Error) let the unit tests exercise the editor's error paths.
  async readDir(path: string): Promise<Result<FsEntry[], string>> {
    if (path.includes("__throw__")) throw new Error("mock readDir transport failure");
    if (path.includes("__fail__")) return { status: "error", error: "mock readDir failed" };
    return ok(mockDir(path));
  },

  async readFile(path: string): Promise<Result<FileContent, string>> {
    if (path.includes("__throw__")) throw new Error("mock readFile transport failure");
    if (path.includes("__fail__")) return { status: "error", error: "mock readFile failed" };
    return ok(mockFile(path));
  },

  async readImage(path: string): Promise<Result<ImageContent, string>> {
    if (path.includes("__throw__")) throw new Error("mock readImage transport failure");
    if (path.includes("__fail__")) return { status: "error", error: "mock readImage failed" };
    // A 1×1 transparent PNG — enough for the dev/browser build to exercise the
    // image viewer path without a real filesystem.
    const data_base64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    return ok({ path, data_base64, too_large: false, size: 70 });
  },

  async writeFile(_path: string, _content: string): Promise<Result<null, string>> {
    return ok(null);
  },

  async watchDir(_path: string): Promise<Result<null, string>> {
    return ok(null);
  },

  async unwatchDir(): Promise<Result<null, string>> {
    return ok(null);
  },

  // ---- Integrated terminal: no real PTY in the browser mock. The commands are
  // no-ops so the terminal panel mounts without crashing (it just shows an empty
  // shell — output/exit events never fire here).
  async terminalOpen(
    _id: string,
    _cwd: string,
    _cols: number,
    _rows: number,
  ): Promise<Result<null, string>> {
    return ok(null);
  },

  async terminalWrite(_id: string, _data: string): Promise<Result<null, string>> {
    return ok(null);
  },

  async terminalResize(_id: string, _cols: number, _rows: number): Promise<Result<null, string>> {
    return ok(null);
  },

  async terminalClose(_id: string): Promise<Result<null, string>> {
    return ok(null);
  },

  // ---- Extensions (MCP / plugins / skills / agents) — demo fixtures --------
  // Without these, the extensions manager calls `undefined(...)` in `?demo=` mode.
  async listExtensions(_repoPath: string): Promise<Result<ExtensionsSnapshot, string>> {
    return ok({ mcp_servers: [], plugins: [], skills: [], agents: [], warnings: [] });
  },
  async listPluginContents(_repoPath: string, _pluginId: string): Promise<Result<PluginContents, string>> {
    return ok({ skills: [], agents: [], mcp_servers: [] });
  },
  async setPluginEnabled(_pluginId: string, _enabled: boolean): Promise<Result<null, string>> {
    return ok(null);
  },
  async mcpStatus(_session: string): Promise<Result<McpServerLive[], string>> {
    return ok([]);
  },
  async mcpToggle(_session: string, _serverName: string, _enabled: boolean): Promise<Result<null, string>> {
    return ok(null);
  },
  async mcpReconnect(_session: string, _serverName: string): Promise<Result<null, string>> {
    return ok(null);
  },
  async mcpClearAuth(_session: string, _serverName: string): Promise<Result<null, string>> {
    return ok(null);
  },
  async mcpAuthenticate(_session: string, _serverName: string): Promise<Result<McpAuthResult, string>> {
    return ok({ auth_url: null, requires_user_action: false, error: null });
  },
};

/** A two-level synthetic directory listing for the browser/dev editor. */
function mockDir(path: string): FsEntry[] {
  const base = path.replace(/\/+$/, "");
  if (base.endsWith("/src")) {
    return [
      { name: "App.tsx", path: `${base}/App.tsx`, is_dir: false },
      { name: "main.tsx", path: `${base}/main.tsx`, is_dir: false },
    ];
  }
  return [
    { name: "src", path: `${base}/src`, is_dir: true },
    { name: "README.md", path: `${base}/README.md`, is_dir: false },
    { name: "package.json", path: `${base}/package.json`, is_dir: false },
  ];
}

/** Synthetic file content for the browser/dev editor. */
function mockFile(path: string): FileContent {
  const name = path.split("/").pop() ?? path;
  let content = `// ${name}\n// (mock file — browser/dev build, no real filesystem)\n`;
  if (name.endsWith(".md")) {
    content = `# ${name}\n\nMock markdown for the dev build.\n\n- one\n- two\n`;
  } else if (name.endsWith(".json")) {
    content = `{\n  "name": "mock",\n  "version": "0.0.0"\n}\n`;
  }
  return { path, content, too_large: false, binary: false, size: content.length };
}

// Synthetic git state for dev/Playwright. A small DAG with one merge so the
// graph layout (rails diverging/merging) is visible without a real repo.
const MOCK_GIT_FILES: GitFileEntry[] = [
  {
    path: "src/app.ts",
    orig_path: null,
    index_status: "M",
    worktree_status: ".",
    staged: true,
    unstaged: false,
    untracked: false,
  },
  {
    path: "src/util.ts",
    orig_path: null,
    index_status: ".",
    worktree_status: "M",
    staged: false,
    unstaged: true,
    untracked: false,
  },
  {
    path: "notes.txt",
    orig_path: null,
    index_status: ".",
    worktree_status: "?",
    staged: false,
    unstaged: true,
    untracked: true,
  },
];
const MOCK_GIT_STATUS: GitStatus = {
  branch: "main",
  head: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
  upstream: "origin/main",
  ahead: 2,
  behind: 1,
  unborn: false,
  files: MOCK_GIT_FILES,
};
function mockCommit(
  oid: string,
  parents: string[],
  subject: string,
  ts: number,
  refs: string[] = [],
): CommitInfo {
  return {
    oid: oid.padEnd(40, oid[0] ?? "0"),
    short_oid: oid.slice(0, 7),
    parents: parents.map((p) => p.padEnd(40, p[0] ?? "0")),
    author_name: "Alexandre",
    author_email: "a@tosse.dev",
    timestamp: ts,
    subject,
    refs,
  };
}
const MOCK_GIT_LOG: CommitInfo[] = [
  mockCommit("merge00", ["main001", "feat001"], "Merge feat into main", 1_710_000_600, [
    "HEAD",
    "main",
  ]),
  mockCommit("feat001", ["base001"], "Add the feature", 1_710_000_500, ["feature"]),
  mockCommit("main001", ["base001"], "Tweak the docs", 1_710_000_400, ["origin/main"]),
  mockCommit("base001", ["root001"], "Wire it up", 1_710_000_300, []),
  mockCommit("root001", [], "Initial commit", 1_710_000_200, ["tag: v0.1.0"]),
];
const MOCK_GIT_BRANCHES: BranchInfo[] = [
  {
    name: "main",
    oid: "merge00".padEnd(40, "m"),
    is_head: true,
    is_remote: false,
    upstream: "origin/main",
    ahead: 2,
    behind: 1,
  },
  {
    name: "feature",
    oid: "feat001".padEnd(40, "f"),
    is_head: false,
    is_remote: false,
    upstream: null,
    ahead: null,
    behind: null,
  },
  {
    name: "origin/main",
    oid: "main001".padEnd(40, "o"),
    is_head: false,
    is_remote: true,
    upstream: null,
    ahead: null,
    behind: null,
  },
];

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

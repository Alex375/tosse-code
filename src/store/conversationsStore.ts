// Real conversation management: repos (working folders) and the conversations
// the user started in them. Each conversation IS a live `claude` session (one
// spawned process). Conversations are grouped by repo in the sidebar.
//
// Identity: a conversation's `id` is a STABLE uuid generated at creation and
// persisted — it is the identity the whole app keys off and never changes. The
// live Rust session handle (`session-N`) is a SEPARATE, in-memory-only field
// (`handle`) that is remapped on every restart and never persisted. Other
// services can therefore reference a conversation by an id independent of both
// SQL and the transport.
//
// Persistence: repos + conversation metadata (incl. the claude session_id for
// --resume) + the active selection live in the Rust core's SQLite db, behind the
// IPC commands. This store is the in-memory cache + the single persistence
// adapter: each mutation mirrors itself to the core (best-effort, off the hot
// path). The conversation MESSAGES are NOT stored here: on resume we rebuild them
// from Claude's own on-disk transcript via `loadSessionHistory`. `claude --resume`
// does NOT re-stream past messages, so the live event path delivers nothing for an
// existing conversation — reading the transcript is what fills it back in.
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { commands } from "../ipc/client";
import type {
  ConversationRecord,
  RepoRecord,
  SessionStatePayload,
} from "../ipc/client";
import { useConversationStore } from "./conversationStore";
import type { StreamState } from "../ui/kit";

export const DEFAULT_CONV_NAME = "Nouvelle conversation";

/** A working folder / repository a conversation can be opened in. */
export interface Repo {
  id: string;
  /** Absolute path, or "." for the default local project. */
  path: string;
  addedAt: number;
}

export interface Conversation {
  /** Stable uuid — the identity everything keys off. Persisted, never changes. */
  id: string;
  name: string;
  /** FK to Repo.id — the authoritative grouping key. */
  repoId: string;
  /** Absolute path the session was spawned in (== repo.path at creation). */
  cwd: string;
  createdAt: number;
  /**
   * Unix ms timestamp of the last activity — the last message sent OR received.
   * Drives the sidebar's most-recent-first ordering; bumped by `noteActivity`.
   */
  lastActivityAt: number;
  /** Claude's own session_id from system/init — used for --resume on restart. */
  sessionId: string | null;
  /**
   * Live Rust session handle (`session-N`) for IPC and live-state lookups.
   * In-memory ONLY — never persisted; set on spawn/resume, changes each launch.
   */
  handle: string | null;
}

/** Display name for a repo path — its basename. */
export function repoName(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

function uid(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}

function deriveName(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return DEFAULT_CONV_NAME;
  return t.length > 42 ? t.slice(0, 42) + "…" : t;
}

// ---- Persistence adapter ----------------------------------------------------
// The ONE place that knows the SQL-facing DTO shape (snake_case `*Record`).
// Maps to/from the camelCase domain model and forwards to the core. If the
// storage layer changes, only this section moves.

const repoToRecord = (r: Repo): RepoRecord => ({
  id: r.id,
  path: r.path,
  added_at: r.addedAt,
});

const convToRecord = (c: Conversation): ConversationRecord => ({
  id: c.id,
  name: c.name,
  repo_id: c.repoId,
  cwd: c.cwd,
  created_at: c.createdAt,
  last_activity_at: c.lastActivityAt,
  session_id: c.sessionId,
});

const recordToRepo = (r: RepoRecord): Repo => ({
  id: r.id,
  path: r.path,
  addedAt: r.added_at,
});

const recordToConv = (c: ConversationRecord): Conversation => ({
  id: c.id,
  name: c.name,
  repoId: c.repo_id,
  cwd: c.cwd,
  createdAt: c.created_at,
  lastActivityAt: c.last_activity_at,
  sessionId: c.session_id,
  handle: null,
});

/** Fire a persistence command, logging (never throwing) on failure. Persistence
 *  is best-effort and off the hot path — a failed write must not break the UI. */
function syncToCore(
  label: string,
  run: () => Promise<{ status: "ok"; data: unknown } | { status: "error"; error: string }>,
): void {
  void run()
    .then((res) => {
      if (res.status !== "ok") console.error(`[persist] ${label} failed:`, res.error);
    })
    .catch((e) => console.error(`[persist] ${label} threw:`, e));
}

interface ConversationsState {
  repos: Repo[];
  conversations: Conversation[];
  activeId: string | null;
  /** Idempotent by canonical path: returns the existing repo or a new one. */
  addRepo: (path: string) => Repo;
  /** Remove a repo and all of its conversations. */
  removeRepo: (path: string) => void;
  addConversation: (c: Conversation) => void;
  selectConversation: (id: string) => void;
  removeConversation: (id: string) => void;
  /** Name an untitled conversation from its first user message (keyed by stable id). */
  noteFirstMessage: (id: string, text: string) => void;
  /** Store Claude's session_id on the conversation for --resume (keyed by stable id). */
  noteSessionId: (id: string, sessionId: string) => void;
  /** Bind a conversation (by stable id) to its live Rust session handle. In-memory only. */
  setHandle: (id: string, handle: string | null) => void;
  /**
   * Mark a conversation active "now" — bumps `lastActivityAt`, which re-sorts the
   * sidebar (most recent first). Activity is the three meaningful edits to a
   * conversation: it is created, the user sends a message, or Claude FINISHES a
   * turn (`turn_result` — the end of its agentic loop, NOT each intermediate
   * message it emits while working). `persist` mirrors the new timestamp to the
   * core; we pass it on all three since they're rare/terminal, so the recency
   * order survives a restart.
   */
  noteActivity: (id: string, opts?: { persist?: boolean }) => void;
}

export const useConversationsStore = create<ConversationsState>()((set, get) => ({
  repos: [],
  conversations: [],
  activeId: null,

  addRepo: (path) => {
    const existing = get().repos.find((r) => r.path === path);
    if (existing) return existing;
    const repo: Repo = { id: uid(), path, addedAt: Date.now() };
    set((s) => ({ repos: [...s.repos, repo] }));
    syncToCore("upsertRepo", () => commands.upsertRepo(repoToRecord(repo)));
    return repo;
  },

  removeRepo: (path) => {
    const repo = get().repos.find((r) => r.path === path);
    if (!repo) return;
    set((s) => {
      const conversations = s.conversations.filter((c) => c.repoId !== repo.id);
      return {
        repos: s.repos.filter((r) => r.id !== repo.id),
        conversations,
        activeId: conversations.some((c) => c.id === s.activeId)
          ? s.activeId
          : (conversations[conversations.length - 1]?.id ?? null),
      };
    });
    // The db cascades the repo's conversations via the FK; just drop the repo
    // and re-sync the active selection.
    syncToCore("deleteRepo", () => commands.deleteRepo(repo.id));
    syncToCore("setActive", () => commands.setActiveConversation(get().activeId));
  },

  addConversation: (c) => {
    set((s) => ({ conversations: [...s.conversations, c], activeId: c.id }));
    syncToCore("upsertConversation", () => commands.upsertConversation(convToRecord(c)));
    syncToCore("setActive", () => commands.setActiveConversation(c.id));
  },

  selectConversation: (id) => {
    set({ activeId: id });
    syncToCore("setActive", () => commands.setActiveConversation(id));
  },

  removeConversation: (id) => {
    const conv = get().conversations.find((c) => c.id === id);
    set((s) => {
      const rest = s.conversations.filter((c) => c.id !== id);
      return {
        conversations: rest,
        activeId: s.activeId === id ? (rest[rest.length - 1]?.id ?? null) : s.activeId,
      };
    });
    // Kill the live `claude` process (if any) so deleting a conversation never
    // leaves an orphan. Distinct from interrupt: this terminates the session.
    if (conv?.handle) {
      syncToCore("stopSession", () => commands.stopSession(conv.handle!));
    }
    // Drop its (now unreachable) message timeline from the message store.
    useConversationStore.getState().dropSession(id);
    syncToCore("deleteConversation", () => commands.deleteConversation(id));
    syncToCore("setActive", () => commands.setActiveConversation(get().activeId));
  },

  noteFirstMessage: (id, text) => {
    const conv = get().conversations.find((c) => c.id === id);
    if (!conv || conv.name !== DEFAULT_CONV_NAME) return;
    const updated = { ...conv, name: deriveName(text) };
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === conv.id ? updated : c)),
    }));
    syncToCore("upsertConversation(rename)", () =>
      commands.upsertConversation(convToRecord(updated)),
    );
  },

  noteSessionId: (id, sessionId) => {
    const conv = get().conversations.find((c) => c.id === id);
    if (!conv || conv.sessionId === sessionId) return;
    const updated = { ...conv, sessionId };
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === conv.id ? updated : c)),
    }));
    syncToCore("upsertConversation(sessionId)", () =>
      commands.upsertConversation(convToRecord(updated)),
    );
  },

  setHandle: (id, handle) =>
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === id ? { ...c, handle } : c)),
    })),

  noteActivity: (id, opts) => {
    const conv = get().conversations.find((c) => c.id === id);
    if (!conv) return;
    const updated = { ...conv, lastActivityAt: Date.now() };
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === id ? updated : c)),
    }));
    if (opts?.persist) {
      syncToCore("upsertConversation(activity)", () =>
        commands.upsertConversation(convToRecord(updated)),
      );
    }
  },
}));

/**
 * Create a new conversation in `repoPath` (registering the repo if new) with a
 * fresh stable id. Returns its stable id.
 *
 * Lazy policy: NO `claude` process is spawned here — only the metadata record is
 * created. The live session is spawned on the first message (see
 * [`ensureConversationSession`]).
 */
export function createConversationInRepo(repoPath: string): string {
  const repo = useConversationsStore.getState().addRepo(repoPath);
  const id = uid();
  const now = Date.now();
  useConversationsStore.getState().addConversation({
    id,
    name: DEFAULT_CONV_NAME,
    repoId: repo.id,
    cwd: repoPath,
    createdAt: now,
    // A brand-new conversation is the most recent activity → top of the list.
    lastActivityAt: now,
    sessionId: null,
    handle: null, // no live process until the first message
  });
  return id;
}

/**
 * Boot: hydrate the store from the core's persisted state. Called once at App
 * mount. The store starts empty — persistence lives in the Rust core, not in the
 * webview — so nothing is in memory until this runs.
 *
 * Lazy policy: boot spawns NOTHING. Conversations are listed from their
 * metadata; a conversation's transcript is loaded on demand when it is shown
 * (see [`loadConversationHistory`]) and its `claude` process is spawned only when
 * the user sends a message. An empty store stays empty — no default conversation.
 */
export async function bootConversations(): Promise<void> {
  const res = await commands.loadPersistedState();
  if (res.status === "ok") {
    useConversationsStore.setState({
      repos: res.data.repos.map(recordToRepo),
      conversations: res.data.conversations.map(recordToConv),
      activeId: res.data.active_id,
    });
  } else {
    console.error("loadPersistedState failed:", res.error);
  }
}

/** A conversation's live Rust session handle, or null if it isn't spawned. */
export function liveHandle(convId: string): string | null {
  return (
    useConversationsStore.getState().conversations.find((c) => c.id === convId)?.handle ?? null
  );
}

/**
 * Ensure a conversation has a LIVE `claude` session, spawning it lazily if not.
 * Returns the live handle. This is the single spawn point of the lazy policy —
 * called on the first message (and on any send after the session was stopped or
 * ended). A conversation with a `sessionId` is resumed (`--resume`) so the same
 * Claude session continues; a brand-new one starts fresh.
 *
 * The handle is bound synchronously before this resolves, so live events (which
 * the core keys by handle) route back to this conversation's stable id.
 */
export async function ensureConversationSession(convId: string): Promise<string> {
  const conv = useConversationsStore.getState().conversations.find((c) => c.id === convId);
  if (!conv) throw new Error(`conversation ${convId} introuvable`);
  if (conv.handle) return conv.handle;
  const res = await commands.spawnSession(conv.cwd, conv.sessionId ?? null);
  if (res.status !== "ok") throw new Error(res.error);
  useConversationsStore.getState().setHandle(convId, res.data);
  return res.data;
}

// Conversations whose on-disk transcript has already been replayed this run.
const historyLoaded = new Set<string>();

/**
 * Load a conversation's history from Claude's on-disk transcript into the message
 * store, keyed by its STABLE id — no process spawned (pure file IO). Idempotent
 * and run at most once per conversation per app run; `applyItem` also dedupes by
 * id, so a later live re-spawn never double-renders. A conversation with no
 * `sessionId` (never sent a message) has nothing to load.
 */
export async function loadConversationHistory(convId: string): Promise<void> {
  if (historyLoaded.has(convId)) return;
  historyLoaded.add(convId); // mark before awaiting to avoid a double-load race
  const conv = useConversationsStore.getState().conversations.find((c) => c.id === convId);
  if (!conv || !conv.sessionId) return;
  const res = await commands.loadSessionHistory(conv.sessionId);
  if (res.status !== "ok" || res.data.length === 0) return;
  const { ensureSession, applyItem } = useConversationStore.getState();
  ensureSession(convId);
  for (const item of res.data) applyItem(convId, item);
}

/**
 * Drop ALL data — persisted (the core's db) and in-memory — leaving an empty
 * slate (no default conversation). Wired to the Settings "drop all" button; also
 * handy during development since the SQL model is still in flux. Best-effort
 * stops every live `claude` session first so we don't orphan child processes.
 * Claude's on-disk transcripts are untouched.
 */
export async function wipeAllData(): Promise<void> {
  const { conversations } = useConversationsStore.getState();
  await Promise.all(
    conversations
      .filter((c): c is Conversation & { handle: string } => c.handle !== null)
      .map((c) => commands.stopSession(c.handle)),
  );
  await commands.wipeAllData();
  historyLoaded.clear();
  useConversationsStore.setState({ repos: [], conversations: [], activeId: null });
  useConversationStore.setState({ sessions: {} });
}

export const useConversations = () =>
  useConversationsStore(useShallow((s) => s.conversations));
export const useRepos = () => useConversationsStore(useShallow((s) => s.repos));
export const useActiveConversationId = () => useConversationsStore((s) => s.activeId);

/** The repo (working folder) a conversation belongs to. */
export function useConversationRepo(convId: string | null): Repo | null {
  return useConversationsStore((s) => {
    const conv = s.conversations.find((c) => c.id === convId);
    return conv ? (s.repos.find((r) => r.id === conv.repoId) ?? null) : null;
  });
}

/** Map a live session's state onto the design's 5-status model (for the status dot). */
export function sessionStreamState(s?: SessionStatePayload): StreamState {
  if (!s) return "done";
  if (s.ended) return "arch";
  if (s.awaiting_permission) return "ask";
  if (s.busy) return "work";
  return "done";
}

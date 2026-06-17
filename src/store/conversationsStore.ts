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
  sessionId: c.session_id,
  handle: null,
});

/** Fire a persistence command, logging (never throwing) on failure. Persistence
 *  is best-effort and off the hot path — a failed write must not break the UI. */
function persist(
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
  /** Name an untitled conversation from its first user message (keyed by live handle). */
  noteFirstMessage: (handle: string, text: string) => void;
  /** Store Claude's session_id on the conversation for --resume (keyed by live handle). */
  noteSessionId: (handle: string, sessionId: string) => void;
  /** Bind a conversation (by stable id) to its live Rust session handle. In-memory only. */
  setHandle: (id: string, handle: string | null) => void;
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
    persist("upsertRepo", () => commands.upsertRepo(repoToRecord(repo)));
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
    persist("deleteRepo", () => commands.deleteRepo(repo.id));
    persist("setActive", () => commands.setActiveConversation(get().activeId));
  },

  addConversation: (c) => {
    set((s) => ({ conversations: [...s.conversations, c], activeId: c.id }));
    persist("upsertConversation", () => commands.upsertConversation(convToRecord(c)));
    persist("setActive", () => commands.setActiveConversation(c.id));
  },

  selectConversation: (id) => {
    set({ activeId: id });
    persist("setActive", () => commands.setActiveConversation(id));
  },

  removeConversation: (id) => {
    set((s) => {
      const rest = s.conversations.filter((c) => c.id !== id);
      return {
        conversations: rest,
        activeId: s.activeId === id ? (rest[rest.length - 1]?.id ?? null) : s.activeId,
      };
    });
    persist("deleteConversation", () => commands.deleteConversation(id));
    persist("setActive", () => commands.setActiveConversation(get().activeId));
  },

  noteFirstMessage: (handle, text) => {
    const conv = get().conversations.find((c) => c.handle === handle);
    if (!conv || conv.name !== DEFAULT_CONV_NAME) return;
    const updated = { ...conv, name: deriveName(text) };
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === conv.id ? updated : c)),
    }));
    persist("upsertConversation(rename)", () =>
      commands.upsertConversation(convToRecord(updated)),
    );
  },

  noteSessionId: (handle, sessionId) => {
    const conv = get().conversations.find((c) => c.handle === handle);
    if (!conv || conv.sessionId === sessionId) return;
    const updated = { ...conv, sessionId };
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === conv.id ? updated : c)),
    }));
    persist("upsertConversation(sessionId)", () =>
      commands.upsertConversation(convToRecord(updated)),
    );
  },

  setHandle: (id, handle) =>
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === id ? { ...c, handle } : c)),
    })),
}));

/**
 * Spawn a new Claude session in `repoPath` (registering the repo if new) and add
 * it as a conversation with a fresh stable id. Returns its stable id (or null).
 */
export async function createConversationInRepo(repoPath: string): Promise<string | null> {
  const repo = useConversationsStore.getState().addRepo(repoPath);
  const id = uid();
  const res = await commands.spawnSession(repoPath, null);
  if (res.status === "ok") {
    useConversationsStore.getState().addConversation({
      id,
      name: DEFAULT_CONV_NAME,
      repoId: repo.id,
      cwd: repoPath,
      createdAt: Date.now(),
      sessionId: null,
      handle: res.data, // live session handle
    });
    return id;
  }
  console.error("spawnSession failed:", res.error);
  return null;
}

/**
 * Boot: hydrate the store from the core's persisted state, then resume the
 * persisted conversations. Called once at App mount. The store starts empty —
 * persistence now lives in the Rust core, not in the webview, so nothing is in
 * memory until this runs. An empty store stays empty: there is NO default
 * conversation; the user opens a folder to start one.
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

  if (useConversationsStore.getState().conversations.length > 0) {
    await resumeAllConversations();
  }
}

/**
 * On app restart: re-spawn all persisted conversations. Each conversation with a
 * sessionId gets --resume (so the live `claude` continues that session), and its
 * past messages are rebuilt from Claude's transcript via `loadSessionHistory` and
 * replayed into the conversation store under the new live handle. Conversations
 * without a sessionId get a fresh session (nothing to restore).
 *
 * The conversation's stable id never changes — we only (re)bind its `handle`.
 */
export async function resumeAllConversations(): Promise<void> {
  const { conversations, setHandle, removeConversation, selectConversation } =
    useConversationsStore.getState();

  const results = await Promise.all(
    conversations.map(async (conv) => {
      const res = await commands.spawnSession(conv.cwd, conv.sessionId ?? null);
      if (res.status === "ok") {
        const handle = res.data; // new live handle
        // Rebuild from Claude's transcript and replay under the new handle BEFORE
        // binding it, so the view mounts with history already present.
        if (conv.sessionId) {
          await restoreHistory(conv.sessionId, handle);
        }
        setHandle(conv.id, handle);
        return conv.id;
      } else {
        console.error(`Failed to resume conversation ${conv.id}:`, res.error);
        removeConversation(conv.id);
        return null;
      }
    }),
  );

  // Safety net: if activeId is still null (e.g. it pointed at a conversation that
  // failed to resume), activate the first successfully spawned one.
  if (!useConversationsStore.getState().activeId) {
    const firstId = results.find(Boolean);
    if (firstId) selectConversation(firstId);
  }
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
  useConversationsStore.setState({ repos: [], conversations: [], activeId: null });
  useConversationStore.setState({ sessions: {} });
}

/**
 * Load `sessionId`'s history from Claude's transcript and replay it into the
 * conversation store under `handle` (the new live session). Best-effort: a
 * missing transcript or an IPC error just leaves the conversation empty.
 */
async function restoreHistory(sessionId: string, handle: string): Promise<void> {
  const res = await commands.loadSessionHistory(sessionId);
  if (res.status !== "ok" || res.data.length === 0) return;
  const { ensureSession, applyItem } = useConversationStore.getState();
  ensureSession(handle);
  for (const item of res.data) applyItem(handle, item);
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

// Real conversation management: repos (working folders) and the conversations
// the user started in them. Each conversation IS a live `claude` session (one
// spawned process). Conversations are grouped by repo in the sidebar.
//
// Persistence: repos + conversation metadata (including the claude session_id for
// --resume) survive restarts via localStorage. The conversation MESSAGES are not
// stored here: on resume we rebuild them from Claude's own on-disk transcript via
// the `loadSessionHistory` command (see resumeAllConversations). `claude --resume`
// does NOT re-stream past messages, so the live event path delivers nothing for an
// existing conversation — reading the transcript is what fills it back in.
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";
import { commands } from "../ipc/client";
import type { SessionStatePayload } from "../ipc/client";
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
  id: string;
  name: string;
  /** FK to Repo.id — the authoritative grouping key. */
  repoId: string;
  /** Absolute path the session was spawned in (== repo.path at creation). */
  cwd: string;
  createdAt: number;
  /** Claude's own session_id from system/init — used for --resume on restart. */
  sessionId: string | null;
}

/** Display name for a repo path (its basename, or "Projet local" for "."). */
export function repoName(path: string): string {
  if (!path || path === ".") return "Projet local";
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
  /** Name an untitled conversation from its first user message. */
  noteFirstMessage: (id: string, text: string) => void;
  /** Store Claude's session_id (from system/init) on the conversation for --resume. */
  noteSessionId: (convId: string, sessionId: string) => void;
  /** After a --resume re-spawn, update the conversation's handle id to the new one. */
  refreshConversationId: (oldId: string, newId: string) => void;
}

export const useConversationsStore = create<ConversationsState>()(
  persist(
    (set, get) => ({
      repos: [],
      conversations: [],
      activeId: null,
      addRepo: (path) => {
        const existing = get().repos.find((r) => r.path === path);
        if (existing) return existing;
        const repo: Repo = { id: uid(), path, addedAt: Date.now() };
        set((s) => ({ repos: [...s.repos, repo] }));
        return repo;
      },
      removeRepo: (path) =>
        set((s) => {
          const repo = s.repos.find((r) => r.path === path);
          if (!repo) return {};
          const conversations = s.conversations.filter((c) => c.repoId !== repo.id);
          return {
            repos: s.repos.filter((r) => r.id !== repo.id),
            conversations,
            activeId:
              conversations.some((c) => c.id === s.activeId)
                ? s.activeId
                : (conversations[conversations.length - 1]?.id ?? null),
          };
        }),
      addConversation: (c) =>
        set((s) => ({ conversations: [...s.conversations, c], activeId: c.id })),
      selectConversation: (id) => set({ activeId: id }),
      removeConversation: (id) =>
        set((s) => {
          const rest = s.conversations.filter((c) => c.id !== id);
          return {
            conversations: rest,
            activeId:
              s.activeId === id ? (rest[rest.length - 1]?.id ?? null) : s.activeId,
          };
        }),
      noteFirstMessage: (id, text) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === id && c.name === DEFAULT_CONV_NAME ? { ...c, name: deriveName(text) } : c,
          ),
        })),
      noteSessionId: (convId, sessionId) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === convId ? { ...c, sessionId } : c,
          ),
        })),
      refreshConversationId: (oldId, newId) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === oldId ? { ...c, id: newId } : c,
          ),
          activeId: s.activeId === oldId ? newId : s.activeId,
        })),
    }),
    {
      name: "tosse-conversations",
      // Persist repos, conversation metadata, and the active selection. Messages are
      // NOT stored here — Claude replays them via --resume on next launch.
      partialize: (s) => ({ repos: s.repos, conversations: s.conversations, activeId: s.activeId }),
    },
  ),
);

/**
 * Spawn a new Claude session in `repoPath` (registering the repo if new) and add
 * it as a conversation. Returns its id (or null on failure).
 */
export async function createConversationInRepo(repoPath: string): Promise<string | null> {
  const repo = useConversationsStore.getState().addRepo(repoPath);
  const res = await commands.spawnSession(repoPath, null);
  if (res.status === "ok") {
    useConversationsStore.getState().addConversation({
      id: res.data,
      name: DEFAULT_CONV_NAME,
      repoId: repo.id,
      cwd: repoPath,
      createdAt: Date.now(),
      sessionId: null,
    });
    return res.data;
  }
  console.error("spawnSession failed:", res.error);
  return null;
}

/**
 * On app restart: re-spawn all persisted conversations. Each conversation with a
 * sessionId gets --resume (so the live `claude` continues that session), and its
 * past messages are rebuilt from Claude's transcript via `loadSessionHistory` and
 * replayed into the conversation store under the new live handle id. Conversations
 * without a sessionId get a fresh session (nothing to restore).
 *
 * Updates each conversation's id in the store to the new live handle id.
 */
export async function resumeAllConversations(): Promise<void> {
  const { conversations, refreshConversationId, removeConversation, selectConversation } =
    useConversationsStore.getState();

  const results = await Promise.all(
    conversations.map(async (conv) => {
      const res = await commands.spawnSession(conv.cwd, conv.sessionId ?? null);
      if (res.status === "ok") {
        const newId = res.data; // new live handle id
        // Rebuild the conversation from Claude's transcript and replay it under
        // the new handle id BEFORE re-pointing the conversation at it, so the
        // view mounts with history already present.
        if (conv.sessionId) {
          await restoreHistory(conv.sessionId, newId);
        }
        refreshConversationId(conv.id, newId);
        return newId;
      } else {
        console.error(`Failed to resume conversation ${conv.id}:`, res.error);
        removeConversation(conv.id);
        return null;
      }
    }),
  );

  // Safety net: if activeId is still null after all refreshes (e.g. persisted
  // activeId pointed to a conversation that failed to resume), activate the first
  // successfully spawned session.
  if (!useConversationsStore.getState().activeId) {
    const firstId = results.find(Boolean);
    if (firstId) selectConversation(firstId);
  }
}

/**
 * Load `sessionId`'s history from Claude's transcript and replay it into the
 * conversation store under `handleId` (the new live session). Best-effort: a
 * missing transcript or an IPC error just leaves the conversation empty.
 */
async function restoreHistory(sessionId: string, handleId: string): Promise<void> {
  const res = await commands.loadSessionHistory(sessionId);
  if (res.status !== "ok" || res.data.length === 0) return;
  const { ensureSession, applyItem } = useConversationStore.getState();
  ensureSession(handleId);
  for (const item of res.data) applyItem(handleId, item);
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

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
import type { ConversationItem, ConversationRecord, PermissionMode, RepoRecord } from "../ipc/client";
import type { ReminderKind } from "../agent/status";
import { useConversationStore } from "./conversationStore";
import { useBackgroundTasksStore } from "./backgroundTasksStore";
import { useWorkflowLiveStore } from "./workflowLive";
import { useAppErrors } from "./appErrors";
import { getCachedWindow, clearCachedWindow, clearAllCachedWindows } from "./contextWindowCache";
import { clearTodoBarOpen, clearAllTodoBarOpen } from "./todoBarUi";
import { clearComposerDraft, clearAllComposerDrafts } from "./composerDrafts";
import { disposeTerminal, disposeAllTerminals } from "../features/terminal/cleanup";
import { useGitViewStore } from "../features/git/gitViewStore";
import { clearMentionCache } from "../features/conversation/mentionCache";
import { worktreeCwdFromTranscript } from "../features/git/worktree";
import { useMemo } from "react";

export const DEFAULT_CONV_NAME = "Nouvelle conversation";

// Product defaults for a conversation's controls — also the spawn defaults the
// Rust core falls back to. A conversation seeds these at creation; the composer
// uses the same values as its display fallback, so UI and stream never disagree.
export const DEFAULT_MODEL = "opus";
export const DEFAULT_EFFORT = "xhigh";
// "auto" is the binary's own native default and what the live session reports;
// keeping the seed/fallback on "auto" makes the chip show "Auto mode" by default.
export const DEFAULT_PERMISSION_MODE = "auto";

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
  /**
   * The worktree the session moved INTO mid-conversation via the agent's
   * `EnterWorktree` tool (parsed from its result), or null when it is in its
   * spawn cwd. In-memory ONLY. Takes precedence over the spawn `cwd` for the
   * worktree indicator/badge so they follow the agent. Cleared on `ExitWorktree`.
   */
  liveCwd: string | null;
  // ---- Per-conversation controls (persisted) -------------------------------
  // Last-known model / effort / ultracode / permission, persisted so they survive
  // a restart and are re-applied at the next (lazy) spawn. While a session is LIVE,
  // its own state (get_settings / system/init) is the source of truth for DISPLAY;
  // these are what we spawn/restore from and what a pre-spawn pick writes to.
  /** Model ALIAS chosen in the UI (e.g. "opus"); null → product default at spawn. */
  model: string | null;
  /** Reasoning-effort level (low/medium/high/xhigh); null → product default. */
  effort: string | null;
  /** Whether the "ultracode" tier (xhigh + orchestration) is on. */
  ultracode: boolean;
  /** Permission mode (default/plan/acceptEdits/auto/…); null → product default. */
  permissionMode: string | null;
  /**
   * An unacknowledged, non-blocking status reminder that must survive a restart:
   * `"review"` / `"error"` / `"openQuestion"`, or null when nothing is pending.
   * Persisted because a settled state is otherwise live-only — when the process is
   * off (`handle === null`), `deriveAgentStatus` falls back to this to re-display
   * the reminder. Armed by the event router on a finished turn; cleared by "Vu"
   * (`acknowledgeConversation`) or the next message. NOT for blocking states
   * (permission / questionnaire) — those exist only while live.
   */
  pendingReminder: ReminderKind | null;
}

/** Coerce a persisted (untyped) reminder string back to the union, defaulting any
 *  unrecognised value to null — defensive against a stale/foreign DB row. */
function asReminderKind(s: string | null): ReminderKind | null {
  return s === "review" || s === "error" || s === "openQuestion" ? s : null;
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

/** Clean a model-generated title: trim, collapse whitespace, cap length. */
function cleanTitle(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > 60 ? t.slice(0, 60) + "…" : t;
}

// Conversations whose name is an auto placeholder (the truncated first message) still
// eligible to be REPLACED by the binary's model-generated title — the VS Code
// extension's behavior. In-memory ONLY (the auto/custom distinction is intentionally
// NOT persisted, to avoid a schema column): a manual rename removes the conversation
// from this set so a late-arriving smart title never clobbers a title the user chose
// (the "onlyIfNoCustomTitle" guard). KNOWN LIMITATION of being in-memory: if the app
// quits before the async title arrives, the persisted placeholder (the truncated
// first message) stays as the name and is never re-titled on the next run — the
// placeholder is the graceful fallback, so this is cosmetic.
const autoTitlePending = new Set<string>();

// Auto-title REGENERATION (beyond the VS Code one-shot): the title is regenerated on
// each of the first few user messages, feeding the model the ACCUMULATED user intent
// — so a session that opens with "/list-tasks" and then "do task X" isn't stuck on
// "List tasks". `titleContext` holds the user messages so far (the description sent to
// the binary); `titleGenCount` caps the regenerations (and doubles as the monotonic
// `seq` we tag each request with); `lastAppliedSeq` lets `applyAutoTitle` drop an
// out-of-order (stale) response so an older-context title can't overwrite a fresher
// one. All in-memory, cleared on rename/remove/wipe.
const MAX_TITLE_REGENS = 3;
const titleContext = new Map<string, string[]>();
const titleGenCount = new Map<string, number>();
const lastAppliedSeq = new Map<string, number>();

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
  model: c.model,
  effort: c.effort,
  ultracode: c.ultracode,
  permission_mode: c.permissionMode,
  pending_reminder: c.pendingReminder,
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
  liveCwd: null,
  model: c.model,
  effort: c.effort,
  ultracode: c.ultracode,
  permissionMode: c.permission_mode,
  pendingReminder: asReminderKind(c.pending_reminder),
});

// The one user-facing message for any persistence failure (deduped in the banner),
// so a broken DB shows ONE clear warning, not a flood of per-write errors.
const PERSIST_FAILURE_MSG =
  "Impossible d'enregistrer les modifications de la conversation — elles risquent de ne pas survivre au redémarrage.";

/** Fire a persistence command, logging AND surfacing (never throwing) on failure.
 *  Persistence is best-effort and off the hot path — a failed write must not break
 *  the UI — but it must NOT be silent: a lost rename/model/etc would vanish on the
 *  next restart with no warning, so it raises an app-level banner (deduped). */
function syncToCore(
  label: string,
  run: () => Promise<{ status: "ok"; data: unknown } | { status: "error"; error: string }>,
): void {
  void run()
    .then((res) => {
      if (res.status !== "ok") {
        console.error(`[persist] ${label} failed:`, res.error);
        useAppErrors.getState().pushError(PERSIST_FAILURE_MSG, `${label}: ${res.error}`);
      }
    })
    .catch((e) => {
      console.error(`[persist] ${label} threw:`, e);
      useAppErrors
        .getState()
        .pushError(PERSIST_FAILURE_MSG, `${label}: ${e instanceof Error ? e.message : String(e)}`);
    });
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
  /** Rename a conversation to a user-chosen title. Blank or unchanged names are ignored. */
  renameConversation: (id: string, name: string) => void;
  /**
   * On the first user message of an untitled conversation: set an optimistic
   * placeholder name (the truncated message) and mark it eligible for the binary's
   * model-generated title. No-op once the conversation has any non-default name.
   */
  noteFirstMessage: (id: string, text: string) => void;
  /**
   * Accumulate `text` (a user message) and ask the live session to (re)generate a
   * smart title from the user's intent SO FAR. Called on each send; regenerates up to
   * a small cap then freezes, so the title tracks the real topic as the conversation
   * evolves (e.g. "/list-tasks" → "do task X") without churning forever. No-op unless
   * still auto-title-eligible, under the cap, and live. Title arrives via
   * `SessionTitleEvent` → [`applyAutoTitle`].
   */
  triggerAutoTitle: (id: string, text: string) => void;
  /**
   * Apply a model-generated title (from `SessionTitleEvent`) as the conversation
   * name — but ONLY if it is still auto-title-eligible (the user has not renamed it
   * since) AND `seq` is newer than the last applied (drops out-of-order/stale
   * responses). Does NOT consume eligibility: later regenerations replace it until the
   * title settles. Persisted.
   */
  applyAutoTitle: (id: string, title: string, seq: number) => void;
  /** Store Claude's session_id on the conversation for --resume (keyed by stable id). */
  noteSessionId: (id: string, sessionId: string) => void;
  /** Bind a conversation (by stable id) to its live Rust session handle. In-memory only. */
  setHandle: (id: string, handle: string | null) => void;
  /** Set/clear the worktree the session moved into (EnterWorktree/ExitWorktree). In-memory only. */
  setLiveCwd: (id: string, cwd: string | null) => void;
  /** Repoint a conversation's working directory (e.g. into a freshly created worktree) and persist it. */
  repointCwd: (id: string, cwd: string) => void;
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
  // ---- Controls: persist + push to the live stream --------------------------
  // Each writes the conversation record (so a pre-spawn pick survives and is
  // re-applied at spawn) AND, if a session is live, pushes the change to it. A
  // live push failure is logged, never thrown — and the core's get_settings
  // read-back then re-aligns the indicator with reality, so the UI can't lie.
  /** Set this conversation's model (the clamp of effort is the composer's job). */
  setConvModel: (id: string, model: string) => void;
  /** Set a plain effort level — clears the ultracode tier. */
  setConvEffort: (id: string, effort: string) => void;
  /** Enable the ultracode tier (effort xhigh + the separate flag). */
  setConvUltracode: (id: string) => void;
  /** Set the permission mode. */
  setConvPermission: (id: string, mode: PermissionMode) => void;
  /**
   * Set (or clear with null) the conversation's persisted status reminder and
   * mirror it to the core. Idempotent: a no-op when the value is unchanged, so the
   * event router can call it freely on every settling edge without redundant writes.
   * Armed from the live status on a finished turn; cleared on "Vu" / next message.
   */
  setReminder: (id: string, reminder: ReminderKind | null) => void;
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
    // Kill the integrated terminal of every conversation under this repo (the rows
    // are about to be cascade-deleted) so no PTY shell is orphaned.
    for (const c of get().conversations) {
      if (c.repoId === repo.id) {
        disposeTerminal(c.id);
        clearTodoBarOpen(c.id);
        clearComposerDraft(c.id);
        useGitViewStore.getState().clear(c.id);
      }
    }
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
    // Drop its (now unreachable) message timeline from the message store, and its
    // persisted context-window so the localStorage cache doesn't keep orphans.
    useConversationStore.getState().dropSession(id);
    useBackgroundTasksStore.getState().dropSession(id);
    useWorkflowLiveStore.getState().drop(id);
    clearCachedWindow(id);
    clearTodoBarOpen(id);
    clearComposerDraft(id);
    autoTitlePending.delete(id);
    titleContext.delete(id);
    titleGenCount.delete(id);
    lastAppliedSeq.delete(id);
    // Kill its integrated terminal (PTY shell + xterm instance) too — same no-orphan
    // policy as the claude session above. No-op if it never opened a terminal.
    disposeTerminal(id);
    useGitViewStore.getState().clear(id);
    syncToCore("deleteConversation", () => commands.deleteConversation(id));
    syncToCore("setActive", () => commands.setActiveConversation(get().activeId));
  },

  renameConversation: (id, name) => {
    const trimmed = name.trim().replace(/\s+/g, " ");
    const conv = get().conversations.find((c) => c.id === id);
    // Ignore a blank or unchanged title — an empty name would leave an unlabeled row.
    if (!conv || !trimmed || trimmed === conv.name) return;
    // A manual rename is a custom title: it takes the conversation out of auto-title
    // eligibility (and stops any further regeneration), so a late-arriving model title
    // never clobbers the user's choice.
    autoTitlePending.delete(id);
    titleContext.delete(id);
    titleGenCount.delete(id);
    lastAppliedSeq.delete(id);
    const updated = { ...conv, name: trimmed };
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === conv.id ? updated : c)),
    }));
    syncToCore("upsertConversation(rename)", () =>
      commands.upsertConversation(convToRecord(updated)),
    );
  },

  noteFirstMessage: (id, text) => {
    const conv = get().conversations.find((c) => c.id === id);
    // Only a still-untitled conversation auto-titles: a custom rename (or a resumed
    // conversation carrying a prior name) is left untouched.
    if (!conv || conv.name !== DEFAULT_CONV_NAME) return;
    // Optimistic placeholder (the truncated message), like the VS Code extension —
    // instant feedback and the fallback if title generation fails. Mark it eligible
    // for replacement by the model-generated title (see triggerAutoTitle).
    autoTitlePending.add(id);
    const updated = { ...conv, name: deriveName(text) };
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === conv.id ? updated : c)),
    }));
    syncToCore("upsertConversation(rename)", () =>
      commands.upsertConversation(convToRecord(updated)),
    );
  },

  triggerAutoTitle: (id, text) => {
    // Eligible only if still an auto placeholder (not renamed/resumed).
    if (!autoTitlePending.has(id)) return;
    const count = titleGenCount.get(id) ?? 0;
    if (count >= MAX_TITLE_REGENS) return; // title has settled — stop regenerating
    // Accumulate the user's messages FIRST (before the live-handle gate) so the
    // intent stays complete even if the session is momentarily down — then regenerate
    // from the WHOLE intent so far, not just the first message ("/list-tasks" then
    // "do task X" lands on the task). The binary truncates to its own token budget.
    const ctx = [...(titleContext.get(id) ?? []), text];
    titleContext.set(id, ctx);
    const conv = get().conversations.find((c) => c.id === id);
    if (!conv?.handle) return; // no live session to ask (the placeholder stays)
    const description = ctx.join("\n").trim();
    if (!description) return;
    // Tag this request with a monotonic seq so applyAutoTitle can drop a stale,
    // out-of-order response (older-context title arriving after a fresher one).
    const seq = count + 1;
    titleGenCount.set(id, seq);
    // Fire-and-forget: the title returns via SessionTitleEvent → applyAutoTitle. A
    // failure is non-fatal (the placeholder/last title stays) — log it, never surface it.
    void commands
      .generateConversationTitle(conv.handle, description, seq)
      .then((res) => {
        if (res.status === "error")
          console.error("[autoTitle] generateConversationTitle failed:", res.error);
      })
      .catch((e) => console.error("[autoTitle] generateConversationTitle threw:", e));
  },

  applyAutoTitle: (id, title, seq) => {
    // Apply only while still eligible (the user hasn't renamed since). NOT consumed:
    // later regenerations (up to the cap) replace it in turn until the title settles.
    if (!autoTitlePending.has(id)) return;
    // Drop a stale, out-of-order response: only ever move the title FORWARD in seq, so
    // an earlier (poorer-context) generation that resolves late can't clobber a fresher
    // one. Record the seq even when the name doesn't change, so a later older seq loses.
    if (seq <= (lastAppliedSeq.get(id) ?? 0)) return;
    lastAppliedSeq.set(id, seq);
    const conv = get().conversations.find((c) => c.id === id);
    const cleaned = cleanTitle(title);
    if (!conv || !cleaned || cleaned === conv.name) return;
    const updated = { ...conv, name: cleaned };
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === conv.id ? updated : c)),
    }));
    syncToCore("upsertConversation(autoTitle)", () =>
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

  setLiveCwd: (id, cwd) =>
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === id && c.liveCwd !== cwd ? { ...c, liveCwd: cwd } : c,
      ),
    })),

  repointCwd: (id, cwd) => {
    const conv = get().conversations.find((c) => c.id === id);
    if (!conv || conv.cwd === cwd) return;
    const updated = { ...conv, cwd };
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === id ? updated : c)),
    }));
    syncToCore("upsertConversation(cwd)", () => commands.upsertConversation(convToRecord(updated)));
  },

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

  setConvModel: (id, model) => {
    const conv = get().conversations.find((c) => c.id === id);
    if (!conv || conv.model === model) return;
    const updated = { ...conv, model };
    set((s) => ({ conversations: s.conversations.map((c) => (c.id === id ? updated : c)) }));
    syncToCore("upsertConversation(model)", () => commands.upsertConversation(convToRecord(updated)));
    if (conv.handle) syncToCore("setModel(live)", () => commands.setModel(conv.handle!, model));
  },

  setConvEffort: (id, effort) => {
    const conv = get().conversations.find((c) => c.id === id);
    if (!conv) return;
    const updated = { ...conv, effort, ultracode: false };
    set((s) => ({ conversations: s.conversations.map((c) => (c.id === id ? updated : c)) }));
    syncToCore("upsertConversation(effort)", () => commands.upsertConversation(convToRecord(updated)));
    if (conv.handle) syncToCore("setEffortLevel(live)", () => commands.setEffortLevel(conv.handle!, effort));
  },

  setConvUltracode: (id) => {
    const conv = get().conversations.find((c) => c.id === id);
    if (!conv) return;
    const updated = { ...conv, effort: "xhigh", ultracode: true };
    set((s) => ({ conversations: s.conversations.map((c) => (c.id === id ? updated : c)) }));
    syncToCore("upsertConversation(ultracode)", () => commands.upsertConversation(convToRecord(updated)));
    if (conv.handle) syncToCore("setUltracode(live)", () => commands.setUltracode(conv.handle!));
  },

  setConvPermission: (id, mode) => {
    const conv = get().conversations.find((c) => c.id === id);
    if (!conv || conv.permissionMode === mode) return;
    const updated = { ...conv, permissionMode: mode };
    set((s) => ({ conversations: s.conversations.map((c) => (c.id === id ? updated : c)) }));
    syncToCore("upsertConversation(permission)", () => commands.upsertConversation(convToRecord(updated)));
    if (conv.handle)
      syncToCore("setPermissionMode(live)", () => commands.setPermissionMode(conv.handle!, mode));
  },

  setReminder: (id, reminder) => {
    const conv = get().conversations.find((c) => c.id === id);
    if (!conv || conv.pendingReminder === reminder) return; // idempotent: no churn
    const updated = { ...conv, pendingReminder: reminder };
    set((s) => ({ conversations: s.conversations.map((c) => (c.id === id ? updated : c)) }));
    syncToCore("upsertConversation(reminder)", () => commands.upsertConversation(convToRecord(updated)));
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
    liveCwd: null,
    model: DEFAULT_MODEL,
    effort: DEFAULT_EFFORT,
    ultracode: false,
    permissionMode: DEFAULT_PERMISSION_MODE,
    pendingReminder: null,
  });
  return id;
}

/**
 * Create a new conversation in an EXISTING repo but rooted at `cwd` — typically a
 * git worktree of that repo. Reuses the repo's id (so the conversation still
 * groups under it in the sidebar) while spawning `claude` in the worktree
 * directory. Returns the new conversation's stable id.
 *
 * This is how the app starts an agent "directly in a worktree": same repo group,
 * a different working directory. The worktree indicator/badge resolve that cwd
 * and light up accordingly. Lazy as ever — no process is spawned here.
 */
export function createConversationInWorktree(repoId: string, cwd: string): string {
  const id = uid();
  const now = Date.now();
  useConversationsStore.getState().addConversation({
    id,
    name: DEFAULT_CONV_NAME,
    repoId,
    cwd,
    createdAt: now,
    lastActivityAt: now,
    sessionId: null,
    handle: null, // no live process until the first message
    liveCwd: null,
    model: DEFAULT_MODEL,
    effort: DEFAULT_EFFORT,
    ultracode: false,
    permissionMode: DEFAULT_PERMISSION_MODE,
    pendingReminder: null,
  });
  return id;
}

/** Branch/dir name for an app-created worktree when starting a conversation in one. */
function autoWorktreeBranch(): string {
  return `wt-${Date.now().toString(36)}`;
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
    // A failed hydration leaves the store empty — INDISTINGUISHABLE from a fresh
    // install, so all the user's conversations would appear silently gone. Surface
    // it loudly: a corrupt/locked DB is a real problem, not "no conversations yet".
    console.error("loadPersistedState failed:", res.error);
    useAppErrors
      .getState()
      .pushError(
        "Impossible de charger vos conversations — la base de données est peut-être corrompue ou verrouillée. Vos données ne sont pas perdues ; redémarre l'application.",
        res.error,
      );
  }
}

/** A conversation's live Rust session handle, or null if it isn't spawned. */
export function liveHandle(convId: string): string | null {
  return (
    useConversationsStore.getState().conversations.find((c) => c.id === convId)?.handle ?? null
  );
}

/**
 * Acknowledge ("Vu") a conversation's reminder: mark the last turn seen in the
 * LIVE message store (so it drops to idle now) AND clear the PERSISTED reminder
 * (so the acknowledgement survives a restart). This is the single "Vu" entry point
 * the UI calls — distinct from the raw `markSeen`, which the history loaders use to
 * silence a replayed PAST completion WITHOUT touching the persisted reminder: an
 * unopened reminder must survive a restart, so merely OPENING a conversation can't
 * clear it — only this explicit acknowledgement (or the next message) does.
 */
export function acknowledgeConversation(convId: string): void {
  useConversationStore.getState().markSeen(convId);
  useConversationsStore.getState().setReminder(convId, null);
}

// In-flight spawns keyed by conversation id. Spawning is async (a round-trip to
// the core), so two concurrent callers — e.g. the "allumer" button and a message
// send firing at once — could both see a null handle and spawn TWO processes,
// leaking one as an orphan. Sharing the in-flight promise makes the spawn
// idempotent per conversation: concurrent callers await the same one.
const spawning = new Map<string, Promise<string>>();

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
export async function ensureConversationSession(
  convId: string,
  opts?: { worktree?: boolean },
): Promise<string> {
  let conv = useConversationsStore.getState().conversations.find((c) => c.id === convId);
  if (!conv) throw new Error(`conversation ${convId} introuvable`);
  if (conv.handle) return conv.handle;
  const inflight = spawning.get(convId);
  if (inflight) return inflight;
  const promise = (async () => {
    const before = useConversationsStore.getState().conversations.find((c) => c.id === convId);
    if (!before) throw new Error(`conversation ${convId} introuvable`);
    let cwd = before.cwd;
    // First spawn requested in a fresh worktree: create one (app-managed, under
    // .claude/worktrees) and repoint the conversation's cwd into it BEFORE
    // spawning — so the session, its transcript, and `--resume` all live in the
    // worktree (cwd stays the single source of truth). Only on the very first
    // spawn (no sessionId yet); a later resume reuses the existing cwd and never
    // creates a second worktree. A failure throws so the send surfaces it.
    if (opts?.worktree && !before.sessionId) {
      const repo = useConversationsStore.getState().repos.find((r) => r.id === before.repoId);
      if (!repo) throw new Error("dépôt introuvable pour cette conversation");
      const wt = await commands.createWorktree(repo.path, autoWorktreeBranch(), null, true);
      if (wt.status !== "ok") throw new Error(`création du worktree impossible : ${wt.error}`);
      useConversationsStore.getState().repointCwd(convId, wt.data.path);
      cwd = wt.data.path;
    }
    // Apply this conversation's persisted controls at spawn, so the live stream
    // starts in EXACTLY the model/effort/permission/ultracode the UI shows — never
    // the old hardcoded defaults. A pre-first-message pick is honored here too.
    let res = await commands.spawnSession(
      cwd,
      before.sessionId ?? null,
      before.model,
      before.effort,
      before.permissionMode,
      before.ultracode,
    );
    if (res.status !== "ok") {
      // The spawn may have failed because the conversation's cwd is GONE — its
      // worktree was removed. (A missing cwd and a missing `claude` binary both
      // surface as the same OS error.) If so, fall back to the repo's main
      // checkout and start FRESH there: resuming the old session would fail,
      // since its transcript lives under the deleted worktree's project, not the
      // main one (verified: `claude --resume` errors when the session isn't in
      // the current project). The user is told; prior turns already shown stay,
      // and the message they just sent goes to the new session.
      const repo = useConversationsStore.getState().repos.find((r) => r.id === before.repoId);
      const fallback = repo?.path;
      if (
        fallback &&
        fallback !== cwd &&
        !(await commands.pathExists(cwd)) &&
        (await commands.pathExists(fallback))
      ) {
        useConversationStore
          .getState()
          .addErrorTurn(
            convId,
            `⚠️ Le worktree associé à cette conversation a été supprimé. Elle est relancée dans l'arbre de travail principal (${repoName(fallback)}) — nouvelle session.`,
          );
        useConversationsStore.getState().repointCwd(convId, fallback);
        res = await commands.spawnSession(
          fallback,
          null,
          before.model,
          before.effort,
          before.permissionMode,
          before.ultracode,
        );
      }
    }
    if (res.status !== "ok") throw new Error(res.error);
    useConversationsStore.getState().setHandle(convId, res.data);
    return res.data;
  })();
  spawning.set(convId, promise);
  try {
    return await promise;
  } finally {
    spawning.delete(convId);
  }
}

/**
 * Stop a conversation's live `claude` process (the "éteindre" action). No-op if
 * it isn't running. The core also clears the handle via the terminal `ended`
 * event, but we drop it here too so the UI flips to "off" without waiting for the
 * round-trip. Distinct from `interrupt` (which only ends the current turn): this
 * kills the process. The on-disk transcript is untouched, so a later send (or
 * "allumer") resumes the same Claude session via `--resume`.
 */
export async function stopConversationSession(convId: string): Promise<void> {
  const conv = useConversationsStore.getState().conversations.find((c) => c.id === convId);
  if (!conv?.handle) return; // already off
  const res = await commands.stopSession(conv.handle);
  useConversationsStore.getState().setHandle(convId, null);
  // The core's terminal `ended` event is keyed by the (now-cleared) handle and
  // gets dropped, so the message store would keep the last live state (e.g.
  // busy=true) and the composer would stay locked. Reset it to idle so the
  // conversation reads as off and a new message can re-spawn it.
  useConversationStore.getState().clearState(convId);
  if (res.status !== "ok") throw new Error(res.error);
}

/**
 * Turn a conversation's stream ON (the "allumer" action). Before spawning, it
 * re-syncs the timeline from Claude's on-disk transcript so any turns added
 * out-of-band — e.g. while the same session was resumed in a terminal
 * (`claude --resume`) — show up. `--resume` does not re-stream past messages, so
 * reading the transcript is the only way to pick them up.
 */
export async function startConversationSession(convId: string): Promise<string> {
  await reloadConversationHistory(convId);
  const handle = await ensureConversationSession(convId);
  // `reloadConversationHistory` marked the replayed turn seen, so the conversation is
  // now live + idle and its reminder bar is hidden. Reconcile the PERSISTED reminder
  // to match (clear it): otherwise a stale "review"/"error" would resurrect via the
  // off-branch the moment the stream is later stopped or the app is force-quit —
  // bringing the stream online IS engaging with it, like sending the next message.
  useConversationsStore.getState().setReminder(convId, null);
  return handle;
}

/**
 * Restart a conversation's stream (off→on): stop the live process if any, then
 * start it again. Clearing the handle in `stopConversationSession` first means
 * `ensureConversationSession` sees no live handle and genuinely re-spawns instead
 * of returning the dead one. Like "allumer", this re-syncs the on-disk transcript
 * (via `startConversationSession`) so externally-added turns appear.
 */
export async function restartConversationSession(convId: string): Promise<string> {
  await stopConversationSession(convId);
  return startConversationSession(convId);
}

// Conversations whose on-disk transcript has already been replayed this run.
const historyLoaded = new Set<string>();

/**
 * Re-derive a conversation's active worktree from its transcript and restore it as
 * `liveCwd`, so the editor (and the worktree indicator/badge, which share
 * `effectiveCwd`) root on the RIGHT worktree even out of a live session and after
 * a restart — not the main checkout. `liveCwd` is in-memory only (no SQLite
 * column, no migration); the on-disk transcript is its durable source of truth.
 * Mirrors the live EnterWorktree/ExitWorktree interception in
 * `useGlobalSessionEvents`. A conversation that never touched a worktree (or last
 * did ExitWorktree) yields null → `effectiveCwd` falls back to `conv.cwd`.
 */
function rehydrateWorktreeCwd(convId: string, items: ConversationItem[]): void {
  useConversationsStore.getState().setLiveCwd(convId, worktreeCwdFromTranscript(items));
}

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
  // Distinguish a real failure from "nothing to show": a command-level error
  // (rare — the core itself rarely rejects; a corrupt transcript comes back as an
  // in-band history_error Notice item) is surfaced, an empty history is silent.
  if (res.status !== "ok") {
    console.error("loadSessionHistory failed:", res.error);
    useAppErrors
      .getState()
      .pushError("Impossible de charger l'historique d'une conversation.", res.error);
    return;
  }
  if (res.data.length === 0) return;
  const { ensureSession, applyItem, applyContextFill, markSeen } =
    useConversationStore.getState();
  ensureSession(convId);
  for (const item of res.data) applyItem(convId, item);
  // Root the editor on the worktree this conversation actually lives in, read back
  // from the transcript (its live cwd is in-memory only and lost on restart).
  rehydrateWorktreeCwd(convId, res.data);
  // The replayed transcript ends on a past turn_result, which arms "review". But a
  // historical completion is not a fresh "Claude just finished, go look" — mark it
  // seen so only genuine LIVE completions surface as review.
  markSeen(convId);
  // Seed the context ring from the transcript so it shows immediately on open,
  // before any new live turn reports usage. A missing/unreadable transcript is NOT
  // an error (the core returns an empty fill), so a status "error" here is a real
  // failure worth surfacing rather than swallowing.
  const ctx = await commands.loadSessionContext(conv.sessionId);
  if (ctx.status === "ok")
    // Tokens from the transcript; window from the persisted cache (the only place the
    // real 200k-vs-1M window is known before the first live turn).
    applyContextFill(convId, {
      context_tokens: ctx.data.context_tokens,
      context_window: getCachedWindow(convId),
    });
  else console.error("loadSessionContext failed:", ctx.error);
}

/**
 * Re-read a conversation's on-disk transcript and rebuild its timeline from
 * scratch. Unlike `loadConversationHistory` (additive, once per run), this RESETS
 * the session first, so it picks up turns appended out-of-band — e.g. the same
 * Claude session resumed in a terminal (`claude --resume`). The reset is required
 * for correctness: replaying an assistant message over an existing turn would
 * APPEND its blocks a second time (the reducer merges same-id blocks), duplicating
 * content. A failed or empty read leaves the current timeline untouched. Called
 * when the stream is (re)started from the UI; on a conversation that never sent a
 * message (no session_id) there is nothing to read.
 */
export async function reloadConversationHistory(convId: string): Promise<void> {
  const conv = useConversationsStore.getState().conversations.find((c) => c.id === convId);
  if (!conv?.sessionId) return;
  const res = await commands.loadSessionHistory(conv.sessionId);
  if (res.status !== "ok") {
    console.error("loadSessionHistory (reload) failed:", res.error);
    useAppErrors
      .getState()
      .pushError("Impossible de recharger l'historique d'une conversation.", res.error);
    return; // keep the current timeline
  }
  if (res.data.length === 0) return; // nothing on disk → keep timeline
  const { resetSession, applyItem, applyContextFill, markSeen } =
    useConversationStore.getState();
  resetSession(convId);
  for (const item of res.data) applyItem(convId, item);
  // Re-root the editor on the conversation's actual worktree, re-derived from the
  // freshly re-read transcript (live cwd is in-memory only).
  rehydrateWorktreeCwd(convId, res.data);
  // Replayed history ends on a past turn_result; mark it seen so turning the
  // stream on doesn't flash an old conversation as "review" (only fresh LIVE
  // completions should).
  markSeen(convId);
  // Re-seed the context ring from the transcript (resetSession cleared it); window
  // from the persisted cache (the real 200k-vs-1M value learned on a prior turn).
  const ctx = await commands.loadSessionContext(conv.sessionId);
  if (ctx.status === "ok")
    applyContextFill(convId, {
      context_tokens: ctx.data.context_tokens,
      context_window: getCachedWindow(convId),
    });
  else console.error("loadSessionContext failed:", ctx.error);
  historyLoaded.add(convId); // the select-time loader is now satisfied for this run
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
  // Kill every integrated terminal (PTY shells + xterm instances) before clearing.
  disposeAllTerminals();
  await commands.wipeAllData();
  historyLoaded.clear();
  clearAllCachedWindows();
  clearAllTodoBarOpen();
  clearAllComposerDrafts();
  autoTitlePending.clear();
  titleContext.clear();
  titleGenCount.clear();
  lastAppliedSeq.clear();
  clearMentionCache();
  useConversationsStore.setState({ repos: [], conversations: [], activeId: null });
  useConversationStore.setState({ sessions: {} });
  useBackgroundTasksStore.getState().clear();
  useWorkflowLiveStore.getState().clear();
  useGitViewStore.getState().clearAll();
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

export interface RepoGroup {
  repo: Repo;
  conversations: Conversation[];
}

/**
 * The grouping skeleton shared by the sidebar's recency order and the FlightDeck's
 * status-ordered lanes: bucket conversations under their repo, sort within each
 * repo (`sortConvs`), then order the groups (`sortRepos`). Pure + testable. The two
 * call sites differ ONLY in their comparators, so the grouping and empty-repo
 * handling never drift between them.
 */
export function groupByRepo(
  repos: Repo[],
  conversations: Conversation[],
  sortConvs: (a: Conversation, b: Conversation) => number,
  sortRepos: (a: RepoGroup, b: RepoGroup) => number,
): RepoGroup[] {
  const byRepo = new Map<string, Conversation[]>();
  for (const c of conversations) {
    const arr = byRepo.get(c.repoId) ?? [];
    arr.push(c);
    byRepo.set(c.repoId, arr);
  }
  for (const arr of byRepo.values()) arr.sort(sortConvs);
  return [...repos]
    .map((repo) => ({ repo, conversations: byRepo.get(repo.id) ?? [] }))
    .sort(sortRepos);
}

/**
 * Group conversations under their repo and order by recency: within a repo the
 * most recently active conversation comes first, and repos are ordered by their
 * most recent conversation (an empty repo falls back to when it was added). The
 * recency-ordered grouping the sidebar shows — the FlightDeck reuses the same
 * skeleton (`groupByRepo`) but orders status-first instead (see `orderLanes`).
 */
export function groupConversationsByRepo(
  repos: Repo[],
  conversations: Conversation[],
): RepoGroup[] {
  // After the recency sort, a group's first conversation is its most recent one.
  const recency = (g: RepoGroup) => g.conversations[0]?.lastActivityAt ?? g.repo.addedAt;
  return groupByRepo(
    repos,
    conversations,
    (a, b) => b.lastActivityAt - a.lastActivityAt,
    (a, b) => recency(b) - recency(a),
  );
}

/** Reactive repo-grouped conversations (recency-ordered). */
export function useConversationsByRepo(): RepoGroup[] {
  const repos = useRepos();
  const conversations = useConversations();
  return useMemo(() => groupConversationsByRepo(repos, conversations), [repos, conversations]);
}

// NOTE: the conversation status model now lives in `src/agent/status.ts`
// (`deriveAgentStatus` + `agentStatusToDot`), consumed via the `useAgentStatus`
// hook. It replaces the old flat `streamStatus(handle, state)` so the sidebar,
// the title-bar control, and the upcoming fleet view share one rich source of
// truth (running / idle / need-input / need-intervention / review / error / off).

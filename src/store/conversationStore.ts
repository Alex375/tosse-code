// The conversation store: a dumb reducer that applies pre-normalized events from
// the Rust core and reconciles them by id. The UI never reconstructs anything —
// it reads slices via fine-grained selectors so only affected turns re-render.
//
// Reconciliation rules (see the protocol):
//  - message_started opens a streaming Turn (blocks=[]) and an openBubble pointer.
//  - text_delta / thinking_delta append to the matching buffer (ignored once final).
//  - assistant_message carries ONE finalized content block of a message; Claude
//    sends a message's blocks as several same-id events (thinking, then text, then
//    tool_use). We APPEND its blocks to the turn and clear the live buffers — never
//    replace — so an earlier block (e.g. the text between two tools) is not wiped
//    by a later one. The turn stays "streaming" until turn_result. Mirrors
//    history.rs, which merges same-id transcript lines on resume.
//  - tool_result is joined to its tool_use lazily by tool_use_id.
//  - turn_result finalizes open bubbles and renders a footer — NEVER a new bubble.
//  - sub-agent (Task) turns carry parent_tool_use_id and are scoped to a sub-thread,
//    never leaking into the root timeline.
//  - all collections dedupe by id / tool_use_id (Tauri delivery is at-least-once).

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type {
  ConversationItem,
  PermissionRequestPayload,
  SessionStatePayload,
} from "../ipc/client";
import type {
  ErrorItem,
  NoticeItem,
  SessionEntry,
  TimelineEntry,
  TodoItem,
  TodoSummary,
  ToolResult,
  Turn,
  TurnResultMeta,
} from "./types";
import { latestTodosInBlocks, todoSummary } from "./todos";

const connectingState: SessionStatePayload = {
  busy: false,
  session_id: null,
  cwd: null,
  model: null,
  permission_mode: null,
  effort: null,
  ultracode: false,
  activity: null,
  awaiting_permission: false,
  ended: false,
  context_tokens: null,
  context_window: null,
  rate_limit: null,
};

function emptyEntry(session: string): SessionEntry {
  return {
    session,
    state: { ...connectingState },
    timeline: [],
    turns: {},
    notices: {},
    errors: {},
    turnResults: {},
    toolResults: {},
    pendingPermissions: [],
    openBubble: {},
    subThreads: {},
    todos: [],
    // No finished turn yet → nothing to review (an idle, never-run session reads
    // as idle/off, not "ready for review").
    turnSeen: true,
    seq: 0,
  };
}

const rootKey = (parentToolUseId: string | null) => parentToolUseId ?? "root";

function hasTimelineId(timeline: TimelineEntry[], id: string): boolean {
  return timeline.some((e) => e.id === id);
}

/** Clear the "en attente" badge on any queued user turns. Cheap to call on every
 *  boundary: bails out with zero allocation when nothing is waiting (the common
 *  case), then rebuilds only the entries that change. */
function clearQueuedBadges(entry: SessionEntry): SessionEntry {
  if (!Object.values(entry.turns).some((t) => t.queued)) return entry;
  const turns = { ...entry.turns };
  for (const [id, t] of Object.entries(turns)) {
    if (t.queued) turns[id] = { ...t, queued: false };
  }
  return { ...entry, turns };
}

interface ConversationState {
  sessions: Record<string, SessionEntry>;
  ensureSession: (session: string) => void;
  applyState: (session: string, state: SessionStatePayload) => void;
  /** Seed the context meter (tokens/window) from the on-disk transcript on open or
   *  stream-(re)start, so the ring shows the real fill BEFORE the first live turn.
   *  Only fills a field that's still null — never clobbers a fresher live value. */
  applyContextFill: (
    session: string,
    fill: { context_tokens: number | null; context_window: number | null },
  ) => void;
  /** Reset a session's live state to neutral (idle, not busy/ended) WITHOUT
   *  touching its timeline. Used when the stream is turned off: the terminal
   *  `ended` event is routed by the now-stale handle and gets dropped, so the
   *  last live state (e.g. busy=true) would otherwise linger and block the
   *  composer. Clears it so the conversation reads as off/idle (a send re-spawns). */
  clearState: (session: string) => void;
  applyItem: (session: string, item: ConversationItem) => void;
  appendText: (session: string, messageId: string, text: string) => void;
  appendThinking: (session: string, messageId: string, text: string) => void;
  /** Append an optimistic user turn. `queued` marks it as sent mid-turn (the CLI
   *  injects it before the loop ends) → drives the "en attente" badge. */
  addUserTurn: (session: string, text: string, queued?: boolean) => void;
  /** Append a visible error bubble to the timeline (e.g. a send that failed to
   *  spawn the session). Makes an otherwise-silent command failure self-evident.
   *  `detail` (optional) is the raw technical payload, shown behind a disclosure. */
  addErrorTurn: (session: string, message: string, detail?: string | null) => void;
  enqueuePermission: (session: string, request: PermissionRequestPayload) => void;
  removePermission: (session: string, requestId: string) => void;
  /** Acknowledge the last finished turn ("Vu" button): mark it seen so the
   *  conversation drops from review / open-question back to idle. */
  markSeen: (session: string) => void;
  resetSession: (session: string) => void;
  /** Forget a session's timeline entirely (e.g. its conversation was deleted). */
  dropSession: (session: string) => void;
}

export const useConversationStore = create<ConversationState>((set) => {
  /** Replace one session immutably; `fn` returns a NEW entry (or the same to skip). */
  const withEntry = (session: string, fn: (entry: SessionEntry) => SessionEntry) =>
    set((s) => {
      const entry = s.sessions[session] ?? emptyEntry(session);
      const next = fn(entry);
      if (next === entry) return s;
      return { sessions: { ...s.sessions, [session]: next } };
    });

  const openTurn = (
    entry: SessionEntry,
    id: string,
    parentToolUseId: string | null,
  ): SessionEntry => {
    if (entry.turns[id]) return entry; // dedupe
    const turn: Turn = {
      id,
      role: "assistant",
      status: "streaming",
      streamingText: "",
      streamingThinking: "",
      blocks: [],
      parentToolUseId,
      hasThinking: false,
    };
    const next: SessionEntry = {
      ...entry,
      turns: { ...entry.turns, [id]: turn },
      openBubble: { ...entry.openBubble, [rootKey(parentToolUseId)]: id },
    };
    if (parentToolUseId === null) {
      next.timeline = hasTimelineId(entry.timeline, id)
        ? entry.timeline
        : [...entry.timeline, { kind: "turn", id }];
    } else {
      const existing = entry.subThreads[parentToolUseId] ?? [];
      next.subThreads = {
        ...entry.subThreads,
        [parentToolUseId]: existing.includes(id) ? existing : [...existing, id],
      };
    }
    return next;
  };

  const appendBuffer = (
    session: string,
    messageId: string,
    field: "streamingText" | "streamingThinking",
    text: string,
  ) =>
    withEntry(session, (entry) => {
      let turn = entry.turns[messageId];
      let base = entry;
      if (!turn) {
        // Defensive: a delta before its message_started — open the turn.
        base = openTurn(entry, messageId, null);
        turn = base.turns[messageId];
      }
      if (turn.status !== "streaming") return entry; // finalized: ignore late deltas
      const nextTurn: Turn = {
        ...turn,
        [field]: turn[field] + text,
        hasThinking: field === "streamingThinking" ? true : turn.hasThinking,
      };
      return { ...base, turns: { ...base.turns, [messageId]: nextTurn } };
    });

  return {
    sessions: {},

    ensureSession: (session) =>
      set((s) =>
        s.sessions[session]
          ? s
          : { sessions: { ...s.sessions, [session]: emptyEntry(session) } },
      ),

    applyState: (session, state) =>
      // Carry forward the context meter + rate-limit snapshot when a state event
      // omits them (null): a freshly-spawned session's first states (system/init,
      // status) carry no usage yet, and would otherwise WIPE a value seeded from the
      // transcript (or set by an earlier message_start) — making the ring flicker
      // full → empty → full at the start of every (re)engaged conversation. The
      // assembler's real (non-null) values always win; only nulls defer to what we
      // already hold.
      withEntry(session, (entry) => ({
        ...entry,
        state: {
          ...state,
          context_tokens: state.context_tokens ?? entry.state.context_tokens,
          context_window: state.context_window ?? entry.state.context_window,
          rate_limit: state.rate_limit ?? entry.state.rate_limit,
        },
      })),

    applyContextFill: (session, fill) =>
      withEntry(session, (entry) => {
        const s = entry.state;
        const tokens = s.context_tokens ?? fill.context_tokens;
        const window = s.context_window ?? fill.context_window;
        if (tokens === s.context_tokens && window === s.context_window) return entry;
        return { ...entry, state: { ...s, context_tokens: tokens, context_window: window } };
      }),

    clearState: (session) =>
      // Also drop any "en attente" badge: the session is being turned off, so the
      // queued message will never be picked up — no message_started/turn_result will
      // arrive to clear it otherwise (the terminal `ended` event is routed by the
      // now-stale handle and dropped).
      withEntry(session, (entry) =>
        clearQueuedBadges({ ...entry, state: { ...connectingState } }),
      ),

    appendText: (session, messageId, text) =>
      appendBuffer(session, messageId, "streamingText", text),

    appendThinking: (session, messageId, text) =>
      appendBuffer(session, messageId, "streamingThinking", text),

    addUserTurn: (session, text, queued) =>
      withEntry(session, (entry) => {
        const id = `user_${entry.seq}`;
        const turn: Turn = {
          id,
          role: "user",
          status: "final",
          streamingText: text,
          streamingThinking: "",
          blocks: [],
          parentToolUseId: null,
          hasThinking: false,
          queued,
        };
        return {
          ...entry,
          seq: entry.seq + 1,
          turns: { ...entry.turns, [id]: turn },
          timeline: [...entry.timeline, { kind: "turn", id }],
          // Sending the next message consumes any pending review/question: the
          // user has clearly moved on from the previous result.
          turnSeen: true,
        };
      }),

    addErrorTurn: (session, message, detail) =>
      withEntry(session, (entry) => {
        const id = `err_${entry.seq}`;
        // An error turn means the send failed (or a respawn fallback): a message
        // that was optimistically flagged "en attente" will never be delivered, so
        // clear its badge instead of leaving it stuck.
        return clearQueuedBadges({
          ...entry,
          seq: entry.seq + 1,
          errors: { ...entry.errors, [id]: { id, message, detail: detail ?? null } },
          timeline: [...entry.timeline, { kind: "error", id }],
        });
      }),

    enqueuePermission: (session, request) =>
      withEntry(session, (entry) =>
        entry.pendingPermissions.some((p) => p.request_id === request.request_id)
          ? entry
          : { ...entry, pendingPermissions: [...entry.pendingPermissions, request] },
      ),

    removePermission: (session, requestId) =>
      withEntry(session, (entry) => {
        if (!entry.pendingPermissions.some((p) => p.request_id === requestId))
          return entry;
        return {
          ...entry,
          pendingPermissions: entry.pendingPermissions.filter(
            (p) => p.request_id !== requestId,
          ),
        };
      }),

    markSeen: (session) =>
      withEntry(session, (entry) =>
        entry.turnSeen ? entry : { ...entry, turnSeen: true },
      ),

    resetSession: (session) =>
      set((s) => ({ sessions: { ...s.sessions, [session]: emptyEntry(session) } })),

    dropSession: (session) =>
      set((s) => {
        if (!s.sessions[session]) return s;
        const next = { ...s.sessions };
        delete next[session];
        return { sessions: next };
      }),

    applyItem: (session, item) =>
      withEntry(session, (entry) => {
        switch (item.kind) {
          case "message_started": {
            const opened = openTurn(entry, item.id, item.parent_tool_use_id);
            // A new ROOT assistant message = the agent's next model call, which is
            // past the boundary where the CLI injects queued messages. So a message
            // that was waiting "en attente" has now been delivered to the agent —
            // clear its badge here (not only at turn_result, the end of the whole
            // loop). Sub-agent (Task) messages don't count: the queued message is
            // injected into the ROOT loop, not the sub-thread.
            return item.parent_tool_use_id === null ? clearQueuedBadges(opened) : opened;
          }

          case "text_delta":
          case "thinking_delta": {
            // Normally deltas come via appendText/appendThinking (rAF-coalesced);
            // handle here too for completeness / out-of-band delivery.
            const field =
              item.kind === "text_delta" ? "streamingText" : "streamingThinking";
            const key = rootKey(null);
            const messageId = item.message_id ?? entry.openBubble[key];
            if (!messageId) return entry;
            const turn = entry.turns[messageId];
            if (!turn || turn.status !== "streaming") return entry;
            const nextTurn: Turn = {
              ...turn,
              [field]: turn[field] + item.text,
              hasThinking:
                field === "streamingThinking" ? true : turn.hasThinking,
            };
            return { ...entry, turns: { ...entry.turns, [messageId]: nextTurn } };
          }

          case "user_message": {
            // A past user turn replayed from the transcript on resume. Mirrors
            // addUserTurn (role "user", text in streamingText), but keyed by the
            // transcript id so re-delivery dedupes.
            if (entry.turns[item.id]) return entry;
            const turn: Turn = {
              id: item.id,
              role: "user",
              status: "final",
              streamingText: item.text,
              streamingThinking: "",
              blocks: [],
              parentToolUseId: item.parent_tool_use_id,
              hasThinking: false,
            };
            return {
              ...entry,
              turns: { ...entry.turns, [item.id]: turn },
              timeline: hasTimelineId(entry.timeline, item.id)
                ? entry.timeline
                : [...entry.timeline, { kind: "turn", id: item.id }],
            };
          }

          case "assistant_message": {
            // Claude delivers one logical message (same id) as SEPARATE events,
            // one per finalized content block (thinking, then text, then tool_use).
            // APPEND the new block(s) to whatever the turn already shows — never
            // replace — otherwise the text rendered between two tools would be
            // overwritten by the following tool_use block and vanish. The live
            // buffers are cleared because the block they were typing is now
            // authoritative in `blocks`. The turn stays "streaming"; turn_result
            // finalizes it. (Resume takes a faster path: history.rs has already
            // merged the same-id lines, so this just appends the one merged event.)
            const base = openTurn(entry, item.id, item.parent_tool_use_id);
            const existing = base.turns[item.id];
            const blocks = [...existing.blocks, ...item.blocks];
            const turn: Turn = {
              ...existing,
              blocks,
              streamingText: "",
              streamingThinking: "",
              hasThinking: blocks.some((b) => b.type === "thinking"),
            };
            const next = { ...base, turns: { ...base.turns, [item.id]: turn } };
            // Capture the agent's to-do list from a TodoWrite tool_use (last
            // write wins). Scoped to the MAIN thread: a sub-agent (Task) keeps
            // its own todos and must not overwrite the conversation-level list.
            if (item.parent_tool_use_id === null) {
              const todos = latestTodosInBlocks(item.blocks);
              if (todos) return { ...next, todos };
            }
            return next;
          }

          case "tool_result": {
            const result: ToolResult = {
              toolUseId: item.tool_use_id,
              content: item.content,
              isError: item.is_error,
              parentToolUseId: item.parent_tool_use_id,
            };
            return {
              ...entry,
              toolResults: { ...entry.toolResults, [item.tool_use_id]: result },
            };
          }

          case "turn_result": {
            const id = `tr_${entry.seq}`;
            const meta: TurnResultMeta = {
              subtype: item.subtype,
              isError: item.is_error,
              result: item.result,
              apiErrorStatus: item.api_error_status ?? null,
              totalCostUsd: item.total_cost_usd,
              numTurns: item.num_turns,
              durationMs: item.duration_ms,
            };
            // finalize any still-streaming turns
            const turns = { ...entry.turns };
            let touched = false;
            for (const [tid, t] of Object.entries(turns)) {
              if (t.status === "streaming") {
                turns[tid] = {
                  ...t,
                  status: item.subtype === "interrupted" ? "interrupted" : "final",
                };
                touched = true;
              }
            }
            // Safety net for the "en attente" badge: normally cleared at the next
            // message_started, but a loop can end (e.g. interrupted) without one, so
            // clear any still-queued user turn now that the loop is over.
            return clearQueuedBadges({
              ...entry,
              seq: entry.seq + 1,
              turns: touched ? turns : entry.turns,
              turnResults: { ...entry.turnResults, [id]: meta },
              timeline: [...entry.timeline, { kind: "turn_result", id }],
              openBubble: {},
              pendingPermissions: [],
              // A turn just finished → it's now "to review", UNLESS it was
              // interrupted (the user did that, so they're already aware).
              turnSeen: item.subtype === "interrupted",
            });
          }

          case "notice": {
            const id = `nt_${entry.seq}`;
            const notice: NoticeItem = {
              id,
              subtype: item.subtype,
              detail: item.detail,
            };
            return {
              ...entry,
              seq: entry.seq + 1,
              notices: { ...entry.notices, [id]: notice },
              timeline: [...entry.timeline, { kind: "notice", id }],
            };
          }

          default:
            // A ConversationItem kind we don't handle (a new core/protocol variant
            // landing before the front catches up). TS has no exhaustiveness guard on
            // this switch, so it would be dropped without a trace — log it instead.
            console.warn("[conversationStore] unhandled ConversationItem kind:", (item as { kind?: string }).kind);
            return entry;
        }
      }),
  };
});

// ---- Fine-grained selector hooks -------------------------------------------

const EMPTY_TIMELINE: TimelineEntry[] = [];
const EMPTY_PERMS: PermissionRequestPayload[] = [];
const EMPTY_IDS: string[] = [];
const EMPTY_TODOS: TodoItem[] = [];

export const useSessionState = (session: string): SessionStatePayload | undefined =>
  useConversationStore((s) => s.sessions[session]?.state);

export const useTimeline = (session: string): TimelineEntry[] =>
  useConversationStore(
    useShallow((s) => s.sessions[session]?.timeline ?? EMPTY_TIMELINE),
  );

export const useTurn = (session: string, id: string): Turn | undefined =>
  useConversationStore((s) => s.sessions[session]?.turns[id]);

export const useToolResult = (
  session: string,
  toolUseId: string,
): ToolResult | undefined =>
  useConversationStore((s) => s.sessions[session]?.toolResults[toolUseId]);

export const useTurnResult = (
  session: string,
  id: string,
): TurnResultMeta | undefined =>
  useConversationStore((s) => s.sessions[session]?.turnResults[id]);

export const useNotice = (session: string, id: string): NoticeItem | undefined =>
  useConversationStore((s) => s.sessions[session]?.notices[id]);

export const useError = (session: string, id: string): ErrorItem | undefined =>
  useConversationStore((s) => s.sessions[session]?.errors[id]);

export const usePendingPermissions = (
  session: string,
): PermissionRequestPayload[] =>
  useConversationStore(
    useShallow((s) => s.sessions[session]?.pendingPermissions ?? EMPTY_PERMS),
  );

export const useSubThread = (
  session: string,
  parentToolUseId: string,
): string[] =>
  useConversationStore(
    useShallow((s) => s.sessions[session]?.subThreads[parentToolUseId] ?? EMPTY_IDS),
  );

/** The conversation's current to-do list (raw items, in agent order). */
export const useTodos = (session: string): TodoItem[] =>
  useConversationStore(
    useShallow((s) => s.sessions[session]?.todos ?? EMPTY_TODOS),
  );

/** Derived progress summary (counts + current item) for the conversation's todos.
 *  Shallow-compared so it only re-renders when the underlying list changes. */
export const useTodoSummary = (session: string): TodoSummary =>
  useConversationStore(
    useShallow((s) => todoSummary(s.sessions[session]?.todos ?? EMPTY_TODOS)),
  );

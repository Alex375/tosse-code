// UI-side derived types. The wire types (ConversationItem, NormalizedBlock, …)
// come from the generated IPC bindings and are re-exported here so feature code
// has a single import surface for "everything conversation-shaped".

import type {
  ConversationItem,
  JsonValue,
  NormalizedBlock,
  PermissionRequestPayload,
  SessionStatePayload,
} from "../ipc/client";

export type {
  ConversationItem,
  JsonValue,
  NormalizedBlock,
  PermissionRequestPayload,
  SessionStatePayload,
};

/** Status of a single agent to-do, mirroring the TodoWrite tool's vocabulary. */
export type TodoStatus = "pending" | "in_progress" | "completed";

/**
 * One agent to-do, captured from a `TodoWrite` tool_use. `activeForm` is the
 * present-tense phrasing some agents emit for the in-progress label; optional
 * because the official client only relies on `content` + `status`.
 */
export interface TodoItem {
  content: string;
  status: TodoStatus;
  activeForm?: string;
}

/**
 * Compact, fully-derived view of a todo list: counts plus the "current" item.
 * Pure-derivable from `TodoItem[]` (see `todoSummary`), so the conversation bar
 * and any other consumer (the multi-agent dashboard) share one definition.
 */
export interface TodoSummary {
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
  /** First `in_progress` item, else first `pending`, else null. */
  current: TodoItem | null;
  allDone: boolean;
}

/** Lifecycle of a single turn as the UI sees it. */
export type TurnStatus = "streaming" | "final" | "interrupted";

export type TurnRole = "assistant" | "user";

/**
 * One rendered turn. Claude streams a single logical message (one `id`) as a
 * sequence of content blocks (thinking, then text, then tool_use, …), each
 * delivered as its OWN `assistant_message` event. We APPEND those blocks into
 * `blocks` as they finalize, while the live text/thinking buffers hold only the
 * block currently being typed. Render = finalized `blocks` followed by the live
 * buffer tail, so nothing already shown is ever overwritten.
 */
export interface Turn {
  id: string;
  role: TurnRole;
  status: TurnStatus;
  /** Live text of the block currently streaming (ignored once status!=="streaming"). */
  streamingText: string;
  /** Live extended-thinking of the block currently streaming. */
  streamingThinking: string;
  /** Authoritative assembled blocks, accumulated in arrival order (starts empty). */
  blocks: NormalizedBlock[];
  /** Non-null => this turn belongs to a sub-agent (Task) sub-thread. */
  parentToolUseId: string | null;
  /** True once a thinking section has been seen, so we can keep it collapsible. */
  hasThinking: boolean;
  /**
   * User turn only: true when the message was sent WHILE the agent was busy, so
   * the CLI queues it and injects it mid-turn rather than starting a fresh turn.
   * Drives the "en attente" badge on the bubble. Cleared once the message has been
   * delivered to the agent — at the next ROOT `message_started` (the model call
   * past the injection boundary), with `turn_result` / stop / send-error as safety
   * nets so the badge can never linger.
   */
  queued?: boolean;
}

/** A tool result, joined to its tool_use by id. */
export interface ToolResult {
  toolUseId: string;
  content: JsonValue;
  isError: boolean;
  parentToolUseId: string | null;
}

/** The footer payload of a finished turn (cost / duration / num_turns). */
export interface TurnResultMeta {
  subtype: string;
  isError: boolean;
  result: JsonValue | null;
  totalCostUsd: number | null;
  numTurns: number | null;
  durationMs: number | null;
}

/** A surfaced system notice (compact boundary, sub-agent lifecycle, …). */
export interface NoticeItem {
  id: string;
  subtype: string;
  detail: JsonValue;
}

/**
 * A local, client-side error surfaced in the timeline — e.g. a message that could
 * not be sent because the `claude` session failed to spawn. Not from the core's
 * event stream: it makes an otherwise-silent command failure visible to the user.
 */
export interface ErrorItem {
  id: string;
  message: string;
}

/**
 * The ordered render stream for a session: turns, notices and turn-footers are all
 * positioned by a single id list so they render in arrival order.
 */
export type TimelineEntry =
  | { kind: "turn"; id: string }
  | { kind: "notice"; id: string }
  | { kind: "turn_result"; id: string }
  | { kind: "error"; id: string };

/** Everything we hold for one live session. */
export interface SessionEntry {
  session: string;
  state: SessionStatePayload;
  timeline: TimelineEntry[];
  turns: Record<string, Turn>;
  notices: Record<string, NoticeItem>;
  /** Client-side error entries (failed sends), keyed by generated id. */
  errors: Record<string, ErrorItem>;
  turnResults: Record<string, TurnResultMeta>;
  /** tool_use_id -> result, joined lazily (core does not pre-link them). */
  toolResults: Record<string, ToolResult>;
  /** Pending permission prompts, queued by request_id (order preserved). */
  pendingPermissions: PermissionRequestPayload[];
  /**
   * Per (parent_tool_use_id|"root") pointer to the currently-open assistant turn,
   * so a text_delta with a null message_id can be attributed correctly.
   */
  openBubble: Record<string, string | undefined>;
  /** Ordered turn ids per sub-agent (Task) thread, keyed by parent_tool_use_id. */
  subThreads: Record<string, string[]>;
  /**
   * tool_use ids of the sub-agents (`Agent`/`Task`) launched DETACHED
   * (`input.run_in_background === true`). Captured once per assistant_message (not
   * re-scanned per token) so the pinned AgentBar reads them in O(1). Detached
   * sub-agents are shown in that bar, not inline in the thread.
   */
  bgAgentIds: string[];
  /**
   * The agent's current to-do list (last `TodoWrite` on the MAIN thread wins; a
   * sub-agent keeps its own and does not clobber this). Empty until the agent
   * writes one. Read via `useTodos` / `useTodoSummary`.
   */
  todos: TodoItem[];
  /**
   * Has the user consumed (replied to / acknowledged) the LAST finished turn?
   * The protocol only says "busy" or "not busy"; it cannot tell "just finished,
   * go look" (→ review) apart from "already seen, dormant" (→ idle) — that
   * distinction is about the USER, not Claude. So we track it ourselves, like an
   * unread badge: set false when a turn finishes (`turn_result`), set true when
   * the user sends the next message or clicks "Vu" (`markSeen`). Drives the
   * review / need-input(open-question) states (see agent/status.ts).
   */
  turnSeen: boolean;
  /** Monotonic counter for generated ids (user turns, notices, turn footers). */
  seq: number;
}

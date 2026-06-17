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
 * The ordered render stream for a session: turns, notices and turn-footers are all
 * positioned by a single id list so they render in arrival order.
 */
export type TimelineEntry =
  | { kind: "turn"; id: string }
  | { kind: "notice"; id: string }
  | { kind: "turn_result"; id: string };

/** Everything we hold for one live session. */
export interface SessionEntry {
  session: string;
  state: SessionStatePayload;
  timeline: TimelineEntry[];
  turns: Record<string, Turn>;
  notices: Record<string, NoticeItem>;
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
  /** Monotonic counter for generated ids (user turns, notices, turn footers). */
  seq: number;
}

// Agent to-do list: the domain layer. Pure, framework-agnostic helpers that turn
// a raw `TodoWrite` tool_use into a typed list and derive a compact summary from
// it. No React, no store — so any surface (the conversation bar, the future
// multi-agent dashboard) can reuse the exact same model and reductions.
//
// Source of truth, confirmed by dissecting the official VS Code extension: todos
// travel ONLY through the `TodoWrite` tool_use; the most recent call replaces the
// whole list. There is no dedicated protocol channel.

import type { JsonValue, NormalizedBlock, TodoItem, TodoStatus, TodoSummary } from "./types";

const STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "completed"];

function asStatus(v: JsonValue | undefined): TodoStatus {
  return typeof v === "string" && (STATUSES as readonly string[]).includes(v)
    ? (v as TodoStatus)
    : "pending";
}

/**
 * Parse a `TodoWrite` tool_use `input` into a todo list.
 *  - returns `null` when the payload carries no `todos` array, so callers can
 *    cheaply skip non-todo writes;
 *  - returns a (possibly empty) list when it does — an explicit empty array is a
 *    deliberate "clear the list", not a no-op.
 * Malformed items (missing `content`, wrong shape) are dropped, never thrown on.
 */
export function parseTodos(input: JsonValue): TodoItem[] | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = (input as Record<string, JsonValue>).todos;
  if (!Array.isArray(raw)) return null;

  const out: TodoItem[] = [];
  for (const it of raw) {
    if (!it || typeof it !== "object" || Array.isArray(it)) continue;
    const o = it as Record<string, JsonValue>;
    const content = typeof o.content === "string" ? o.content : null;
    if (!content) continue;
    const activeForm = typeof o.activeForm === "string" ? o.activeForm : undefined;
    out.push({ content, status: asStatus(o.status), activeForm });
  }
  return out;
}

/**
 * The todos carried by the LAST `TodoWrite` among `blocks`, or `null` if none.
 * Mirrors the official client's "most recent write wins" semantics.
 */
export function latestTodosInBlocks(blocks: NormalizedBlock[]): TodoItem[] | null {
  let todos: TodoItem[] | null = null;
  for (const b of blocks) {
    if (b.type === "tool_use" && b.name === "TodoWrite") {
      const parsed = parseTodos(b.input);
      if (parsed) todos = parsed;
    }
  }
  return todos;
}

const EMPTY_SUMMARY: TodoSummary = {
  total: 0,
  completed: 0,
  inProgress: 0,
  pending: 0,
  current: null,
  allDone: false,
};

/**
 * Derive a compact summary (counts + the "current" item) from a todo list.
 * `current` is the item the agent is actively on — the first `in_progress`, and
 * failing that the first `pending`. Pure, so progress UIs (per-conversation bar,
 * fleet card) share one definition of "what is it doing right now".
 */
export function todoSummary(todos: TodoItem[]): TodoSummary {
  if (todos.length === 0) return EMPTY_SUMMARY;

  let completed = 0;
  let inProgress = 0;
  let pending = 0;
  let firstInProgress: TodoItem | null = null;
  let firstPending: TodoItem | null = null;

  for (const t of todos) {
    if (t.status === "completed") {
      completed++;
    } else if (t.status === "in_progress") {
      inProgress++;
      if (!firstInProgress) firstInProgress = t;
    } else {
      pending++;
      if (!firstPending) firstPending = t;
    }
  }

  return {
    total: todos.length,
    completed,
    inProgress,
    pending,
    current: firstInProgress ?? firstPending ?? null,
    allDone: completed === todos.length,
  };
}

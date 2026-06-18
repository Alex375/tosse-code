import { useEffect, useRef } from "react";
import type { TodoItem, TodoStatus } from "../../store/types";
import { Ico } from "../../ui/kit";

// Maps a todo status to the shared `.cv-check` status-marker modifier
// (filled = done, dashed/spinning = doing, outline = todo). Reuses the design's
// existing plan/checklist marker rather than inventing a new one.
const MARK: Record<TodoStatus, string> = {
  completed: "done",
  in_progress: "doing",
  pending: "todo",
};

/**
 * Pure, presentational to-do list. Data-source agnostic — it takes the items as a
 * prop and renders them, so it can be dropped into the conversation bar today and
 * a multi-agent dashboard card tomorrow without change.
 *
 * Each item shows a status marker + its `content` (matching the official client,
 * which renders `content`, not `activeForm`). Completed items are struck through
 * and dimmed; the in-progress item spins to read as "working".
 *
 * Completion flourish: we remember each row's previous status (by index) and tag
 * only the rows that *just* flipped to completed with `.just-done`, so the pop
 * animation fires on the real transition — never on every render, and never for
 * items that were already done when the list first appeared.
 */
export function TodoList({ todos }: { todos: TodoItem[] }) {
  const prevRef = useRef<TodoStatus[] | null>(null);
  const isFirst = prevRef.current === null;
  const prev = prevRef.current ?? [];

  // Record the statuses *after* paint, so the next render compares against what
  // is currently on screen. A ref (not state) → no extra re-render.
  useEffect(() => {
    prevRef.current = todos.map((t) => t.status);
  });

  return (
    <ul className="cv-todolist">
      {todos.map((t, i) => {
        const justDone =
          !isFirst && t.status === "completed" && prev[i] !== "completed";
        return (
          <li
            key={i}
            className={"cv-todo-i " + t.status + (justDone ? " just-done" : "")}
          >
            <span className={"cv-check " + MARK[t.status]}>
              {t.status === "completed" ? <Ico name="check" className="sm" /> : null}
            </span>
            <span className="cv-todo-t">{t.content}</span>
          </li>
        );
      })}
    </ul>
  );
}

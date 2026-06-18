import { useState } from "react";
import { useTodos, useTodoSummary } from "../../store/conversationStore";
import { Ico } from "../../ui/kit";
import { TodoList } from "./TodoList";

/**
 * The pinned, collapsible to-do panel for one conversation. Mounted between the
 * thread and the composer, so the current plan is always visible without
 * scrolling the message stream.
 *
 * It is the thin "session-bound" wrapper: it resolves the conversation's todos by
 * stable id and delegates the actual rendering to the reusable <TodoList>. When
 * collapsed it still surfaces the count and the current item; it renders nothing
 * until the agent has written a list.
 */
export function TodoBar({ session }: { session: string }) {
  const todos = useTodos(session);
  const summary = useTodoSummary(session);
  const [open, setOpen] = useState(true);

  if (todos.length === 0) return null;

  return (
    <div className="cv-todobar">
      <button
        type="button"
        className="cv-todobar-h"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <Ico name="list" className="sm" />
        <span className="cv-todobar-title">Tâches</span>
        <span className="cv-todobar-count wf-mono">
          {summary.completed}/{summary.total}
        </span>
        <span className="cv-todobar-cur">
          {!open && summary.current ? summary.current.content : ""}
        </span>
        <Ico name="chev" className={"sm cv-todobar-chev" + (open ? " open" : "")} />
      </button>
      {open ? (
        <div className="cv-todobar-b">
          <TodoList todos={todos} />
        </div>
      ) : null}
    </div>
  );
}

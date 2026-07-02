// The card's to-do progress pips, made clickable: the compact bar is a button that
// opens a popover with the full plan — the SAME <TodoList> the conversation view's
// TodoBar renders, so a card and its thread show the plan identically.
//
// Renders nothing until the agent has written a list (summary.total === 0), matching
// the footer's previous guard.

import { useRef, useState } from "react";
import { TodoPips, type TodoSeg } from "../../ui/kit";
import { useTodos, useTodoSummary } from "../../store/conversationStore";
import type { TodoItem } from "../../store/types";
import { TodoList } from "../todos/TodoList";
import { CardPopover } from "./CardPopover";

/** Map a todo's status to its pip colour (grey / amber / green). */
function todoSeg(t: TodoItem): TodoSeg {
  return t.status === "completed" ? "done" : t.status === "in_progress" ? "doing" : "todo";
}

export function TodoPeek({ convId }: { convId: string }) {
  const todos = useTodos(convId);
  const summary = useTodoSummary(convId);
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  if (summary.total === 0) return null;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="ag-todo-btn"
        onClick={() => setOpen((o) => !o)}
        title="Voir la liste des tâches"
      >
        {/* Cap the pip count so a huge plan can't overflow the footer; the
            "done/total" ratio still carries the full number. */}
        <TodoPips segs={todos.slice(0, 20).map(todoSeg)} done={summary.completed} total={summary.total} />
      </button>

      <CardPopover
        anchorRef={btnRef}
        open={open}
        onClose={() => setOpen(false)}
        width={320}
        title="Tâches"
        icon="list"
      >
        <TodoList todos={todos} />
      </CardPopover>
    </>
  );
}

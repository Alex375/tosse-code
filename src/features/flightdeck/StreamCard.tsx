// One stream card. Pure composition over shared, id-keyed selectors — the SAME
// status the sidebar shows (useAgentStatus → agentStatusToDot/rowAttention), the
// same todo summary, context fill and worktree badge. No bespoke data, no fake
// chrome: every element is wired to the live store.
import { Dot, Pill, ContextMeter, TodoPips, Ico, type TodoSeg } from "../../ui/kit";
import { useAgentStatus } from "../../agent/useAgentStatus";
import { agentStatusToDot, rowAttention } from "../../agent/status";
import { effortLabel } from "../../agent/subagentMeta";
import { useTodos, useTodoSummary, useSessionState } from "../../store/conversationStore";
import { useContextData } from "../../store/contextData";
import { WorktreeIndicator } from "../git/WorktreeIndicator";
import type { Conversation } from "../../store/conversationsStore";
import type { TodoItem } from "../../store/types";
import { StateBlock } from "./StateBlock";
import { StateActions } from "./StateActions";
import { BackgroundTaskBadge } from "./BackgroundTaskBadge";

/** Relative "last activity" stamp — "il y a 14 min" / "il y a 2 h". `now` comes from
 *  the grid's shared ticker so idle/off cards advance without a per-card timer. */
function fmtAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 45) return "à l'instant";
  const m = Math.floor(s / 60);
  if (m < 60) return `il y a ${Math.max(1, m)} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.floor(h / 24)} j`;
}

/** Map a todo's status to its pip colour (grey / amber / green). */
function todoSeg(t: TodoItem): TodoSeg {
  return t.status === "completed" ? "done" : t.status === "in_progress" ? "doing" : "todo";
}

export function StreamCard({
  conv,
  repoPath,
  now,
  onOpen,
}: {
  conv: Conversation;
  repoPath: string;
  now: number;
  onOpen: (id: string) => void;
}) {
  const status = useAgentStatus(conv.id);
  const dot = agentStatusToDot(status);
  const attn = rowAttention(status);
  const todos = useTodos(conv.id);
  const summary = useTodoSummary(conv.id);
  const { ctx, ready } = useContextData(conv.id);
  // The agent's live reasoning effort (get_settings read-back) — same data the
  // conversation composer's gauge shows, surfaced read-only on the card. Null until
  // the session has reported settings (never spawned this run → no chip).
  const state = useSessionState(conv.id);
  const effort = effortLabel(state?.effort, state?.ultracode);
  const ultra = !!state?.ultracode;

  const cls =
    "wf-card ag-card" +
    (attn === "input" || attn === "error" ? " att" : "") +
    (attn === "review" ? " rev" : "") +
    (status.kind === "off" ? " dim" : "");

  return (
    <div className={cls}>
      <div className="ag-card-h">
        <Dot s={dot} pulse />
        <button className="ag-card-name" onClick={() => onOpen(conv.id)} title={conv.name}>
          {conv.name}
        </button>
        <Pill s={dot} icon={false} />
      </div>

      <div className="ag-card-tags">
        <WorktreeIndicator conv={conv} repoPath={repoPath} />
        {effort ? (
          <span className={"wf-tag ag-eff" + (ultra ? " ultra" : "")} title={`Effort de réflexion : ${effort}`}>
            <Ico name="bolt" className="sm" />
            {effort}
          </span>
        ) : null}
      </div>

      <StateBlock convId={conv.id} status={status} />

      <div className="ag-card-foot">
        {ready ? <ContextMeter ctx={ctx} /> : null}
        {summary.total > 0 ? (
          // Cap the pip count so a huge plan can't overflow the footer; the
          // "done/total" ratio still carries the full number.
          <TodoPips segs={todos.slice(0, 20).map(todoSeg)} done={summary.completed} total={summary.total} />
        ) : null}
        <BackgroundTaskBadge convId={conv.id} />
        <span className="wf-row" style={{ gap: 5, marginLeft: "auto" }} title="Dernière activité">
          <Ico name="clock" className="sm" />
          {fmtAgo(conv.lastActivityAt, now)}
        </span>
      </div>

      <StateActions convId={conv.id} status={status} />
    </div>
  );
}

// One stream card. Pure composition over shared, id-keyed selectors — the SAME
// status the sidebar shows (useAgentStatus → agentStatusToDot/rowAttention), the
// same todo summary, context fill and worktree badge. No bespoke data, no fake
// chrome: every element is wired to the live store.
import type { MouseEvent as ReactMouseEvent } from "react";
import { Dot, Pill, Ico } from "../../ui/kit";
import { useAgentStatus } from "../../agent/useAgentStatus";
import { agentStatusToDot, backgroundCount, rowAttention } from "../../agent/status";
import { useLastMessageSummary } from "../../store/lastMessageSummary";
import { WorktreeIndicator } from "../git/WorktreeIndicator";
import type { Conversation } from "../../store/conversationsStore";
import { StateBlock } from "./StateBlock";
import { StateActions } from "./StateActions";
import { BackgroundTaskBadge } from "./BackgroundTaskBadge";
import { LastMessagePeek } from "./LastMessagePeek";
import { TodoPeek } from "./TodoPeek";
import { CardEffort } from "./CardEffort";
import { CardContext } from "./CardContext";
import { useFlightdeckModal } from "./flightdeckModalStore";

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
  const openModal = useFlightdeckModal((s) => s.open);
  // A few-word summary of the user's LAST message (live-only, this run). Complements
  // the activity line: it says what YOU last asked, not what the agent is doing now.
  const lastMsg = useLastMessageSummary(conv.id);

  const cls =
    "wf-card ag-card ag-card-clickable" +
    (attn === "input" || attn === "error" ? " att" : "") +
    (attn === "review" ? " rev" : "") +
    (status.kind === "off" ? " dim" : "");

  // Clicking the card BODY opens the conversation in the reply modal — the same as
  // the (now removed) plain "Ouvrir" button. The card TITLE stays the full-screen
  // entry point.
  const onCardClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    // Ignore a click that bubbled from a PORTAL opened within the card (the last-message
    // / to-do peek popovers, the background-tasks popover). React bubbles portal events
    // through the component tree, so a click-away to CLOSE such a popover would otherwise
    // reach here and open the conversation — the portal's target isn't a DOM descendant
    // of the card, so `contains` rejects it.
    if (!e.currentTarget.contains(target)) return;
    // Any interactive child (title, action buttons, worktree/bg badges, the peek
    // triggers — all real <button>s) handles its own click.
    if (target.closest("button, a, input, textarea, select, label")) return;
    // A text selection isn't a click.
    if (!window.getSelection()?.isCollapsed) return;
    openModal(conv.id);
  };

  return (
    <div className={cls} onClick={onCardClick}>
      <div className="ag-card-h">
        <Dot s={dot} pulse ring={backgroundCount(status) > 0} />
        <button className="ag-card-name" onClick={() => onOpen(conv.id)} title={conv.name}>
          {conv.name}
        </button>
        <Pill s={dot} icon={false} />
      </div>

      <div className="ag-card-tags">
        <WorktreeIndicator conv={conv} repoPath={repoPath} />
        {/* Reasoning effort — now a real, clickable slider (the composer's EffortGauge),
            set live per conversation. Renders nothing until an effort is known. */}
        <CardEffort convId={conv.id} />
      </div>

      {lastMsg ? <LastMessagePeek convId={conv.id} summary={lastMsg} /> : null}

      <StateBlock convId={conv.id} status={status} />

      <div className="ag-card-foot">
        {/* Context meter — clickable, opening the same context/usage popover as the
            composer's ContextRing (renders nothing until usage is reported). */}
        <CardContext convId={conv.id} />
        <TodoPeek convId={conv.id} />
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

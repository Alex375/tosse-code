// Discreet, pinned list of the conversation's DETACHED sub-agents (the `Agent` tool
// launched with run_in_background). Deliberately subtle — one slim line per agent,
// echoing the inline sub-agent look — so several running at once never crowd the
// view. A running agent shows the bouncing "thinking" dots (same as the main
// composer's working indicator); a finished one shows a small status dot. Clicking a
// line opens its full transcript in a floating <TranscriptPopover>.
//
// Detached sub-agents are kept OUT of the message thread (the inline card suppresses
// itself for them) and surfaced here instead.

import { useMemo, useState } from "react";
import { useBackgroundAgentIds, useSessionState, useToolResult } from "../../store/conversationStore";
import { useSessionTasks } from "../../store/backgroundTasksStore";
import { useConversationsStore } from "../../store/conversationsStore";
import { fmtDuration, resolveAgentId, shortModel } from "../../agent/subagentMeta";
import { fmtTokens } from "../../store/contextData";
import type { BackgroundTask } from "../../ipc/client";
import { Ico, RunDots } from "../../ui/kit";
import { TranscriptPopover } from "./TranscriptPopover";

export function AgentBar({ session }: { session: string }) {
  const bgIds = useBackgroundAgentIds(session);
  const tasks = useSessionTasks(session);
  // Sub-agents inherit the conversation's effort (not recorded per sub-agent), so the
  // parent's effort is the best available signal — same as the inline card.
  const effort = useSessionState(session)?.effort ?? null;
  const claudeSessionId = useConversationsStore(
    (s) => s.conversations.find((c) => c.id === session)?.sessionId ?? null,
  );
  const [opened, setOpened] = useState<BackgroundTask | null>(null);

  // Only sub-agents still RUNNING in the background — a finished one drops out (its
  // result is already back in the conversation). Reactivating spawns a new task, which
  // reappears here.
  const rows = useMemo(() => {
    const ids = new Set(bgIds);
    return Object.values(tasks)
      .filter(
        (t) =>
          t.kind === "agent" &&
          t.status === "running" &&
          t.tool_use_id != null &&
          ids.has(t.tool_use_id),
      )
      .sort((a, b) => a.task_id.localeCompare(b.task_id));
  }, [bgIds, tasks]);

  // The open transcript is held by VALUE (not looked up in `rows`) so it stays open
  // even once the agent finishes and leaves the bar mid-read. Its id appears in the
  // immediate tool_result ack → drillable during the run.
  const openedResult = useToolResult(session, opened?.tool_use_id ?? "");
  const openedAgentId = opened ? resolveAgentId(opened, openedResult?.content) : null;

  if (rows.length === 0 && !opened) return null;

  return (
    <div className="cv-bgagents">
      {rows.map((t) => {
        const meta = [t.subagent_type, t.model ? shortModel(t.model) : null, effort ? `effort ${effort}` : null]
          .filter(Boolean)
          .join(" · ");
        // Defensive / forward-compatible: the wire's usage roll-up (tokens / tool-calls
        // / duration) only arrives on `task_notification` (terminal), and this bar lists
        // RUNNING agents only — so in practice these are empty here today. Rendered
        // conditionally (zero clutter) so they appear automatically IF a future CLI ever
        // reports mid-run usage. Effort (above) is the meaningful live addition.
        const stats = [
          t.tokens != null ? `${fmtTokens(t.tokens)} tk` : null,
          t.tool_uses != null ? `${t.tool_uses} outils` : null,
          t.duration_ms != null ? fmtDuration(t.duration_ms) : null,
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <button
            key={t.task_id}
            type="button"
            className="cv-bgagent"
            onClick={() => setOpened(t)}
            title="Ouvrir le transcript du sous-agent"
          >
            <RunDots />
            <span className="cv-bgagent-label">{t.label ?? "Sous-agent"}</span>
            {meta ? <span className="cv-bgagent-meta wf-mono">{meta}</span> : null}
            {stats ? <span className="cv-bgagent-stats wf-mono">{stats}</span> : null}
            <Ico name="arrow" className="sm cv-bgagent-go" />
          </button>
        );
      })}

      <TranscriptPopover
        open={!!opened}
        sessionId={claudeSessionId}
        agentId={openedAgentId}
        liveSession={session}
        toolUseId={opened?.tool_use_id ?? null}
        running={opened?.status === "running"}
        label={opened?.label ?? "Sous-agent"}
        subtitle={
          opened
            ? [opened.subagent_type, opened.model ? shortModel(opened.model) : null]
                .filter(Boolean)
                .join(" · ") || undefined
            : undefined
        }
        onClose={() => setOpened(null)}
      />
    </div>
  );
}

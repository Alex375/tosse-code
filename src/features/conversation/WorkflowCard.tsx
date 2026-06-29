// The PERSISTENT inline card for a `Workflow` tool call, rendered in the conversation thread
// where the agent launched it (its own segment — never grouped, never hidden). Unlike the
// transient <WorkflowBar> (running-only), this card stays in the thread after the run ends,
// so the rich post-run report is always reachable — and, since the Workflow tool_use is in the
// persisted transcript and the manifest is on disk, it survives a resume too.
//
// Clicking it opens the full <WorkflowDetail> (live overview while running → rich 3-panel
// report once finished). The run id is parsed from the Workflow tool_result ack; the live
// status/phase from the background task; the per-phase agent activity from the accumulated wire.

import { useState } from "react";
import type { JsonValue } from "../../ipc/client";
import { field } from "../../agent/ask";
import { runIdFromResult, taskStatusDot } from "../../agent/subagentMeta";
import { useTaskByToolUse } from "../../store/backgroundTasksStore";
import { useToolResult } from "../../store/conversationStore";
import { useConversationsStore } from "../../store/conversationsStore";
import { useWorkflowLive } from "../../store/workflowLive";
import { Dot, Ico, RunDots } from "../../ui/kit";
import { WorkflowDetail } from "./WorkflowDetail";

export function WorkflowCard({
  session,
  toolUseId,
  input,
}: {
  session: string;
  toolUseId: string;
  input: JsonValue;
}) {
  const task = useTaskByToolUse(session, toolUseId);
  const result = useToolResult(session, toolUseId);
  const claudeSessionId = useConversationsStore(
    (s) => s.conversations.find((c) => c.id === session)?.sessionId ?? null,
  );
  const liveActivity = useWorkflowLive(session, task?.task_id ?? "");
  const [open, setOpen] = useState(false);

  const name = field(input, "description") ?? task?.label ?? "Workflow";
  const runId = runIdFromResult(result?.content);
  const running = task?.status === "running";
  // Current phase (running) from the wire's "<phase>: <label>".
  const phase = running && task?.progress ? task.progress.split(":")[0]?.trim() : null;

  return (
    <div className="cv-tool">
      <div
        className="cv-tool-h"
        onClick={() => setOpen(true)}
        role="button"
        style={{ cursor: "pointer" }}
        title="Ouvrir le détail du workflow"
      >
        <Ico name="layers" className="sm" />
        <span className="cv-tool-t">Workflow</span>
        <span className="cv-tool-m" title={name}>
          {name}
          {phase ? ` · ${phase}` : null}
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, marginLeft: "auto" }}>
          {running ? <RunDots /> : <Dot s={taskStatusDot(task?.status ?? "completed")} />}
          <Ico name="arrow" className="sm" />
        </span>
      </div>

      <WorkflowDetail
        open={open}
        sessionId={claudeSessionId}
        runId={runId}
        running={running}
        workflowName={name}
        currentProgress={task?.progress ?? null}
        liveActivity={liveActivity}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}

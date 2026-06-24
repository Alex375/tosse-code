// Discreet, pinned list of the conversation's RUNNING background shell commands —
// `Bash` launched with `run_in_background`. The shell counterpart of <AgentBar>: one
// slim line per command, echoing the same look so the two bars read as a family. Each
// row shows the bouncing "working" dots and a Stop button. A command drops out of the
// bar the moment it finishes (mirrors AgentBar) — but if its output popover is open at
// that point, the popover stays open and shows the final output (it reads the full task
// map, which keeps the finished snapshot, not the filtered bar list).
//
// Clicking a row opens the command's captured output (tail of `tasks/<id>.output`) in a
// floating <BashOutputPopover>.

import { useState } from "react";
import { useBackgroundBashTasks, useSessionTasks } from "../../store/backgroundTasksStore";
import { useConversationsStore } from "../../store/conversationsStore";
import { useStopTask } from "../../ipc/useCommands";
import { Ico } from "../../ui/kit";
import { BashOutputPopover } from "./BashOutputPopover";

/** The three bouncing dots — the same "working" motif as the main thread indicator
 *  and AgentBar, so a running command reads identically across the UI. */
function RunDots() {
  return (
    <span className="cv-bgrun" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

export function BashBar({ session }: { session: string }) {
  // The bar lists only RUNNING commands; a finished one drops out.
  const rows = useBackgroundBashTasks(session);
  // The full task map (running + finished) — so an open popover survives its command
  // finishing (the row is gone from `rows`, but the snapshot lingers here).
  const allTasks = useSessionTasks(session);
  const claudeSessionId = useConversationsStore(
    (s) => s.conversations.find((c) => c.id === session)?.sessionId ?? null,
  );
  const stopTask = useStopTask(session);
  const [openedId, setOpenedId] = useState<string | null>(null);

  const opened = openedId ? allTasks[openedId] ?? null : null;

  if (rows.length === 0 && !opened) return null;

  return (
    <div className="cv-bgagents">
      {rows.map((t) => (
        <div key={t.task_id} className="cv-bashrow">
          <button
            type="button"
            className="cv-bashrow-main"
            onClick={() => setOpenedId(t.task_id)}
            title="Voir la sortie de la commande"
          >
            <RunDots />
            <span className="cv-bashrow-cmd wf-mono">
              <span className="cv-bashrow-p" aria-hidden="true">$</span>
              {t.label ?? "commande"}
            </span>
          </button>
          <button
            type="button"
            className="cv-bgstop"
            title="Arrêter la commande"
            aria-label="Arrêter la commande"
            onClick={() => stopTask.mutate(t.task_id)}
          >
            <Ico name="stopc" className="sm" />
          </button>
        </div>
      ))}

      <BashOutputPopover
        open={!!opened}
        sessionId={claudeSessionId}
        taskId={opened?.task_id ?? null}
        command={opened?.label ?? "commande"}
        running={opened?.status === "running"}
        summary={opened?.summary ?? null}
        onClose={() => setOpenedId(null)}
      />
    </div>
  );
}

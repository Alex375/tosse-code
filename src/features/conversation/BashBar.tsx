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
import { useStopTask } from "../../ipc/useCommands";
import { Ico, RunDots } from "../../ui/kit";
import { useIsCodex } from "./ConvMark";
import { BashOutputPopover } from "./BashOutputPopover";

export function BashBar({ session }: { session: string }) {
  // Bloc A (Phase 4.5): background shells are a Claude-only primitive — Codex has no
  // model-facing background terminal (a "backgrounded" Codex command completes within the
  // turn; the detached OS process is invisible to the protocol). So on Codex this bar has
  // no source and is hidden, never a fake empty shell.
  const isCodex = useIsCodex(session);
  // The bar lists only RUNNING commands; a finished one drops out.
  const rows = useBackgroundBashTasks(session);
  // The full task map (running + finished) — so an open popover survives its command
  // finishing (the row is gone from `rows`, but the snapshot lingers here).
  const allTasks = useSessionTasks(session);
  const stopTask = useStopTask(session);
  const [openedId, setOpenedId] = useState<string | null>(null);

  const opened = openedId ? allTasks[openedId] ?? null : null;

  if (isCodex) return null;
  if (rows.length === 0 && !opened) return null;

  return (
    <div className="cv-bgagents">
      {rows.map((t) => (
        <div key={t.task_id} className="cv-bashrow">
          <button
            type="button"
            className="cv-bashrow-main"
            onClick={() => setOpenedId(t.task_id)}
            title="View command output"
          >
            <RunDots />
            {t.label ? (
              // The NAME the agent gave the command ("build the app") — prose, the
              // meaningful line. The raw command is in the popover.
              <span className="cv-bashrow-cmd">{t.label}</span>
            ) : (
              // No name → fall back to the raw `$ command` (mono), better than a generic
              // "command".
              <span className="cv-bashrow-cmd wf-mono">
                <span className="cv-bashrow-p" aria-hidden="true">$</span>
                {t.command ?? "command"}
              </span>
            )}
          </button>
          <button
            type="button"
            className="cv-bgstop"
            title="Stop command"
            aria-label="Stop command"
            onClick={() => stopTask.mutate(t.task_id)}
          >
            <Ico name="stopc" className="sm" />
          </button>
        </div>
      ))}

      <BashOutputPopover
        open={!!opened}
        outputFile={opened?.output_file ?? null}
        name={opened?.label ?? null}
        command={opened?.command ?? null}
        running={opened?.status === "running"}
        summary={opened?.summary ?? null}
        onClose={() => setOpenedId(null)}
      />
    </div>
  );
}

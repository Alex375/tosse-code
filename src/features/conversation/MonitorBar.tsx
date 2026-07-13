// Discreet, pinned list of the conversation's RUNNING live watches — the `Monitor` tool,
// whose every stdout line is an event. The watch counterpart of <BashBar> / <AgentBar>:
// one slim line per watcher, echoing the same family look, but marked with an accent
// "pulse" glyph and a "watch" tag so a continuous stream reads distinctly from a one-shot
// "$ command" Bash row. Each row shows the bouncing "working" dots and a Stop button. A
// watcher drops out of the bar the moment its stream ends (mirrors BashBar) — but if its
// event-stream popover is open at that point, the popover stays open and shows the final
// stream (it reads the full task map, which keeps the finished snapshot).
//
// Clicking a row opens the watch's event stream (tail of `tasks/<id>.output`) in a
// floating <TaskOutputPopover>. The Monitor's event stream is NOT on the wire — it is
// written line-by-line to disk and tailed here, exactly like a background Bash's output.

import { useState } from "react";
import { useBackgroundMonitorTasks, useSessionTasks } from "../../store/backgroundTasksStore";
import { useStopTask } from "../../ipc/useCommands";
import { Ico, RunDots } from "../../ui/kit";
import { useIsCodex } from "./ConvMark";
import { TaskOutputPopover } from "./TaskOutputPopover";

export function MonitorBar({ session }: { session: string }) {
  // Bloc A (Phase 4.5): `Monitor` is a Claude-only background tool — Codex has no
  // equivalent, so this bar is hidden on Codex (never a fake empty shell / false green).
  const isCodex = useIsCodex(session);
  // The bar lists only RUNNING watches; a finished one drops out.
  const rows = useBackgroundMonitorTasks(session);
  // The full task map (running + finished) — so an open popover survives its watch ending
  // (the row is gone from `rows`, but the snapshot lingers here).
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
            title="Voir le flux d'événements de la surveillance"
          >
            <RunDots />
            <Ico name="pulse" className="sm cv-monrow-ico" />
            <span className="cv-bashrow-cmd">{t.label ?? "surveillance"}</span>
            <span className="cv-monrow-tag">surveillance</span>
          </button>
          <button
            type="button"
            className="cv-bgstop"
            title="Arrêter la surveillance"
            aria-label="Arrêter la surveillance"
            onClick={() => stopTask.mutate(t.task_id)}
          >
            <Ico name="stopc" className="sm" />
          </button>
        </div>
      ))}

      <TaskOutputPopover
        open={!!opened}
        outputFile={opened?.output_file ?? null}
        running={opened?.status === "running"}
        icon="pulse"
        title={opened?.label ?? "surveillance"}
        subtitle={
          opened?.status === "running" ? "Surveillance active…" : opened?.summary ?? "Surveillance terminée"
        }
        loadingText="Chargement du flux d'événements…"
        unreadableText={(e) => `Flux illisible : ${e}`}
        unavailableText="Flux indisponible (conversation rouverte)."
        emptyRunningText="La surveillance tourne — aucun événement pour l'instant…"
        emptyDoneText="Aucun événement capté."
        unloadedText="Flux indisponible (impossible de le charger)."
        onClose={() => setOpenedId(null)}
      />
    </div>
  );
}

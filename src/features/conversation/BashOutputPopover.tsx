// A floating viewer for a background Bash command's captured output
// (`tasks/<task_id>.output`), opened from the pinned <BashBar>. A thin Bash-flavoured
// wrapper over the shared <TaskOutputPopover> (the live tailing engine) — it only injects
// the command-shell wording.

import { TaskOutputPopover } from "./TaskOutputPopover";

export function BashOutputPopover({
  open,
  sessionId,
  taskId,
  command,
  running,
  summary,
  onClose,
}: {
  open: boolean;
  /** Claude's own session_id (durable) — the key for the on-disk output file. */
  sessionId: string | null;
  /** The background task's id; null when it can't be resolved (resumed conversation). */
  taskId: string | null;
  /** The shell command (shown in the header). */
  command: string;
  /** Whether the command is still running — drives the live polling + a status line. */
  running: boolean;
  /** End-of-run summary from the core (e.g. "… completed (exit code 0)"). */
  summary?: string | null;
  onClose: () => void;
}) {
  return (
    <TaskOutputPopover
      open={open}
      sessionId={sessionId}
      taskId={taskId}
      running={running}
      icon="term"
      title={<>$ {command}</>}
      titleMono
      subtitle={running ? "En cours…" : summary ?? "Terminé"}
      loadingText="Chargement de la sortie…"
      unreadableText={(e) => `Sortie illisible : ${e}`}
      unavailableText="Sortie indisponible (conversation rouverte)."
      emptyRunningText="La commande tourne — aucune sortie pour l'instant…"
      emptyDoneText="Cette commande n'a produit aucune sortie."
      onClose={onClose}
    />
  );
}

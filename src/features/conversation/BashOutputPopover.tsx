// A floating viewer for a background Bash command's captured output (the file at the
// task's `output_file` path), opened from the pinned <BashBar>. A thin Bash-flavoured
// wrapper over the shared <TaskOutputPopover> (the live tailing engine) — it injects the
// command-shell wording, and shows BOTH the name the agent gave the task AND the raw
// shell command (the name says what, the command says how).

import { TaskOutputPopover } from "./TaskOutputPopover";

export function BashOutputPopover({
  open,
  outputFile,
  name,
  command,
  running,
  summary,
  onClose,
}: {
  open: boolean;
  /** ABSOLUTE path of the task's output file (`BackgroundTask.output_file`). */
  outputFile: string | null;
  /** The NAME the agent gave the command (its `description`), or null. */
  name: string | null;
  /** The raw shell command, or null when not captured yet. */
  command: string | null;
  /** Whether the command is still running — drives the live polling + a status line. */
  running: boolean;
  /** End-of-run summary from the core (e.g. "… completed (exit code 0)"). */
  summary?: string | null;
  onClose: () => void;
}) {
  // The name is the heading (it's what makes sense — "build the app"). With no name, the
  // command itself becomes the heading (mono), and we don't repeat it on its own line.
  const named = !!name;
  return (
    <TaskOutputPopover
      open={open}
      outputFile={outputFile}
      running={running}
      icon="term"
      title={named ? name : <>$ {command ?? "commande"}</>}
      titleMono={!named}
      commandLine={named && command ? command : undefined}
      subtitle={running ? "En cours…" : summary ?? "Terminé"}
      loadingText="Chargement de la sortie…"
      unreadableText={(e) => `Sortie illisible : ${e}`}
      unavailableText="Sortie indisponible (conversation rouverte)."
      emptyRunningText="La commande tourne — aucune sortie pour l'instant…"
      emptyDoneText="Cette commande n'a produit aucune sortie."
      unloadedText="Sortie indisponible (impossible de la charger)."
      onClose={onClose}
    />
  );
}

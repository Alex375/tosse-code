// "What is the agent doing right now?" — derived from the live stream, so it
// always says something concrete even when the agent doesn't use TodoWrite. We
// read the most recent main-thread tool_use ("Lit App.tsx", "Exécute pnpm test"),
// fall back to the current to-do, then to "writing"/"thinking". Pure + testable;
// the React selector `useLiveActivity` wraps it. Reusable by the conversation
// thread's working indicator too, not just the FlightDeck card.
import type { JsonValue, SessionEntry } from "./types";
import { todoSummary } from "./todos";
import { field } from "../agent/ask";
import { useConversationStore } from "./conversationStore";

function basename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function truncate(s: string, n: number): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

/** A human phrase for a tool_use in flight: name + its most telling argument. */
export function toolActivityLabel(name: string, input: JsonValue): string {
  const fp = field(input, "file_path");
  const base = fp ? basename(fp) : null;
  switch (name) {
    case "Read":
      return base ? `Lit ${base}` : "Lit un fichier";
    case "Edit":
    case "MultiEdit":
      return base ? `Modifie ${base}` : "Modifie un fichier";
    case "Write":
      return base ? `Écrit ${base}` : "Écrit un fichier";
    case "NotebookEdit": {
      const nb = field(input, "notebook_path");
      return nb ? `Édite ${basename(nb)}` : "Édite un notebook";
    }
    case "Bash": {
      const c = field(input, "command");
      return c ? `Exécute ${truncate(c, 38)}` : "Exécute une commande";
    }
    case "Grep": {
      const p = field(input, "pattern");
      return p ? `Cherche « ${truncate(p, 28)} »` : "Cherche dans le code";
    }
    case "Glob": {
      const p = field(input, "pattern");
      return p ? `Liste ${truncate(p, 28)}` : "Liste des fichiers";
    }
    case "Task": {
      const d = field(input, "description");
      return d ? `Sous-agent : ${truncate(d, 28)}` : "Délègue à un sous-agent";
    }
    case "WebFetch":
      return "Récupère une page web";
    case "WebSearch": {
      const q = field(input, "query");
      return q ? `Recherche « ${truncate(q, 26)} »` : "Recherche sur le web";
    }
    case "TodoWrite":
      return "Met à jour le plan";
    default:
      return `${name}…`;
  }
}

interface ToolUseRef {
  id: string;
  name: string;
  input: JsonValue;
}

/**
 * The tool the agent is running RIGHT NOW: the most-recent UNRESOLVED tool_use of
 * the CURRENT main-thread turn. We stop at the first main turn we hit (scanning
 * newest-first): if it's the user's just-sent message — or an assistant turn with
 * no unresolved tool — nothing is in flight. We never fall through to an older
 * turn, so a finished (or interrupted, result-less) tool from a previous turn can't
 * leak into the next turn's activity line. Scanning the current turn's blocks
 * newest-first also surfaces a slow Read still running when a later parallel tool
 * (batched in the same message) already returned.
 */
function lastInFlightMainToolUse(entry: SessionEntry): ToolUseRef | null {
  for (let i = entry.timeline.length - 1; i >= 0; i--) {
    const e = entry.timeline[i];
    if (e.kind !== "turn") continue;
    const turn = entry.turns[e.id];
    if (!turn || turn.parentToolUseId !== null) continue; // skip sub-agent turns
    // The latest MAIN turn. If it's the user's message, the agent hasn't acted yet.
    if (turn.role !== "assistant") return null;
    for (let b = turn.blocks.length - 1; b >= 0; b--) {
      const blk = turn.blocks[b];
      if (blk.type === "tool_use" && !entry.toolResults[blk.id])
        return { id: blk.id, name: blk.name, input: blk.input };
    }
    return null; // current turn has nothing in flight — don't look at older turns
  }
  return null;
}

/** Is a main-thread assistant turn currently streaming visible text? */
function isStreamingText(entry: SessionEntry): boolean {
  for (const id in entry.turns) {
    const t = entry.turns[id];
    if (
      t.role === "assistant" &&
      t.parentToolUseId === null &&
      t.status === "streaming" &&
      t.streamingText.trim() !== ""
    )
      return true;
  }
  return false;
}

/**
 * A live, human "what's happening now" line. Priority: a tool currently in flight
 * (the most concrete signal) → the current to-do's active phrasing → writing a
 * reply → the last tool run → thinking. Never the raw protocol hint ("requesting").
 */
export function describeActivity(entry: SessionEntry | undefined): string {
  if (!entry) return "Travaille…";

  // The tool the agent is running right now (current turn, still unresolved).
  const tool = lastInFlightMainToolUse(entry);
  if (tool) return toolActivityLabel(tool.name, tool.input);

  const current = todoSummary(entry.todos).current;
  if (current?.activeForm) return current.activeForm;

  if (isStreamingText(entry)) return "Rédige une réponse…";

  return "Réfléchit…";
}

/** Reactive "what's happening now" for a conversation (by stable id). */
export function useLiveActivity(convId: string): string {
  return useConversationStore((s) => describeActivity(s.sessions[convId]));
}

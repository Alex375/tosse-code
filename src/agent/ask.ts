// Shared classification of a pending permission request into the human "ask" the
// UI shows — the real question / command / file behind a `can_use_tool` prompt.
// Used by BOTH the conversation thread (AskTurn) and the FlightDeck card's
// StateBlock, so the two render the same prompt from one source of truth. Pure +
// React-free → unit-testable (see ask.test.ts).
import type { JsonValue, PermissionRequestPayload } from "../ipc/client";

export interface Ask {
  kind: "question" | "permission" | "error" | "blocked";
  text?: string;
  /** A shell command to preview (Bash permissions). */
  cmd?: string;
}

/** Read a string field from a tool_use input object (the permission `input`). */
export function field(input: JsonValue, key: string): string | undefined {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const v = (input as Record<string, JsonValue>)[key];
    if (typeof v === "string") return v;
  }
  return undefined;
}

/**
 * Classify a permission request into the ask shown to the user. A Bash request
 * previews its command; an edit/write previews the target file; anything else
 * falls back to the tool name. Note: the `AskUserQuestion` questionnaire is NOT
 * handled here — callers branch on it first (it has its own multi-question UI).
 */
export function classifyAsk(req: PermissionRequestPayload): Ask {
  if (req.tool_name === "Bash") {
    return {
      kind: "permission",
      text: "Allow running the command?",
      cmd: field(req.input, "command"),
    };
  }
  const target = field(req.input, "file_path");
  return {
    kind: "permission",
    text:
      req.description ||
      (target ? `Allow editing ${target}?` : `Allow ${req.tool_name}?`),
  };
}

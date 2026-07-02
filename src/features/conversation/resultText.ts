// Flatten a tool_result content to plain text. Shared by ToolSection (line-count summaries)
// and planStatus (classifying an ExitPlanMode result) so the two never diverge on the wire's
// `content` shape. Framework-free (only a type import) so it stays trivially unit-testable.

import type { JsonValue } from "../../ipc/client";

/** Flatten a tool_result content (a string OR a content-block array) to plain text,
 *  concatenating the `.text` of each text block. Returns null when there is no text (empty
 *  array / non-text content) so callers can distinguish "no textual result". */
export function resultContentText(content: JsonValue): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      if (
        b &&
        typeof b === "object" &&
        !Array.isArray(b) &&
        typeof (b as Record<string, JsonValue>).text === "string"
      )
        parts.push((b as Record<string, JsonValue>).text as string);
    }
    return parts.length ? parts.join("\n") : null;
  }
  return null;
}

import { clsx } from "clsx";
import type { JsonValue } from "../../ipc/client";
import { Expandable } from "../../ui/Expandable";
import styles from "./ToolCard.module.css";

/** Defensive renderer: tool_result content can be string | array | object | null. */
function contentToText(content: JsonValue): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (typeof content === "number" || typeof content === "boolean")
    return String(content);
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (
          block &&
          typeof block === "object" &&
          !Array.isArray(block) &&
          typeof (block as Record<string, JsonValue>).text === "string"
        ) {
          return (block as Record<string, JsonValue>).text as string;
        }
        return JSON.stringify(block, null, 2);
      })
      .join("\n");
  }
  return JSON.stringify(content, null, 2);
}

/** True when a tool_result carries no textual output (null, empty, or whitespace) —
 *  e.g. a command that printed nothing. Surfaced as a discreet note rather than a
 *  blank box. Pure + exported for unit testing. */
export function isEmptyResult(content: JsonValue): boolean {
  return contentToText(content).trim() === "";
}

export function ToolResultBody({
  content,
  isError,
}: {
  content: JsonValue;
  isError: boolean;
}) {
  // No textual output (the common "command printed nothing" case) → a discreet muted
  // note instead of an empty <pre>. Errors keep their bubble (they carry a message).
  if (!isError && isEmptyResult(content)) {
    return <div className={styles.emptyNote}>Aucune sortie.</div>;
  }
  const text = contentToText(content);
  return (
    <Expandable fadeColor={isError ? "var(--error-bg)" : undefined}>
      <pre className={clsx(styles.pre, isError && styles.errorOutput)}>{text}</pre>
    </Expandable>
  );
}

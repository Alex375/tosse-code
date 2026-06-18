import { clsx } from "clsx";
import type { JsonValue } from "../../ipc/client";
import { Expandable } from "../../ui/Expandable";
import styles from "./ToolCard.module.css";

/** Defensive renderer: tool_result content can be string | array | object | null. */
function contentToText(content: JsonValue): string {
  if (content == null) return "(no output)";
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

export function ToolResultBody({
  content,
  isError,
}: {
  content: JsonValue;
  isError: boolean;
}) {
  const text = contentToText(content);
  return (
    <Expandable fadeColor={isError ? "var(--error-bg)" : undefined}>
      <pre className={clsx(styles.pre, isError && styles.errorOutput)}>{text}</pre>
    </Expandable>
  );
}

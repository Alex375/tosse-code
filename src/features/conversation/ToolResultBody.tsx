import { clsx } from "clsx";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { JsonValue } from "../../ipc/client";
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

/** Caps tall content and reveals a Show more / Show less toggle. */
export function ExpandableOutput({
  children,
  maxHeight = 240,
}: {
  children: ReactNode;
  maxHeight?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setOverflowing(el.scrollHeight > maxHeight + 4);
  }, [children, maxHeight]);

  return (
    <div className={styles.expandable}>
      <div
        ref={ref}
        className={styles.expandableInner}
        style={{ maxHeight: expanded ? undefined : maxHeight }}
      >
        {children}
      </div>
      {overflowing && (
        <button
          type="button"
          className={styles.showMore}
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
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
    <ExpandableOutput>
      <pre className={clsx(styles.pre, isError && styles.errorOutput)}>{text}</pre>
    </ExpandableOutput>
  );
}

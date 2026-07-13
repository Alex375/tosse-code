import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import styles from "./Expandable.module.css";

interface ExpandableProps {
  children: ReactNode;
  /** Collapsed height cap, in px. */
  maxHeight?: number;
  /** Gradient end colour of the bottom fade (defaults to var(--bg-code)). */
  fadeColor?: string;
}

/**
 * Caps tall content at `maxHeight` and, when it overflows, clips it with a
 * bottom fade plus a "Show more / Show less" toggle. Keeps long output (Bash
 * results, fenced code, …) from taking over the conversation while leaving the
 * full content one click away.
 */
export function Expandable({ children, maxHeight = 240, fadeColor }: ExpandableProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setOverflowing(el.scrollHeight > maxHeight + 4);
  }, [children, maxHeight]);

  const clamped = overflowing && !expanded;

  return (
    <div
      className={styles.wrap}
      style={fadeColor ? ({ "--expandable-fade": fadeColor } as CSSProperties) : undefined}
    >
      <div
        ref={ref}
        className={styles.inner}
        style={{ maxHeight: expanded ? undefined : maxHeight }}
      >
        {children}
      </div>
      {clamped && <div className={styles.fade} aria-hidden />}
      {overflowing && (
        <button type="button" className={styles.toggle} onClick={() => setExpanded((e) => !e)}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

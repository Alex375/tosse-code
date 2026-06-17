import { clsx } from "clsx";
import { ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";
import styles from "./Disclosure.module.css";

interface DisclosureProps {
  summary: ReactNode;
  /** Right-aligned slot in the summary row (e.g. a status dot). */
  right?: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  summaryClassName?: string;
  bodyClassName?: string;
  /** Body is mounted lazily: only rendered once opened. */
  children: ReactNode;
}

/**
 * Native <details>/<summary> disclosure with a custom rotating chevron, matching
 * the VS Code chat affordance. The body is mounted lazily (kept out of the tree
 * until first opened) so heavy bodies — diffs, long tool output — cost nothing
 * while collapsed.
 */
export function Disclosure({
  summary,
  right,
  defaultOpen = false,
  className,
  summaryClassName,
  bodyClassName,
  children,
}: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <details
      className={clsx(styles.details, className)}
      open={defaultOpen}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className={clsx(styles.summary, summaryClassName)}>
        <ChevronRight size={14} strokeWidth={2} className={styles.chevron} aria-hidden />
        <span className={styles.summaryMain}>{summary}</span>
        {right != null && <span className={styles.summaryRight}>{right}</span>}
      </summary>
      {open && <div className={clsx(styles.body, bodyClassName)}>{children}</div>}
    </details>
  );
}
